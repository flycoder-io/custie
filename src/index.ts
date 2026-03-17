import { loadConfig } from './config';
import { paths, ensureDirs } from './paths';
import { initAutomations } from './automations';
import { createSlackApp } from './slack/app';
import { registerListeners } from './slack/listeners';
import { SessionStore } from './store/session-store';

export async function startServer(): Promise<void> {
  ensureDirs();

  const config = loadConfig();

  const store = new SessionStore(paths.DB_FILE);

  const app = createSlackApp(config);

  const automations = initAutomations(app, config);
  registerListeners(app, store, config, automations.triggerEngine);

  await app.start();
  console.log('[custie] Server is running (Socket Mode)');

  // Graceful shutdown
  const shutdown = () => {
    console.log('[custie] Shutting down...');
    automations.shutdown();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
