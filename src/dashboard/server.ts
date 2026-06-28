import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { paths } from '../paths';
import { createApiRouter } from './api';

export const DEFAULT_DASHBOARD_PORT = 4747;

/** Where the built SPA lands (`web/dist`), relative to the package root. */
const WEB_DIST = join(paths.PACKAGE_ROOT, 'web', 'dist');

export const DEFAULT_DASHBOARD_HOST = '127.0.0.1';

/** Resolve the first free TCP port at/after `start`, bound to `host`. */
export async function findFreePort(
  start: number,
  host = DEFAULT_DASHBOARD_HOST,
  attempts = 50,
): Promise<number> {
  for (let port = start; port < start + attempts; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, host);
    });
    if (free) return port;
  }
  throw new Error(`No free port found in range ${start}-${start + attempts}`);
}

export interface DashboardServer {
  port: number;
  host: string;
  url: string;
  close: () => void;
}

/**
 * Build and start the dashboard HTTP server. Binds to `host` (loopback by
 * default; pass a LAN/Tailscale IP or `0.0.0.0` to expose it). Mounts the
 * read-only JSON API under `/api` and serves the built SPA (with a catch-all
 * fallback to `index.html` for client-side routing) when `web/dist` exists.
 */
export async function startDashboardServer(
  preferredPort = DEFAULT_DASHBOARD_PORT,
  host = DEFAULT_DASHBOARD_HOST,
): Promise<DashboardServer> {
  const app = new Hono();

  app.route('/api', createApiRouter());

  const hasBuild = existsSync(join(WEB_DIST, 'index.html'));
  if (hasBuild) {
    app.use('/*', serveStatic({ root: 'web/dist' }));
    // SPA fallback: unknown non-API paths return index.html.
    app.get('*', serveStatic({ path: 'web/dist/index.html' }));
  } else {
    app.get('/', (c) =>
      c.text(
        'Dashboard UI not built yet. Run `pnpm --dir web build` (or `pnpm --dir web dev`).\nThe JSON API is live under /api.',
      ),
    );
  }

  const port = await findFreePort(preferredPort, host);

  const server = serve({ fetch: app.fetch, port, hostname: host });

  // For a wildcard bind there's no single browsable address — show loopback.
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return {
    port,
    host,
    url: `http://${displayHost}:${port}`,
    close: () => server.close(),
  };
}
