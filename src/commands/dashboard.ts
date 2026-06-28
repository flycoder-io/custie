import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { getProfile } from '../profile';
import { DEFAULT_DASHBOARD_PORT, startDashboardServer } from '../dashboard/server';

/** Open `url` in the default browser (best-effort; silent on failure). */
function openBrowser(url: string): void {
  const cmd =
    platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* no browser available — the printed URL is enough */
  }
}

/**
 * `custie dashboard [--port N] [--no-open]` — start the read-only management
 * dashboard, bound to 127.0.0.1, and open it in the browser. Runs until the
 * process is interrupted.
 */
export async function runDashboard(args: string[]): Promise<void> {
  const noOpen = args.includes('--no-open');
  const portIdx = args.findIndex((a) => a === '--port' || a === '-P');
  const preferredPort =
    portIdx >= 0 && args[portIdx + 1] ? Number(args[portIdx + 1]) : DEFAULT_DASHBOARD_PORT;

  const server = await startDashboardServer(preferredPort);
  const profile = getProfile();

  console.log(`\n  Custie dashboard (profile: ${profile})`);
  console.log(`  ${server.url}`);
  if (server.port !== preferredPort) {
    console.log(`  (port ${preferredPort} was busy — using ${server.port})`);
  }
  console.log('\n  Press Ctrl+C to stop.\n');

  if (!noOpen) openBrowser(server.url);

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
