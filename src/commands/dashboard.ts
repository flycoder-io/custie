import { spawn } from 'node:child_process';
import { platform } from 'node:os';
import { getProfile } from '../profile';
import {
  DEFAULT_DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  startDashboardServer,
} from '../dashboard/server';

/** Pull `--<name> <value>` (or `--<name>=value`) out of an arg list. */
function flagValue(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(`--${name}=`.length);
  const idx = args.findIndex((a) => a === `--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

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
 * `custie dashboard [--port N] [--host ADDR] [--no-open]` — start the read-only
 * management dashboard and open it in the browser. Binds to 127.0.0.1 by
 * default; pass `--host` a LAN/Tailscale IP (or `0.0.0.0`) to reach it from
 * other devices. Runs until the process is interrupted.
 */
export async function runDashboard(args: string[]): Promise<void> {
  const noOpen = args.includes('--no-open');
  const portFlag = flagValue(args, 'port');
  const preferredPort = portFlag ? Number(portFlag) : DEFAULT_DASHBOARD_PORT;
  const host = flagValue(args, 'host') ?? DEFAULT_DASHBOARD_HOST;
  const exposed = host !== DEFAULT_DASHBOARD_HOST && host !== 'localhost';

  const server = await startDashboardServer(preferredPort, host);
  const profile = getProfile();

  console.log(`\n  Custie dashboard (profile: ${profile})`);
  console.log(`  ${server.url}`);
  if (server.port !== preferredPort) {
    console.log(`  (port ${preferredPort} was busy — using ${server.port})`);
  }
  if (exposed) {
    console.log(
      `\n  Bound to ${host} — reachable from other devices. The dashboard has NO`,
    );
    console.log('  authentication, so only expose it on a trusted network (e.g. Tailscale).');
  }
  console.log('\n  Press Ctrl+C to stop.\n');

  if (!noOpen && !exposed) openBrowser(server.url);

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
