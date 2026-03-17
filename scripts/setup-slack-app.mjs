#!/usr/bin/env node

/**
 * Automated Slack App setup using Playwright.
 *
 * Usage:
 *   pnpm setup:slack            # Normal run
 *   pnpm setup:slack --debug    # Slow mode, keeps browser open
 *
 * What it does:
 *   1. Opens a browser to api.slack.com — you log in manually
 *   2. Creates a new Slack App from the project manifest (slack-app-manifest.yml)
 *   3. Extracts Signing Secret, generates App-Level Token, installs to workspace
 *   4. Writes all tokens to .env automatically
 */

import { chromium } from 'playwright';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// ─── Constants ───────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const MANIFEST_PATH = join(REPO_ROOT, 'slack-app-manifest.yml');
const ENV_PATH = join(REPO_ROOT, '.env');
const DEBUG = process.argv.includes('--debug');
const SLOW_MO = DEBUG ? 200 : 50;
const USER_DATA_DIR = join(tmpdir(), 'custie-playwright-profile');

// ─── Console helpers (matching setup.mjs style) ─────────────────────────────

function log(msg) {
  console.log(`\n\x1b[36m▸\x1b[0m ${msg}`);
}

function success(msg) {
  console.log(`\x1b[32m✔\x1b[0m ${msg}`);
}

function warn(msg) {
  console.log(`\x1b[33m⚠\x1b[0m ${msg}`);
}

function error(msg) {
  console.error(`\x1b[31m✖\x1b[0m ${msg}`);
}

function mask(token) {
  if (!token || token.length < 12) return '****';
  return token.slice(0, 8) + '...' + token.slice(-4);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ─── Phase 0: Initialisation ────────────────────────────────────────────────

function readManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    error(`Manifest not found: ${MANIFEST_PATH}`);
    process.exit(1);
  }
  return readFileSync(MANIFEST_PATH, 'utf-8');
}

// ─── Phase 1: Authentication ────────────────────────────────────────────────

async function waitForAuth(page) {
  log('Opening Slack API dashboard...');
  await page.goto('https://api.slack.com/apps');

  // Check if already logged in by looking for "Create New App" button
  const createBtn = page.locator('a:has-text("Create New App"), button:has-text("Create New App")');
  const isLoggedIn = await createBtn.first().isVisible({ timeout: 3000 }).catch(() => false);

  if (!isLoggedIn) {
    log('Please log in to Slack in the browser window. Waiting up to 5 minutes...');
    await createBtn.first().waitFor({ state: 'visible', timeout: 300_000 });
  }

  success('Authenticated with Slack.');
}

// ─── Phase 2: Create App from Manifest ──────────────────────────────────────

async function createAppFromManifest(page, manifestYaml) {
  log('Creating new Slack App from manifest...');

  // Step 1: Click "Create New App"
  await page.locator('a:has-text("Create New App"), button:has-text("Create New App")').first().click();
  await page.waitForTimeout(1000);

  // Step 2: Choose "From an app manifest"
  await page.locator('button:has-text("From an app manifest"), a:has-text("From an app manifest")').first().click();
  await page.waitForTimeout(1000);

  // Step 3: Select workspace (may already be selected for single-workspace)
  // Wait for the "Next" button and click it
  const nextBtn = page.locator('button:has-text("Next")');
  await nextBtn.first().waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(500);
  await nextBtn.first().click();
  await page.waitForTimeout(1500);

  // Step 4: Switch to YAML tab and paste manifest
  const yamlTab = page.locator('button:has-text("YAML"), [role="tab"]:has-text("YAML")');
  if (await yamlTab.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await yamlTab.first().click();
    await page.waitForTimeout(500);
  }

  // Try textarea first, then CodeMirror, then generic approach
  const textarea = page.locator('textarea').first();
  const hasTextarea = await textarea.isVisible({ timeout: 2000 }).catch(() => false);

  if (hasTextarea) {
    await textarea.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    // Type manifest via clipboard for speed
    await textarea.fill(manifestYaml);
  } else {
    // CodeMirror or other editor — click into it and use keyboard
    const editor = page.locator('.CodeMirror, [role="textbox"], [contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(200);
    await page.keyboard.insertText(manifestYaml);
  }

  await page.waitForTimeout(500);

  // Click "Next" to go to review
  await nextBtn.first().waitFor({ state: 'visible', timeout: 10_000 });
  await nextBtn.first().click();
  await page.waitForTimeout(1500);

  // Step 5: Review and Create
  const createBtn = page.locator('button:has-text("Create")');
  await createBtn.first().waitFor({ state: 'visible', timeout: 10_000 });
  await createBtn.first().click();

  // Wait for redirect to app page
  await page.waitForURL('**/apps/A*', { timeout: 30_000 });
  const appUrl = page.url();
  const appId = appUrl.match(/\/apps\/(A[A-Z0-9]+)/)?.[1];

  success(`App created! ID: ${appId}`);
  return appId;
}

// ─── Phase 3: Extract Signing Secret ────────────────────────────────────────

async function extractSigningSecret(page) {
  log('Extracting Signing Secret...');

  // We should be on the Basic Information page after creation
  await page.waitForSelector('text=Signing Secret', { timeout: 10_000 });

  // Click "Show" to reveal the secret
  const signingSection = page.locator('text=Signing Secret').locator('..');
  const showBtn = signingSection.locator('button:has-text("Show"), a:has-text("Show")');
  if (await showBtn.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await showBtn.first().click();
    await page.waitForTimeout(500);
  }

  // Try to extract from input field or text
  let secret = await signingSection.locator('input').first().inputValue().catch(() => '');
  if (!secret) {
    // Try reading from a span/code element nearby
    secret = await page
      .locator('text=Signing Secret')
      .locator('xpath=ancestor::div[contains(@class,"app_credential")]//input | ancestor::div[contains(@class,"api_credential")]//input')
      .first()
      .inputValue()
      .catch(() => '');
  }
  if (!secret) {
    // Broader approach: find the credential value near the label
    secret = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('*')].filter(
        (el) => el.textContent?.trim() === 'Signing Secret',
      );
      for (const label of labels) {
        const container = label.closest('div');
        if (!container) continue;
        const input = container.querySelector('input');
        if (input?.value) return input.value;
      }
      return '';
    });
  }

  if (!secret) {
    warn('Could not auto-extract Signing Secret. Please copy it manually from the browser.');
    secret = await ask('  Paste your Signing Secret here: ');
  }

  success(`Signing Secret: ${mask(secret)}`);
  return secret.trim();
}

// ─── Phase 4: Generate App-Level Token ──────────────────────────────────────

async function generateAppToken(page) {
  log('Generating App-Level Token (Socket Mode)...');

  // Scroll to App-Level Tokens section
  const tokenSection = page.locator('text=App-Level Tokens');
  await tokenSection.first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);

  // Click "Generate Token and Scopes"
  const generateBtn = page.locator(
    'button:has-text("Generate Token"), a:has-text("Generate Token")',
  );
  await generateBtn.first().click();
  await page.waitForTimeout(1000);

  // Fill token name
  const nameInput = page.locator(
    'input[placeholder*="oken"], input[placeholder*="name"], input[name*="token"]',
  );
  await nameInput.first().waitFor({ state: 'visible', timeout: 10_000 });
  await nameInput.first().fill('socket-mode');
  await page.waitForTimeout(500);

  // Add scope: connections:write
  const addScopeBtn = page.locator('button:has-text("Add Scope"), a:has-text("Add Scope")');
  await addScopeBtn.first().click();
  await page.waitForTimeout(500);

  // Select connections:write from dropdown
  const scopeOption = page.locator('text=connections:write');
  await scopeOption.first().click();
  await page.waitForTimeout(500);

  // Click Generate
  const genBtn = page.locator('button:has-text("Generate")');
  await genBtn.first().click();
  await page.waitForTimeout(2000);

  // Extract the xapp- token
  let appToken = await page.evaluate(() => {
    const els = [...document.querySelectorAll('input, code, span, div')];
    for (const el of els) {
      const val = el.value || el.textContent || '';
      if (val.trim().startsWith('xapp-')) return val.trim();
    }
    return '';
  });

  if (!appToken) {
    warn('Could not auto-extract App-Level Token. Please copy it from the browser.');
    appToken = await ask('  Paste your App-Level Token (xapp-...): ');
  }

  // Close the modal
  const doneBtn = page.locator('button:has-text("Done")');
  if (await doneBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await doneBtn.first().click();
    await page.waitForTimeout(500);
  }

  success(`App-Level Token: ${mask(appToken)}`);
  return appToken.trim();
}

// ─── Phase 5: Install App & Get Bot Token ───────────────────────────────────

async function installAndGetBotToken(page, appId) {
  log('Installing app to workspace...');

  // Navigate to Install App page
  const installLink = page.locator('a:has-text("Install App")');
  if (await installLink.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    await installLink.first().click();
  } else {
    await page.goto(`https://api.slack.com/apps/${appId}/install-on-team`);
  }
  await page.waitForTimeout(1500);

  // Click "Install to Workspace"
  const installBtn = page.locator(
    'button:has-text("Install to Workspace"), a:has-text("Install to Workspace")',
  );
  await installBtn.first().waitFor({ state: 'visible', timeout: 10_000 });
  await installBtn.first().click();
  await page.waitForTimeout(2000);

  // Click "Allow" on OAuth consent page
  const allowBtn = page.locator('button:has-text("Allow")');
  if (await allowBtn.first().isVisible({ timeout: 5000 }).catch(() => false)) {
    await allowBtn.first().click();
    await page.waitForTimeout(2000);
  }

  // Extract Bot Token
  await page.waitForSelector('text=Bot User OAuth Token', { timeout: 15_000 });

  let botToken = await page.evaluate(() => {
    const els = [...document.querySelectorAll('input')];
    for (const el of els) {
      if (el.value?.startsWith('xoxb-')) return el.value;
    }
    return '';
  });

  if (!botToken) {
    // Try clicking "Show" first
    const showBtn = page.locator('button:has-text("Show"), a:has-text("Show")').first();
    if (await showBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await showBtn.click();
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
    // Try Copy button approach
    const copyBtn = page
      .locator('text=Bot User OAuth Token')
      .locator('..')
      .locator('button:has-text("Copy")');
    if (await copyBtn.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await copyBtn.first().click();
      // Read from clipboard
      botToken = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
    }
  }

  if (!botToken) {
    warn('Could not auto-extract Bot Token. Please copy it from the browser.');
    botToken = await ask('  Paste your Bot User OAuth Token (xoxb-...): ');
  }

  success(`Bot Token: ${mask(botToken)}`);
  return botToken.trim();
}

// ─── Phase 6: Prompt for additional config & write .env ─────────────────────

async function promptOptional(label, hint, defaultValue = '') {
  const defaultStr = defaultValue ? ` (default: ${defaultValue})` : ' (leave blank to skip)';
  const value = (await ask(`  ${label}${defaultStr}: `)).trim();
  return value || defaultValue;
}

async function collectConfig() {
  log('A few more settings to configure...\n');

  const claudeCwd = await promptOptional(
    'CLAUDE_CWD — working directory for Claude sessions',
    '',
    REPO_ROOT,
  );

  const claudeConfigDir = await promptOptional(
    'CLAUDE_CONFIG_DIR — Claude config directory (e.g. ~/.claude-custie)',
    '',
  );

  const botName = await promptOptional('BOT_NAME — display name in system prompt', '', 'Custie');

  console.log(
    `\n  \x1b[2mTip: Find your Slack user ID by clicking your profile → ⋯ → Copy member ID\x1b[0m`,
  );

  const ownerUserId = await promptOptional(
    'OWNER_USER_ID — your Slack user ID for mention monitoring',
    '',
  );

  const defaultAllowed = ownerUserId || '';
  const allowedUserIds = await promptOptional(
    'ALLOWED_USER_IDS — comma-separated user IDs',
    '',
    defaultAllowed,
  );

  if (!allowedUserIds) {
    warn(
      'No ALLOWED_USER_IDS set — the bot runs with --dangerously-skip-permissions, so anyone in the workspace can execute commands. Consider restricting access.',
    );
  }

  return { claudeCwd, claudeConfigDir, botName, ownerUserId, allowedUserIds };
}

async function writeEnvFile(signingSecret, appToken, botToken) {
  if (existsSync(ENV_PATH)) {
    const answer = await ask('\n  .env already exists. Overwrite? (y/N) ');
    if (answer.trim().toLowerCase() !== 'y') {
      warn('Skipping .env write. Tokens printed above for manual use.');
      return;
    }
  }

  const config = await collectConfig();

  const envContent = [
    `# Slack Bot Token (xoxb-...)`,
    `SLACK_BOT_TOKEN=${botToken}`,
    ``,
    `# Slack App-Level Token for Socket Mode (xapp-...)`,
    `SLACK_APP_TOKEN=${appToken}`,
    ``,
    `# Slack Signing Secret`,
    `SLACK_SIGNING_SECRET=${signingSecret}`,
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
    `# If set, the owner is automatically included — no need to duplicate`,
    `ALLOWED_USER_IDS=${config.allowedUserIds}`,
    ``,
    `# Owner's Slack user ID — bot reacts with eyes when owner is mentioned (direct or via group)`,
    `# Does not restrict access on its own; only ALLOWED_USER_IDS controls who can use the bot`,
    `OWNER_USER_ID=${config.ownerUserId}`,
    ``,
  ].join('\n');

  writeFileSync(ENV_PATH, envContent);
  success('.env written successfully!');
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n\x1b[1m🤖 Custie — Automated Slack App Setup\x1b[0m\n');

  const manifestYaml = readManifest();
  success('Manifest loaded from slack-app-manifest.yml');

  let browser;
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
    await waitForAuth(page);

    // Phase 2: Create app
    const appId = await createAppFromManifest(page, manifestYaml);

    // Phase 3: Signing Secret
    const signingSecret = await extractSigningSecret(page);

    // Phase 4: App-Level Token
    const appToken = await generateAppToken(page);

    // Phase 5: Install & Bot Token
    const botToken = await installAndGetBotToken(page, appId);

    // Phase 6: Write .env
    await writeEnvFile(signingSecret, appToken, botToken);

    log('Setup complete! Run `pnpm dev` to start Custie.');

    if (!DEBUG) {
      await context.close();
    } else {
      log('Debug mode: browser stays open. Press Ctrl+C to exit.');
      await new Promise(() => {}); // Keep alive
    }
  } catch (err) {
    error(`Setup failed: ${err.message}`);
    if (DEBUG) console.error(err);

    // Take screenshot on error
    try {
      const pages = context?.pages();
      if (pages?.[0]) {
        const screenshotPath = join(REPO_ROOT, 'setup-error.png');
        await pages[0].screenshot({ path: screenshotPath, fullPage: true });
        warn(`Screenshot saved to: ${screenshotPath}`);
      }
    } catch {
      // ignore screenshot errors
    }

    warn('Browser left open for manual inspection. Press Ctrl+C to exit.');
    await new Promise(() => {}); // Keep alive for inspection
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  error(err.message);
  process.exit(1);
});
