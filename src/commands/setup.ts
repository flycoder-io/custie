import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { input, confirm, select, checkbox } from '@inquirer/prompts';
import { paths, ensureDirs } from '../paths';

// ─── Console helpers ────────────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`\n\x1b[36m>\x1b[0m ${msg}`);
}

function success(msg: string): void {
  console.log(`\x1b[32m+\x1b[0m ${msg}`);
}

function warn(msg: string): void {
  console.log(`\x1b[33m!\x1b[0m ${msg}`);
}

function error(msg: string): void {
  console.error(`\x1b[31mx\x1b[0m ${msg}`);
}

function mask(token: string): string {
  if (!token || token.length < 12) return '****';
  return token.slice(0, 8) + '...' + token.slice(-4);
}

// ─── Manifest helper ────────────────────────────────────────────────────────

function getManifestYaml(botName: string): string {
  const manifestPath = resolve(paths.PACKAGE_ROOT, 'slack-app-manifest.yml');
  const raw = readFileSync(manifestPath, 'utf-8');
  return raw.replace(/name: Custie/g, `name: ${botName}`);
}

// ─── Shared: Step 1 — Personalise ───────────────────────────────────────────

interface PersonaliseResult {
  botName: string;
  botIconUrl: string;
  claudeCwd: string;
}

async function stepPersonalise(): Promise<PersonaliseResult> {
  log('Step 1: Personalise your bot\n');

  const botName = await input({
    message: 'Bot name',
    default: 'Custie',
  });

  const botIconUrl = await input({
    message: 'Bot icon URL (leave blank to use bundled mascot)',
    default: '',
  });

  const claudeCwd = await input({
    message: 'Working directory for Claude sessions',
    default: process.cwd(),
  });

  return { botName, botIconUrl, claudeCwd };
}

// ─── Shared: Step 3 — Access control ────────────────────────────────────────

interface AccessControlResult {
  ownerUserId: string;
  allowedUserIds: string;
  claudeConfigDir: string;
}

interface SlackUser {
  id: string;
  name: string;
  realName: string;
}

async function fetchSlackUsers(botToken: string): Promise<SlackUser[]> {
  const res = await fetch('https://slack.com/api/users.list', {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const data = (await res.json()) as {
    ok: boolean;
    members?: Array<{
      id: string;
      name: string;
      real_name?: string;
      is_bot?: boolean;
      deleted?: boolean;
    }>;
  };
  if (!data.ok || !data.members) return [];
  return data.members
    .filter((m) => !m.is_bot && !m.deleted && m.id !== 'USLACKBOT')
    .map((m) => ({ id: m.id, name: m.name, realName: m.real_name || m.name }));
}

async function stepAccessControl(botToken: string): Promise<AccessControlResult> {
  log('Step 3: Access control\n');

  let users: SlackUser[] = [];
  try {
    users = await fetchSlackUsers(botToken);
  } catch {
    warn('Could not fetch workspace users. Falling back to manual ID entry.');
  }

  let ownerUserId = '';
  let allowedUserIds = '';

  if (users.length > 0) {
    const userChoices = users.map((u) => ({
      value: u.id,
      name: `${u.realName} (@${u.name})`,
    }));

    ownerUserId = await select({
      message: 'Who is the bot owner?',
      choices: [{ value: '', name: '(skip)' }, ...userChoices],
    });

    const allowedChoices = userChoices.filter((c) => c.value !== ownerUserId);
    if (allowedChoices.length > 0) {
      const selected = await checkbox({
        message: 'Who else can use the bot? (space to select, enter to confirm)',
        choices: allowedChoices,
      });
      const allIds = ownerUserId ? [ownerUserId, ...selected] : selected;
      allowedUserIds = allIds.join(',');
    } else {
      allowedUserIds = ownerUserId;
    }
  } else {
    console.log(
      '  \x1b[2mTip: Find your Slack user ID by clicking your profile > ⋯ > Copy member ID\x1b[0m\n',
    );

    ownerUserId = await input({
      message: 'Owner Slack user ID (optional)',
      default: '',
    });

    allowedUserIds = await input({
      message: 'Allowed user IDs, comma-separated (optional)',
      default: ownerUserId || '',
    });
  }

  if (!allowedUserIds) {
    warn(
      'No allowed users set -- the bot runs with --dangerously-skip-permissions, so anyone in the workspace can execute commands. Consider restricting access.',
    );
  }

  const defaultConfigDir = resolve(homedir(), '.claude');
  const claudeConfigDir = await input({
    message: 'Claude config directory',
    default: defaultConfigDir,
  });

  return { ownerUserId, allowedUserIds, claudeConfigDir };
}

// ─── Guided path: Step 2 — Manual token collection ──────────────────────────

interface TokenResult {
  botToken: string;
  appToken: string;
  signingSecret: string;
}

async function stepGuidedTokens(botName: string, botIconUrl: string): Promise<TokenResult> {
  log('Step 2: Create your Slack app\n');

  const manifestYaml = getManifestYaml(botName);

  console.log('  1. Go to https://api.slack.com/apps');
  console.log('     Click \x1b[1m"Create New App"\x1b[0m → \x1b[1m"From an app manifest"\x1b[0m');
  console.log('  2. Select your workspace, switch to \x1b[1mYAML\x1b[0m tab, and paste:\n');
  console.log(`\x1b[2m${manifestYaml}\x1b[0m`);
  console.log('  3. Click \x1b[1mNext\x1b[0m → \x1b[1mCreate\x1b[0m.');
  console.log(
    '  4. Under \x1b[1m"Basic Information"\x1b[0m, scroll to \x1b[1m"Display Information"\x1b[0m.',
  );

  if (botIconUrl) {
    console.log(`     Set the icon URL to: ${botIconUrl}`);
  } else {
    console.log(
      '     Upload the bundled \x1b[1mcustie.png\x1b[0m from the package as your app icon.',
    );
  }

  console.log(
    '  5. Under \x1b[1m"Basic Information"\x1b[0m, copy the \x1b[1mSigning Secret\x1b[0m.',
  );
  console.log(
    '  6. Under \x1b[1m"Basic Information > App-Level Tokens"\x1b[0m, generate a token',
  );
  console.log('     with the \x1b[1mconnections:write\x1b[0m scope.');
  console.log(
    '  7. Under \x1b[1m"OAuth & Permissions"\x1b[0m, install the app and copy the \x1b[1mBot User OAuth Token\x1b[0m.\n',
  );

  const botToken = await input({
    message: 'Bot User OAuth Token (xoxb-...)',
    validate: (val) => val.startsWith('xoxb-') || 'Must start with "xoxb-"',
  });

  const appToken = await input({
    message: 'App-Level Token (xapp-...)',
    validate: (val) => val.startsWith('xapp-') || 'Must start with "xapp-"',
  });

  const signingSecret = await input({
    message: 'Signing Secret',
    validate: (val) => val.trim().length > 0 || 'Value is required',
  });

  return {
    botToken: botToken.trim(),
    appToken: appToken.trim(),
    signingSecret: signingSecret.trim(),
  };
}

// ─── Slack API helpers ───────────────────────────────────────────────────────

async function slackApi(
  endpoint: string,
  token: string,
  cookie: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const form = new FormData();
  form.append('token', token);
  for (const [key, value] of Object.entries(params)) {
    form.append(key, value);
  }
  const res = await fetch(`https://slack.com/api/${endpoint}`, {
    method: 'POST',
    body: form,
    headers: { Cookie: cookie },
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) {
    throw new Error(`Slack API ${endpoint} failed: ${(data.error as string) || JSON.stringify(data)}`);
  }
  return data;
}

// ─── Browser path: Step 2 — Hybrid (API + browser) ─────────────────────────

async function stepBrowserTokens(botName: string): Promise<TokenResult> {
  log('Step 2: Creating Slack app...\n');

  const { chromium } = await import('playwright');

  const manifestJson = JSON.stringify(JSON.parse(
    JSON.stringify({
      display_information: {
        name: botName,
        description: 'Claude Code powered Slack bot',
        background_color: '#1e293b',
      },
      features: {
        app_home: {
          home_tab_enabled: false,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        bot_user: { display_name: botName, always_online: true },
      },
      oauth_config: {
        scopes: {
          bot: [
            'app_mentions:read', 'chat:write', 'channels:history', 'groups:history',
            'im:history', 'im:read', 'im:write', 'reactions:write', 'users:read', 'usergroups:read',
          ],
        },
      },
      settings: {
        event_subscriptions: { bot_events: ['app_mention', 'message.im'] },
        interactivity: { is_enabled: false },
        org_deploy_enabled: false,
        socket_mode_enabled: true,
        token_rotation_enabled: false,
      },
    }),
  ));

  const DEBUG = process.argv.includes('--debug');
  const USER_DATA_DIR = resolve(tmpdir(), 'custie-playwright-profile');

  let context;
  try {
    // Phase 1: Launch browser and get xoxc- session token
    log('Opening browser — a Slack login page will appear.\n');
    console.log('  If you are already logged in, just sit tight.');
    console.log('  If not, please log in to your Slack workspace.\n');

    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = context.pages()[0] || (await context.newPage());

    await page.goto('https://api.slack.com/apps');
    const createBtn = page.locator(
      'a:has-text("Create New App"), button:has-text("Create New App")',
    );
    const isLoggedIn = await createBtn
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (!isLoggedIn) {
      log('Waiting for you to log in... (up to 5 minutes)');
      await createBtn.first().waitFor({ state: 'visible', timeout: 300_000 });
    }
    success('Logged in to Slack.');

    // Extract xoxc- token by navigating to an app page (triggers authenticated API calls)
    log('Reading session token — please do not click anything...');

    let token = '';

    // Click into an existing app to trigger authenticated API calls
    const appLink = page.locator('a[href*="/apps/A"]').first();
    const hasExistingApp = await appLink.isVisible({ timeout: 3000 }).catch(() => false);

    if (hasExistingApp) {
      const tokenPromise = new Promise<string>((resolve) => {
        page.on('request', (req) => {
          if (token) return;
          const postData = req.postData() || '';
          const match = postData.match(/xoxc-[a-f0-9-]+/);
          if (match) {
            token = match[0];
            resolve(token);
          }
        });
      });

      await appLink.click();
      token = await Promise.race([
        tokenPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Timed out waiting for session token')), 15_000),
        ),
      ]);
    } else {
      // No existing apps — extract from script tag after page load
      token = await page.evaluate(() => {
        const scripts = document.querySelectorAll('script');
        for (const s of scripts) {
          const text = s.textContent || '';
          const match = text.match(/xoxc-[a-f0-9-]+/);
          if (match) return match[0];
        }
        return '';
      });
    }

    if (!token) {
      throw new Error('Could not find session token. Please try again.');
    }

    // Extract the d cookie (xoxd-) needed to authenticate API calls
    const cookies = await context.cookies('https://slack.com');
    const dCookie = cookies.find((c) => c.name === 'd');
    if (!dCookie) {
      throw new Error('Could not find session cookie. Please try again.');
    }
    const cookieHeader = `d=${dCookie.value}`;
    success('Session token captured.');

    // Phase 2: Create app via API (automatic — no user action needed)
    log('Creating Slack app — this is automatic, please wait...');
    const createResult = await slackApi('apps.manifest.create', token, cookieHeader, { manifest: manifestJson });
    const credentials = createResult.credentials as {
      signing_secret: string;
      client_id: string;
    };
    const appId = createResult.app_id as string;
    const signingSecret = credentials.signing_secret;
    success(`App created: ${appId}`);
    success(`Signing Secret: ${mask(signingSecret)}`);

    // Phase 3: Create app-level token via API
    log('Creating App-Level Token...');
    const tokenResult = await slackApi('developer.apps.appLevelTokens.create', token, cookieHeader, {
      app_id: appId,
      description: `${botName} socket-mode`,
      scope: 'connections:write',
    });
    const appToken = tokenResult.token as string;
    success(`App-Level Token: ${mask(appToken)}`);

    // Phase 4: Install to workspace (requires user interaction)
    const installUrl = `https://api.slack.com/apps/${appId}/install-on-team`;
    log('Almost done! The browser will now open an install page.\n');
    console.log('  \x1b[1mPlease click "Install to Workspace", then click "Allow".\x1b[0m\n');
    await page.goto(installUrl);

    // Install may open a new tab for OAuth — watch all pages for success
    const installPage = await new Promise<import('playwright').Page>((resolve) => {
      const checkUrl = (p: import('playwright').Page) => {
        if (p.url().includes('install-on-team?success=1')) {
          resolve(p);
        }
      };

      // Watch for new tabs
      context.on('page', (newPage) => {
        newPage.on('load', () => checkUrl(newPage));
      });

      // Also watch URL changes on the current page
      page.on('load', () => checkUrl(page));

      // Check periodically in case we missed the event
      const interval = setInterval(() => {
        for (const p of context.pages()) {
          if (p.url().includes('install-on-team?success=1')) {
            clearInterval(interval);
            resolve(p);
            return;
          }
        }
      }, 1000);

      // Timeout after 2 minutes
      setTimeout(() => {
        clearInterval(interval);
      }, 120_000);
    });

    success('App installed! Extracting Bot Token...');
    console.log('\n  You can now return to the terminal — the browser will close shortly.\n');

    // The success page already shows the bot token, or navigate to OAuth page
    const activePage = installPage;
    const hasToken = await activePage
      .locator('text=Bot User OAuth Token')
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (!hasToken) {
      const oauthPageUrl = `https://api.slack.com/apps/${appId}/oauth`;
      await activePage.goto(oauthPageUrl);
      await activePage.waitForSelector('text=Bot User OAuth Token', { timeout: 10_000 });
    }
    await activePage.waitForTimeout(1000);

    let botToken = '';

    // Try clicking "Show" button first, then extract
    const showBtn = activePage.locator('button:has-text("Show"), a:has-text("Show")').first();
    if (await showBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await showBtn.click();
      await activePage.waitForTimeout(500);
    }
    botToken = await activePage.evaluate(() => {
      const els = [...document.querySelectorAll('input')];
      for (const el of els) {
        if (el.value?.startsWith('xoxb-')) return el.value;
      }
      return '';
    });

    if (!botToken) {
      warn('Could not auto-extract Bot Token.');
      botToken = await input({
        message: 'Paste your Bot User OAuth Token (xoxb-...)',
        validate: (val) => val.startsWith('xoxb-') || 'Must start with "xoxb-"',
      });
    }
    success(`Bot Token: ${mask(botToken)}`);

    if (!DEBUG) {
      await context.close();
    }

    return {
      botToken: botToken.trim(),
      appToken: appToken.trim(),
      signingSecret: signingSecret.trim(),
    };
  } catch (err) {
    error(`Browser setup failed: ${(err as Error).message}`);
    if (DEBUG) console.error(err);

    try {
      const pages = context?.pages();
      if (pages?.[0]) {
        const screenshotPath = resolve(paths.PACKAGE_ROOT, 'setup-error.png');
        await pages[0].screenshot({ path: screenshotPath, fullPage: true });
        warn(`Screenshot saved to: ${screenshotPath}`);
      }
    } catch {
      // ignore screenshot errors
    }

    warn('Falling back to guided setup.\n');
    throw err;
  }
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

interface ConfigValues {
  botToken: string;
  appToken: string;
  signingSecret: string;
  claudeCwd: string;
  claudeConfigDir: string;
  botName: string;
  botIconUrl: string;
  ownerUserId: string;
  allowedUserIds: string;
}

function writeConfigFile(config: ConfigValues): void {
  const envContent = [
    `# Slack Bot Token (xoxb-...)`,
    `SLACK_BOT_TOKEN=${config.botToken}`,
    ``,
    `# Slack App-Level Token for Socket Mode (xapp-...)`,
    `SLACK_APP_TOKEN=${config.appToken}`,
    ``,
    `# Slack Signing Secret`,
    `SLACK_SIGNING_SECRET=${config.signingSecret}`,
    ``,
    `# Default working directory for Claude sessions (optional)`,
    `CLAUDE_CWD=${config.claudeCwd}`,
    ``,
    `# Claude config directory for session storage (optional, e.g. ~/.claude-custie)`,
    `CLAUDE_CONFIG_DIR=${config.claudeConfigDir}`,
    ``,
    `# Bot display name used in system prompt (default: Custie)`,
    `BOT_NAME=${config.botName}`,
    ``,
    `# Bot icon URL (informational -- set manually in Slack app Display Information)`,
    `BOT_ICON_URL=${config.botIconUrl}`,
    ``,
    `# Comma-separated Slack user IDs allowed to interact (empty = everyone)`,
    `# If set, the owner is automatically included -- no need to duplicate`,
    `ALLOWED_USER_IDS=${config.allowedUserIds}`,
    ``,
    `# Owner's Slack user ID -- bot reacts with eyes when owner is mentioned`,
    `# Does not restrict access on its own; only ALLOWED_USER_IDS controls who can use the bot`,
    `OWNER_USER_ID=${config.ownerUserId}`,
    ``,
  ].join('\n');

  writeFileSync(paths.CONFIG_FILE, envContent);
  success(`Config written to ${paths.CONFIG_FILE}`);
}

function printNextSteps(): void {
  log('Setup complete! Next steps:\n');
  console.log('  1. Customise the system prompt (optional):');
  console.log(`     Run \x1b[1mcustie prompt\x1b[0m to edit ${paths.PROMPT_FILE}\n`);
  console.log('  2. Start the bot:');
  console.log('     Run \x1b[1mcustie start\x1b[0m\n');
  console.log('  3. Install as a background service (optional):');
  console.log('     Run \x1b[1mcustie install\x1b[0m\n');
}

function copyDefaultPrompt(botName: string): void {
  if (!existsSync(paths.PROMPT_FILE)) {
    const defaultPrompt = resolve(paths.PACKAGE_ROOT, 'system.default.md');
    if (existsSync(defaultPrompt)) {
      const content = readFileSync(defaultPrompt, 'utf-8').replace(/\{\{botName\}\}/g, botName);
      writeFileSync(paths.PROMPT_FILE, content);
      success(`Default prompt copied to ${paths.PROMPT_FILE}`);
    }
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function runSetup(args: string[]): Promise<void> {
  console.log('\n\x1b[1mCustie Setup\x1b[0m\n');
  ensureDirs();

  try {
    // Reconfigure check
    if (existsSync(paths.CONFIG_FILE)) {
      const reconfigure = await confirm({
        message: `Config already exists at ${paths.CONFIG_FILE}. Reconfigure?`,
        default: false,
      });
      if (!reconfigure) {
        success('Keeping existing config.');
        return;
      }
    }

    // Step 1: Personalise (shared)
    const { botName, botIconUrl, claudeCwd } = await stepPersonalise();

    // Step 2: Choose path and collect tokens
    let hasPlaywright = false;
    try {
      await import('playwright');
      hasPlaywright = true;
    } catch {
      // Playwright not installed
    }

    type SetupMode = 'guided' | 'browser';
    let mode: SetupMode = 'guided';

    if (hasPlaywright) {
      mode = await select({
        message: 'How would you like to create the Slack app?',
        choices: [
          {
            value: 'browser' as SetupMode,
            name: 'Automate with browser — Playwright creates the app and extracts tokens',
          },
          {
            value: 'guided' as SetupMode,
            name: 'Guide me step by step — follow instructions and paste tokens',
          },
        ],
      });
    }

    let tokens: TokenResult;

    if (mode === 'browser') {
      try {
        tokens = await stepBrowserTokens(botName);
      } catch {
        // Browser failed, fall back to guided
        tokens = await stepGuidedTokens(botName, botIconUrl);
      }
    } else {
      tokens = await stepGuidedTokens(botName, botIconUrl);
    }

    // Step 3: Access control (shared)
    const { ownerUserId, allowedUserIds, claudeConfigDir } = await stepAccessControl(tokens.botToken);

    // Write config
    writeConfigFile({
      ...tokens,
      claudeCwd,
      claudeConfigDir,
      botName,
      botIconUrl,
      ownerUserId,
      allowedUserIds,
    });

    copyDefaultPrompt(botName);
    printNextSteps();
  } catch (err) {
    if ((err as Error).name === 'ExitPromptError') {
      console.log('\n');
      warn('Setup cancelled.');
      return;
    }
    throw err;
  }
}
