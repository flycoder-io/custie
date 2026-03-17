import { loadEnvFiles } from '../config';
import { startServer } from '../index';

export async function runStart(): Promise<void> {
  loadEnvFiles();
  await startServer();
}
