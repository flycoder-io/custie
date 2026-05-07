import { lookup } from 'node:dns/promises';

// Structural type instead of importing SocketModeClient — Bolt and the standalone
// @slack/socket-mode package can resolve to two different copies in pnpm's tree.
interface SocketLike {
  on(event: 'connected' | 'disconnected' | 'reconnecting', listener: () => void): unknown;
}

export interface WatchdogOpts {
  socket: SocketLike;
  // If the bot is not in a connected state for this long, exit with non-zero
  // so launchd KeepAlive respawns us. Default 5 minutes.
  unhealthyTimeoutMs?: number;
  // First-ever connection deadline measured from start. Default 5 minutes.
  startupTimeoutMs?: number;
  // Active probe: how often to call auth.test() to detect a frozen socket
  // that emits no events. Default 5 minutes. Set to 0 to disable.
  probeIntervalMs?: number;
  authTest?: () => Promise<unknown>;
  // Action to take when unhealthy. Default: exit(1) unless DNS is broken.
  onUnhealthy?: (reason: string) => void | Promise<void>;
  // Hostname used to detect transient network/DNS outages. When this fails to
  // resolve at unhealthy-time we skip exit and keep waiting, since launchd
  // would just respawn us into the same DNS failure. Default 'slack.com'.
  dnsCheckHost?: string;
}

const ts = () => new Date().toISOString();

async function isDnsBroken(host: string): Promise<boolean> {
  try {
    await lookup(host);
    return false;
  } catch {
    return true;
  }
}

export function startWatchdog(opts: WatchdogOpts): { stop: () => void } {
  const unhealthyTimeoutMs = opts.unhealthyTimeoutMs ?? 5 * 60 * 1000;
  const startupTimeoutMs = opts.startupTimeoutMs ?? 5 * 60 * 1000;
  const probeIntervalMs = opts.probeIntervalMs ?? 5 * 60 * 1000;
  const dnsCheckHost = opts.dnsCheckHost ?? 'slack.com';
  const onUnhealthy =
    opts.onUnhealthy ??
    (async (reason: string) => {
      if (await isDnsBroken(dnsCheckHost)) {
        console.warn(
          `[${ts()}] [watchdog] ${reason} — DNS for ${dnsCheckHost} is unresolved, staying alive and waiting for network`,
        );
        armUnhealthyTimer(reason);
        return;
      }
      console.error(`[${ts()}] [watchdog] UNHEALTHY: ${reason} — exiting for launchd to respawn`);
      process.exit(1);
    });

  let connected = false;
  let unhealthyTimer: NodeJS.Timeout | undefined;
  let probeTimer: NodeJS.Timeout | undefined;

  const armUnhealthyTimer = (reason: string) => {
    if (unhealthyTimer) return;
    unhealthyTimer = setTimeout(() => {
      onUnhealthy(reason);
    }, unhealthyTimeoutMs);
  };

  const clearUnhealthyTimer = () => {
    if (unhealthyTimer) {
      clearTimeout(unhealthyTimer);
      unhealthyTimer = undefined;
    }
  };

  // Startup deadline: if we never reach connected state, give up.
  armUnhealthyTimer(`no successful Slack connection within ${startupTimeoutMs / 1000}s of startup`);

  opts.socket.on('connected', () => {
    connected = true;
    clearUnhealthyTimer();
  });
  opts.socket.on('disconnected', () => {
    connected = false;
    armUnhealthyTimer(`socket has been disconnected for ${unhealthyTimeoutMs / 1000}s`);
  });
  opts.socket.on('reconnecting', () => {
    connected = false;
    armUnhealthyTimer(`socket has been reconnecting for ${unhealthyTimeoutMs / 1000}s`);
  });

  // Active probe — catches the case where the socket layer thinks it's
  // connected but the underlying API/network is broken (e.g. DNS failure
  // affecting only the HTTP API, not the WebSocket).
  if (probeIntervalMs > 0 && opts.authTest) {
    probeTimer = setInterval(async () => {
      if (!connected) return; // disconnect path already armed
      try {
        await opts.authTest!();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        armUnhealthyTimer(`auth.test probe failed: ${msg}`);
      }
    }, probeIntervalMs);
  }

  return {
    stop: () => {
      clearUnhealthyTimer();
      if (probeTimer) clearInterval(probeTimer);
    },
  };
}
