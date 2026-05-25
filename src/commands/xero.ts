import { spawn, exec } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { loadEnvFiles } from '../config';
import { paths, ensureDirs } from '../paths';
import { XeroTokenStore } from '../store/xero-token-store';

const TOKEN_URL = 'https://identity.xero.com/connect/token';
const AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const CONNECTIONS_URL = 'https://api.xero.com/connections';

const DEFAULT_SCOPES = [
  'offline_access',
  'accounting.transactions',
  'accounting.contacts',
  'accounting.settings',
  'accounting.reports.read',
  'accounting.attachments',
];

const DEFAULT_PORT = 5555;

const USAGE = `
  Usage: custie xero <subcommand>

  Subcommands:
    auth          Run OAuth2 flow to connect a Xero organisation
    status        Show the current Xero connection
    mcp           Launch the Xero MCP server with a freshly-refreshed token
                  (used by Claude Code via 'claude mcp add', not directly)
    disconnect    Remove the stored Xero connection

  Required env (in ~/.config/custie/config.env):
    XERO_CLIENT_ID       From your Xero "Web app" at developer.xero.com
    XERO_CLIENT_SECRET   Same place

  Optional env:
    XERO_SCOPES          Space-separated scopes; defaults to a sensible bundle
    XERO_REDIRECT_PORT   Local OAuth callback port (default: 5555)
`;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface TenantConnection {
  tenantId: string;
  tenantName: string;
  tenantType: string;
}

function getEnvOrThrow(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required env: ${name}. Set it in ${paths.CONFIG_FILE} (or via 'custie config --edit').`,
    );
  }
  return v;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start ""'
        : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`, () => {
    // Best-effort; if it fails the user can copy-paste the URL from stdout.
  });
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
}

async function exchangeCodeForTokens(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(clientId, clientSecret),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(
      `Token refresh failed (${res.status}): ${await res.text()}\n` +
        `Re-run 'custie xero auth' to reconnect.`,
    );
  }
  return (await res.json()) as TokenResponse;
}

async function fetchTenants(accessToken: string): Promise<TenantConnection[]> {
  const res = await fetch(CONNECTIONS_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch tenant connections (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as TenantConnection[];
}

async function runAuthFlow(): Promise<void> {
  loadEnvFiles();
  ensureDirs();

  const clientId = getEnvOrThrow('XERO_CLIENT_ID');
  const clientSecret = getEnvOrThrow('XERO_CLIENT_SECRET');
  const port = parseInt(process.env['XERO_REDIRECT_PORT'] ?? String(DEFAULT_PORT), 10);
  const redirectUri = `http://localhost:${port}/callback`;
  const scopes = (process.env['XERO_SCOPES'] || DEFAULT_SCOPES.join(' ')).trim();
  const state = randomBytes(16).toString('hex');

  const authUrl = new URL(AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', scopes);
  authUrl.searchParams.set('state', state);

  console.log('Starting Xero OAuth flow...');
  console.log(`Redirect URI (must match the one configured at developer.xero.com): ${redirectUri}`);
  console.log(`\nIf the browser does not open, paste this URL:\n  ${authUrl.toString()}\n`);

  const code: string = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404).end();
        return;
      }
      const url = new URL(req.url, `http://localhost:${port}`);
      const c = url.searchParams.get('code');
      const s = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Xero auth error: ${error}`);
        server.close();
        reject(new Error(`Xero auth error: ${error}`));
        return;
      }
      if (s !== state) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('State mismatch.');
        server.close();
        reject(new Error('State mismatch — possible CSRF attempt'));
        return;
      }
      if (!c) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Missing authorisation code.');
        server.close();
        reject(new Error('Missing code in callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        `<!doctype html><html><body style="font-family:system-ui;padding:2rem;max-width:32rem">
           <h2 style="color:#1f9d55">Xero connected to Custie</h2>
           <p>You can close this tab and return to your terminal.</p>
         </body></html>`,
      );
      server.close();
      resolve(c);
    });

    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      openBrowser(authUrl.toString());
    });
  });

  const tokens = await exchangeCodeForTokens(clientId, clientSecret, code, redirectUri);
  const tenants = await fetchTenants(tokens.access_token);
  const tenant = tenants[0];

  const store = new XeroTokenStore(paths.DB_FILE);
  store.saveConnection({
    refreshToken: tokens.refresh_token,
    tenantId: tenant?.tenantId ?? null,
    tenantName: tenant?.tenantName ?? null,
    scopes: tokens.scope,
  });
  store.close();

  console.log('\nConnected to Xero.');
  if (tenant) {
    console.log(`  Tenant:  ${tenant.tenantName} (${tenant.tenantId})`);
    if (tenants.length > 1) {
      console.log(`  Note:    ${tenants.length} tenants authorised; using the first one.`);
    }
  }
  console.log(`  Scopes:  ${tokens.scope}`);

  console.log(`\nNow wire it into Claude Code:`);
  console.log(`  claude mcp add xero --scope user -- custie xero mcp`);
  console.log(`\nThen restart Claude Code (and Custie if running) so the MCP is picked up.`);
}

async function runMcpServer(): Promise<void> {
  loadEnvFiles();
  const clientId = getEnvOrThrow('XERO_CLIENT_ID');
  const clientSecret = getEnvOrThrow('XERO_CLIENT_SECRET');

  const store = new XeroTokenStore(paths.DB_FILE);
  const conn = store.getConnection('default');
  if (!conn) {
    store.close();
    throw new Error("No Xero connection. Run 'custie xero auth' first.");
  }

  const tokens = await refreshAccessToken(clientId, clientSecret, conn.refreshToken);
  store.updateRefreshToken('default', tokens.refresh_token);
  store.close();

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    XERO_CLIENT_BEARER_TOKEN: tokens.access_token,
  };
  if (conn.tenantId) {
    env['XERO_TENANT_ID'] = conn.tenantId;
  }

  const child = spawn('npx', ['-y', '@xeroapi/xero-mcp-server@latest'], {
    stdio: 'inherit',
    env,
  });
  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    console.error('Failed to launch @xeroapi/xero-mcp-server:', err);
    process.exit(1);
  });
}

function runStatus(): void {
  const store = new XeroTokenStore(paths.DB_FILE);
  const conn = store.getConnection('default');
  store.close();
  if (!conn) {
    console.log("No Xero connection. Run 'custie xero auth' to connect.");
    return;
  }
  console.log('Xero connection:');
  console.log(`  Tenant:     ${conn.tenantName ?? '(unknown)'} (${conn.tenantId ?? 'no tenant'})`);
  console.log(`  Scopes:     ${conn.scopes}`);
  console.log(`  Connected:  ${conn.createdAt} (UTC)`);
  console.log(`  Last used:  ${conn.updatedAt} (UTC)`);
}

function runDisconnect(): void {
  const store = new XeroTokenStore(paths.DB_FILE);
  store.deleteConnection('default');
  store.close();
  console.log('Xero connection removed. Run `custie xero auth` to reconnect.');
}

export async function runXeroCmd(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'auth':
      await runAuthFlow();
      return;
    case 'mcp':
      await runMcpServer();
      return;
    case 'status':
      runStatus();
      return;
    case 'disconnect':
      runDisconnect();
      return;
    case undefined:
    case '-h':
    case '--help':
      console.log(USAGE);
      return;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      console.log(USAGE);
      process.exit(1);
  }
}
