import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { App, SocketModeReceiver } from '@slack/bolt';
import { loadConfig } from './config';
import { paths, ensureDirs } from './paths';
import { initAutomations } from './automations';
import { createSlackApp } from './slack/app';
import { registerListeners } from './slack/listeners';
import { AutomationRunStore } from './store/automation-run-store';
import { SessionStore } from './store/session-store';
import { ReactionStore } from './store/reaction-store';
import { startWatchdog } from './health/watchdog';

// Max time we wait for in-flight Claude subprocesses to finish posting their
// reply during shutdown. launchctl kickstart -k waits ~20s before SIGKILL,
// so keep this comfortably under that.
const DRAIN_TIMEOUT_MS = 15_000;

// Strip reactions left behind by an unclean exit (deploy, crash). Without this,
// a `:claude-spark:` "still thinking" indicator can linger on a message even
// though the bot has stopped working on it long ago.
async function recoverStaleReactions(
  client: App['client'],
  reactionStore: ReactionStore,
): Promise<void> {
  const pending = reactionStore.listAll();
  if (pending.length === 0) return;
  console.log(`[${ts()}] [custie] clearing ${pending.length} stale reaction(s) from previous run`);
  for (const r of pending) {
    try {
      await client.reactions.remove({
        channel: r.channelId,
        timestamp: r.messageTs,
        name: r.name,
      });
    } catch {
      // already gone, message deleted, missing scope — nothing useful to do.
    }
    reactionStore.clearPending(r.channelId, r.messageTs, r.name);
  }
}

const ts = () => new Date().toISOString();

const POWER_POLL_MS = 30_000;

function isOnACPower(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('pmset', ['-g', 'ps'], { timeout: 2000 }, (err, stdout) => {
      if (err) {
        resolve(true);
        return;
      }
      resolve(stdout.includes("'AC Power'"));
    });
  });
}

// Hold a `caffeinate` assertion while on AC power so the Mac doesn't drop the
// Slack Socket Mode connection when it sleeps. Released on battery to avoid
// draining the laptop; reacquired automatically when AC power returns.
// `-w <pid>` makes caffeinate self-exit if the bot dies without running shutdown.
function startCaffeinate(): { stop: () => void } {
  if (process.platform !== 'darwin') return { stop: () => {} };

  let child: ChildProcess | undefined;
  let stopped = false;

  const spawnCaffeinate = () => {
    if (child && !child.killed) return;
    try {
      const c = spawn('caffeinate', ['-is', '-w', String(process.pid)], {
        stdio: 'ignore',
        detached: false,
      });
      c.unref();
      c.on('error', (err) => {
        console.warn(`[${ts()}] [custie] caffeinate failed to start:`, err.message);
      });
      c.on('exit', () => {
        if (child === c) child = undefined;
      });
      console.log(`[${ts()}] [custie] caffeinate holding wake assertion (pid=${c.pid})`);
      child = c;
    } catch (err) {
      console.warn(`[${ts()}] [custie] caffeinate spawn threw:`, (err as Error).message);
    }
  };

  const killCaffeinate = (reason: string) => {
    if (child && !child.killed) {
      child.kill();
      console.log(`[${ts()}] [custie] caffeinate released (${reason})`);
    }
    child = undefined;
  };

  const sync = async () => {
    if (stopped) return;
    const onAC = await isOnACPower();
    if (stopped) return;
    if (onAC) spawnCaffeinate();
    else killCaffeinate('on battery');
  };

  void sync();
  const interval = setInterval(() => void sync(), POWER_POLL_MS);

  return {
    stop: () => {
      stopped = true;
      clearInterval(interval);
      killCaffeinate('shutdown');
    },
  };
}

export async function startServer(): Promise<void> {
  ensureDirs();

  const caffeinate = startCaffeinate();

  const config = loadConfig();

  const store = new SessionStore(paths.DB_FILE);
  const runStore = new AutomationRunStore(paths.DB_FILE);
  const reactionStore = new ReactionStore(paths.DB_FILE);

  const app = createSlackApp(config);

  // Log Socket Mode lifecycle so we can see reconnects after sleep/wake.
  // The host machine isn't always on; without this, stdout stays silent
  // between startup and the next event, making "is it connected?" unanswerable.
  // `app.receiver` is typed private in Bolt, hence the structural cast.
  const socket = (app as unknown as { receiver: SocketModeReceiver }).receiver.client;
  socket.on('connected', () => console.log(`[${ts()}] [custie] socket connected`));
  socket.on('reconnecting', () => console.log(`[${ts()}] [custie] socket reconnecting`));
  socket.on('disconnected', () => console.log(`[${ts()}] [custie] socket disconnected`));

  // Self-healing: if the socket gets stuck in reconnecting/disconnected for too
  // long, or auth.test starts failing, exit so launchd KeepAlive respawns us.
  // This catches the "socket says connected but no events flow" failure mode.
  const watchdog = startWatchdog({
    socket,
    authTest: () => app.client.auth.test(),
  });

  const automations = initAutomations(app, config, runStore);
  const listeners = registerListeners(
    app,
    store,
    reactionStore,
    config,
    automations.triggerEngine,
    automations.mentionTriggerEngine,
  );

  console.log(`[${ts()}] [custie] starting (pid=${process.pid})`);
  await app.start();
  console.log(`[${ts()}] [custie] started — Socket Mode`);

  // Best-effort: clean up reactions left by the previous (unclean) shutdown.
  // Don't block startup if Slack is unreachable.
  recoverStaleReactions(app.client, reactionStore).catch((err) => {
    console.warn(`[${ts()}] [custie] reaction recovery failed:`, (err as Error).message);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const pending = listeners.pendingCount();
    console.log(`[${ts()}] [custie] shutting down (${signal}, ${pending} thread queue(s))`);
    // Let in-flight Claude subprocesses post their reply before we tear down.
    // Without this, a deploy mid-conversation strands the user with no
    // response and a stale :claude-spark: reaction.
    const drained = await listeners.drain(DRAIN_TIMEOUT_MS);
    if (!drained) {
      console.warn(
        `[${ts()}] [custie] drain timed out after ${DRAIN_TIMEOUT_MS}ms — some replies may be lost`,
      );
    }
    watchdog.stop();
    automations.shutdown();
    runStore.close();
    store.close();
    reactionStore.close();
    caffeinate.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
