import { createInterface } from 'node:readline';
import { existsSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
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

// ─── Interactive prompts ────────────────────────────────────────────────────

function createPrompt() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  function ask(question: string): Promise<string> {
    return new Promise((resolve) => rl.question(question, resolve));
  }

  async function promptToken(name: string, prefix: string): Promise<string> {
    while (true) {
      const value = (await ask(`  ${name}: `)).trim();
      if (!value) {
        warn('Value is required.');
        continue;
      }
      if (!value.startsWith(prefix)) {
        warn(`Expected value starting with "${prefix}".`);
        continue;
      }
      return value;
    }
  }

  async function promptRequired(name: string): Promise<string> {
    while (true) {
      const value = (await ask(`  ${name}: `)).trim();
      if (value) return value;
      warn('Value is required.');
    }
  }

  async function promptOptional(
    label: string,
    defaultValue = '',
  ): Promise<string> {
    const defaultStr = defaultValue ? ` (default: ${defaultValue})` : ' (leave blank to skip)';
    const value = (await ask(`  ${label}${defaultStr}: `)).trim();
    return value || defaultValue;
  }

  return { rl, ask, promptToken, promptRequired, promptOptional };
}

// ─── Manual setup (default) ─────────────────────────────────────────────────

async function manualSetup(): Promise<void> {
  const { rl, ask, promptToken, promptRequired, promptOptional } = createPrompt();

  try {
    if (existsSync(paths.CONFIG_FILE)) {
      const answer = await ask(
        `\n  Config already exists at ${paths.CONFIG_FILE}. Reconfigure? (y/N) `,
      );
      if (answer.trim().toLowerCase() !== 'y') {
        success('Keeping existing config.');
        return;
      }
    }

    log("Let's configure your Slack app tokens.");
    console.log(`
  1. Go to https://api.slack.com/apps and create (or select) your app.
     Tip: Use the manifest file for quick setup — see slack-app-manifest.yml
  2. Under "OAuth & Permissions", install the app to your workspace.
     Copy the \x1b[1mBot User OAuth Token\x1b[0m (starts with xoxb-).
  3. Under "Basic Information > App-Level Tokens", create a token with
     the \x1b[1mconnections:write\x1b[0m scope. Copy the token (starts with xapp-).
  4. Under "Basic Information", copy the \x1b[1mSigning Secret\x1b[0m.
  `);

    const botToken = await promptToken('SLACK_BOT_TOKEN', 'xoxb-');
    const appToken = await promptToken('SLACK_APP_TOKEN', 'xapp-');
    const signingSecret = await promptRequired('SLACK_SIGNING_SECRET');

    log('A few more settings to configure...\n');

    const claudeCwd = await promptOptional(
      'CLAUDE_CWD -- working directory for Claude sessions',
      process.cwd(),
    );

    const claudeConfigDir = await promptOptional(
      'CLAUDE_CONFIG_DIR -- Claude config directory (e.g. ~/.claude-custie)',
    );

    const botName = await promptOptional('BOT_NAME -- display name in system prompt', 'Custie');

    console.log(
      `\n  \x1b[2mTip: Find your Slack user ID by clicking your profile > ... > Copy member ID\x1b[0m`,
    );

    const ownerUserId = await promptOptional(
      'OWNER_USER_ID -- your Slack user ID for mention monitoring',
    );

    const defaultAllowed = ownerUserId || '';
    const allowedUserIds = await promptOptional(
      'ALLOWED_USER_IDS -- comma-separated user IDs',
      defaultAllowed,
    );

    if (!allowedUserIds) {
      warn(
        'No ALLOWED_USER_IDS set -- the bot runs with --dangerously-skip-permissions, so anyone in the workspace can execute commands. Consider restricting access.',
      );
    }

    writeConfigFile({
      botToken,
      appToken,
      signingSecret,
      claudeCwd,
      claudeConfigDir,
      botName,
      ownerUserId,
      allowedUserIds,
    });

    // Copy default prompt if not exists
    copyDefaultPrompt();

    printNextSteps();
  } finally {
    rl.close();
  }
}

// ─── Browser setup (--browser) ──────────────────────────────────────────────

async function browserSetup(): Promise<void> {
  const { chromium } = await import('playwright');

  const MANIFEST_PATH = resolve(paths.PACKAGE_ROOT, 'slack-app-manifest.yml');
  if (!existsSync(MANIFEST_PATH)) {
    error(`Manifest not found: ${MANIFEST_PATH}`);
    process.exit(1);
  }
  const manifestYaml = readFileSync(MANIFEST_PATH, 'utf-8');
  success('Manifest loaded from slack-app-manifest.yml');

  const DEBUG = process.argv.includes('--debug');
  const SLOW_MO = DEBUG ? 200 : 50;
  const USER_DATA_DIR = resolve(tmpdir(), 'custie-playwright-profile');

  const { rl, ask, promptOptional } = createPrompt();

  let context;
  try {
    log('Launching browser...');
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      slowMo: SLOW_MO,
      viewport: { width: 1280, height: 900 },
      args: ['--disable-blink-features=AutomationControlled'],
    });
    const page = context.pages()[0] || (await context.newPage());

    // Phase 1: Auth
    log('Opening Slack API dashboard...');
    await page.goto('https://api.slack.com/apps');
    const createBtn = page.locator(
      'a:has-text("Create New App"), button:has-text("Create New App")',
    );
    const isLoggedIn = await createBtn
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false);
    if (!isLoggedIn) {
      log('Please log in to Slack in the browser window. Waiting up to 5 minutes...');
      await createBtn.first().waitFor({ state: 'visible', timeout: 300_000 });
    }
    success('Authenticated with Slack.');

    // Phase 2: Create app from manifest
    log('Creating new Slack App from manifest...');
    await createBtn.first().click();
    await page.waitForTimeout(1000);
    await page
      .locator(
        'button:has-text("From an app manifest"), a:has-text("From an app manifest")',
      )
      .first()
      .click();
    await page.waitForTimeout(1000);
    const nextBtn = page.locator('button:has-text("Next")');
    await nextBtn.first().waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForTimeout(500);
    await nextBtn.first().click();
    await page.waitForTimeout(1500);

    const yamlTab = page.locator('button:has-text("YAML"), [role="tab"]:has-text("YAML")');
    if (await yamlTab.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await yamlTab.first().click();
      await page.waitForTimeout(500);
    }

    const textarea = page.locator('textarea').first();
    const hasTextarea = await textarea.isVisible({ timeout: 2000 }).catch(() => false);
    if (hasTextarea) {
      await textarea.click();
      await page.keyboard.press('Meta+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);
      await textarea.fill(manifestYaml);
    } else {
      const editor = page
        .locator('.CodeMirror, [role="textbox"], [contenteditable="true"]')
        .first();
      await editor.click();
      await page.keyboard.press('Meta+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);
      await page.keyboard.insertText(manifestYaml);
    }
    await page.waitForTimeout(500);
    await nextBtn.first().waitFor({ state: 'visible', timeout: 10_000 });
    await nextBtn.first().click();
    await page.waitForTimeout(1500);
    const createAppBtn = page.locator('button:has-text("Create")');
    await createAppBtn.first().waitFor({ state: 'visible', timeout: 10_000 });
    await createAppBtn.first().click();
    await page.waitForURL('**/apps/A*', { timeout: 30_000 });
    const appUrl = page.url();
    const appId = appUrl.match(/\/apps\/(A[A-Z0-9]+)/)?.[1];
    success(`App created! ID: ${appId}`);

    // Phase 3: Signing secret
    log('Extracting Signing Secret...');
    await page.waitForSelector('text=Signing Secret', { timeout: 10_000 });
    const signingSection = page.locator('text=Signing Secret').locator('..');
    const showBtn = signingSection.locator('button:has-text("Show"), a:has-text("Show")');
    if (await showBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await showBtn.first().click();
      await page.waitForTimeout(500);
    }
    let signingSecret = await signingSection
      .locator('input')
      .first()
      .inputValue()
      .catch(() => '');
    if (!signingSecret) {
      signingSecret = await page.evaluate(() => {
        const labels = [...document.querySelectorAll('*')].filter(
          (el) => el.textContent?.trim() === 'Signing Secret',
        );
        for (const label of labels) {
          const container = label.closest('div');
          if (!container) continue;
          const input = container.querySelector('input') as HTMLInputElement | null;
          if (input?.value) return input.value;
        }
        return '';
      });
    }
    if (!signingSecret) {
      warn('Could not auto-extract Signing Secret. Please copy it from the browser.');
      signingSecret = await ask('  Paste your Signing Secret here: ');
    }
    success(`Signing Secret: ${mask(signingSecret)}`);

    // Phase 4: App-level token
    log('Generating App-Level Token (Socket Mode)...');
    const tokenSection = page.locator('text=App-Level Tokens');
    await tokenSection.first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const generateBtn = page.locator(
      'button:has-text("Generate Token"), a:has-text("Generate Token")',
    );
    await generateBtn.first().click();
    await page.waitForTimeout(1000);
    const nameInput = page.locator(
      'input[placeholder*="oken"], input[placeholder*="name"], input[name*="token"]',
    );
    await nameInput.first().waitFor({ state: 'visible', timeout: 10_000 });
    await nameInput.first().fill('socket-mode');
    await page.waitForTimeout(500);
    const addScopeBtn = page.locator(
      'button:has-text("Add Scope"), a:has-text("Add Scope")',
    );
    await addScopeBtn.first().click();
    await page.waitForTimeout(500);
    await page.locator('text=connections:write').first().click();
    await page.waitForTimeout(500);
    const genBtn = page.locator('button:has-text("Generate")');
    await genBtn.first().click();
    await page.waitForTimeout(2000);
    let appToken = await page.evaluate(() => {
      const els = [...document.querySelectorAll('input, code, span, div')];
      for (const el of els) {
        const val = (el as HTMLInputElement).value || el.textContent || '';
        if (val.trim().startsWith('xapp-')) return val.trim();
      }
      return '';
    });
    if (!appToken) {
      warn('Could not auto-extract App-Level Token. Please copy it from the browser.');
      appToken = await ask('  Paste your App-Level Token (xapp-...): ');
    }
    const doneBtn = page.locator('button:has-text("Done")');
    if (await doneBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await doneBtn.first().click();
      await page.waitForTimeout(500);
    }
    success(`App-Level Token: ${mask(appToken)}`);

    // Phase 5: Install and get bot token
    log('Installing app to workspace...');
    const installLink = page.locator('a:has-text("Install App")');
    if (await installLink.first().isVisible({ timeout: 3000 }).catch(() => false)) {
      await installLink.first().click();
    } else {
      await page.goto(`https://api.slack.com/apps/${appId}/install-on-team`);
    }
    await page.waitForTimeout(1500);
    const installBtn = page.locator(
      'button:has-text("Install to Workspace"), a:has-text("Install to Workspace")',
    );
    await installBtn.first().waitFor({ state: 'visible', timeout: 10_000 });
    await installBtn.first().click();
    await page.waitForTimeout(2000);
    const allowBtn = page.locator('button:has-text("Allow")');
    if (await allowBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
      await allowBtn.first().click();
      await page.waitForTimeout(2000);
    }
    await page.waitForSelector('text=Bot User OAuth Token', { timeout: 15_000 });
    let botToken = await page.evaluate(() => {
      const els = [...document.querySelectorAll('input')];
      for (const el of els) {
        if (el.value?.startsWith('xoxb-')) return el.value;
      }
      return '';
    });
    if (!botToken) {
      const showBotBtn = page
        .locator('button:has-text("Show"), a:has-text("Show")')
        .first();
      if (await showBotBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await showBotBtn.click();
        await page.waitForTimeout(500);
        botToken = await page.evaluate(() => {
          const els = [...document.querySelectorAll('input')];
          for (const el of els) {
            if (el.value?.startsWith('xoxb-')) return el.value;
          }
          return '';
        });
      }
    }
    if (!botToken) {
      warn('Could not auto-extract Bot Token. Please copy it from the browser.');
      botToken = await ask('  Paste your Bot User OAuth Token (xoxb-...): ');
    }
    success(`Bot Token: ${mask(botToken)}`);

    // Phase 6: Additional config and write
    log('A few more settings to configure...\n');
    const claudeCwd = await promptOptional(
      'CLAUDE_CWD -- working directory for Claude sessions',
      process.cwd(),
    );
    const claudeConfigDir = await promptOptional(
      'CLAUDE_CONFIG_DIR -- Claude config directory (e.g. ~/.claude-custie)',
    );
    const botName = await promptOptional(
      'BOT_NAME -- display name in system prompt',
      'Custie',
    );
    console.log(
      `\n  \x1b[2mTip: Find your Slack user ID by clicking your profile > ... > Copy member ID\x1b[0m`,
    );
    const ownerUserId = await promptOptional(
      'OWNER_USER_ID -- your Slack user ID for mention monitoring',
    );
    const defaultAllowed = ownerUserId || '';
    const allowedUserIds = await promptOptional(
      'ALLOWED_USER_IDS -- comma-separated user IDs',
      defaultAllowed,
    );
    if (!allowedUserIds) {
      warn(
        'No ALLOWED_USER_IDS set -- the bot runs with --dangerously-skip-permissions, so anyone in the workspace can execute commands. Consider restricting access.',
      );
    }

    writeConfigFile({
      botToken: botToken.trim(),
      appToken: appToken.trim(),
      signingSecret: signingSecret.trim(),
      claudeCwd,
      claudeConfigDir,
      botName,
      ownerUserId,
      allowedUserIds,
    });

    copyDefaultPrompt();

    printNextSteps();

    if (!DEBUG) {
      await context.close();
    } else {
      log('Debug mode: browser stays open. Press Ctrl+C to exit.');
      await new Promise(() => {}); // Keep alive
    }
  } catch (err) {
    error(`Setup failed: ${(err as Error).message}`);
    if (process.argv.includes('--debug')) console.error(err);

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

    warn('Browser left open for manual inspection. Press Ctrl+C to exit.');
    await new Promise(() => {}); // Keep alive
  } finally {
    rl.close();
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
  console.log('  1. Set your bot avatar:');
  console.log('     Go to https://api.slack.com/apps → your app → Basic Information');
  console.log('     Scroll to "Display Information" and upload an app icon.\n');
  console.log('  2. Customise the system prompt (optional):');
  console.log(`     Run \x1b[1mcustie prompt\x1b[0m to edit ${paths.PROMPT_FILE}\n`);
  console.log('  3. Start the bot:');
  console.log('     Run \x1b[1mcustie start\x1b[0m\n');
  console.log('  4. Install as a background service (optional):');
  console.log('     Run \x1b[1mcustie install\x1b[0m\n');
}

function copyDefaultPrompt(): void {
  if (!existsSync(paths.PROMPT_FILE)) {
    const defaultPrompt = resolve(paths.PACKAGE_ROOT, 'system.default.md');
    if (existsSync(defaultPrompt)) {
      copyFileSync(defaultPrompt, paths.PROMPT_FILE);
      success(`Default prompt copied to ${paths.PROMPT_FILE}`);
    }
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function runSetup(args: string[]): Promise<void> {
  console.log('\n\x1b[1mCustie Setup\x1b[0m\n');
  ensureDirs();

  if (args.includes('--browser')) {
    try {
      await import('playwright');
      await browserSetup();
    } catch {
      warn(
        'Playwright not installed -- falling back to guided setup.\n' +
          '  For automated browser setup, run:\n' +
          '  pnpm add -D playwright && pnpx playwright install chromium\n',
      );
      await manualSetup();
    }
    return;
  }

  // Default: guided manual setup
  await manualSetup();
}
