import path from 'node:path';
import { loadConfig } from './config.js';
import { createSlackApp } from './slack/app.js';
import { registerListeners } from './slack/listeners.js';
import { SessionStore } from './store/session-store.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const dbPath = path.join(import.meta.dirname, '..', 'custie.db');
  const store = new SessionStore(dbPath);

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

main().catch((err) => {
  console.error('[custie] Fatal error:', err);
  process.exit(1);
});
