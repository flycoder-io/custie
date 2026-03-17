import { loadConfig } from './config';
import { paths, ensureDirs } from './paths';
import { createSlackApp } from './slack/app';
import { registerListeners } from './slack/listeners';
import { SessionStore } from './store/session-store';

export async function startServer(): Promise<void> {
  ensureDirs();

  const config = loadConfig();

  const store = new SessionStore(paths.DB_FILE);

  const app = createSlackApp(config);
  registerListeners(app, store, config);

  await app.start();
  console.log('[custie] Server is running (Socket Mode)');

  // Graceful shutdown
  const shutdown = () => {
    console.log('[custie] Shutting down...');
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
