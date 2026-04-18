import { SocketModeReceiver } from '@slack/bolt';
import { loadConfig } from './config';
import { paths, ensureDirs } from './paths';
import { initAutomations } from './automations';
import { createSlackApp } from './slack/app';
import { registerListeners } from './slack/listeners';
import { SessionStore } from './store/session-store';

const ts = () => new Date().toISOString();

export async function startServer(): Promise<void> {
  ensureDirs();

  const config = loadConfig();

  const store = new SessionStore(paths.DB_FILE);

  const app = createSlackApp(config);

  // Log Socket Mode lifecycle so we can see reconnects after sleep/wake.
  // The host machine isn't always on; without this, stdout stays silent
  // between startup and the next event, making "is it connected?" unanswerable.
  // `app.receiver` is typed private in Bolt, hence the structural cast.
  const socket = (app as unknown as { receiver: SocketModeReceiver }).receiver.client;
  socket.on('connected', () => console.log(`[${ts()}] [custie] socket connected`));
  socket.on('reconnecting', () => console.log(`[${ts()}] [custie] socket reconnecting`));
  socket.on('disconnected', () => console.log(`[${ts()}] [custie] socket disconnected`));

  const automations = initAutomations(app, config);
  registerListeners(app, store, config, automations.triggerEngine);

  console.log(`[${ts()}] [custie] starting (pid=${process.pid})`);
  await app.start();
  console.log(`[${ts()}] [custie] started — Socket Mode`);

  const shutdown = () => {
    console.log(`[${ts()}] [custie] shutting down`);
    automations.shutdown();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
