/**
 * Record Slack internal API calls while you manually create an app.
 *
 * Usage: npx tsx scripts/record-api.ts
 *
 * Steps:
 * 1. Browser opens to api.slack.com/apps (log in if needed)
 * 2. Walk through the app creation flow manually
 * 3. Press Ctrl+C when done — captured API calls are saved to scripts/api-log.json
 */

import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const USER_DATA_DIR = resolve(tmpdir(), 'custie-playwright-profile');
const OUTPUT_FILE = resolve(import.meta.dirname, 'api-log.json');

interface ApiEntry {
  timestamp: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  responseBody: string | null;
}

const captured: ApiEntry[] = [];

async function main() {
  console.log('Launching browser...\n');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    slowMo: 50,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = context.pages()[0] || (await context.newPage());

  // Capture API calls (skip static assets)
  page.on('request', (req) => {
    const url = req.url();
    if (!url.includes('slack.com/api/') && !url.includes('api.slack.com')) return;
    if (url.match(/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/)) return;

    const entry: ApiEntry = {
      timestamp: new Date().toISOString(),
      method: req.method(),
      url,
      requestHeaders: req.headers(),
      requestBody: req.postData() || null,
      status: null,
      responseBody: null,
    };

    captured.push(entry);
    console.log(`→ ${req.method()} ${url}`);
  });

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('slack.com/api/') && !url.includes('api.slack.com')) return;
    if (url.match(/\.(js|css|png|jpg|svg|woff|ico)(\?|$)/)) return;

    const entry = [...captured].reverse().find((e) => e.url === url && e.status === null);
    if (!entry) return;

    entry.status = res.status();
    try {
      entry.responseBody = await res.text();
    } catch {
      entry.responseBody = '(could not read body)';
    }

    const preview = entry.responseBody?.slice(0, 120) || '';
    console.log(`← ${res.status()} ${url}`);
    console.log(`  ${preview}...\n`);
  });

  await page.goto('https://api.slack.com/apps');
  console.log('\n──────────────────────────────────────────────');
  console.log('Browser is open. Walk through the setup flow:');
  console.log('  1. Click "Create New App" → "From a manifest"');
  console.log('  2. Select workspace, paste manifest, create app');
  console.log('  3. Copy Signing Secret');
  console.log('  4. Generate App-Level Token (connections:write)');
  console.log('  5. Install app to workspace');
  console.log('  6. Copy Bot User OAuth Token');
  console.log('──────────────────────────────────────────────');
  console.log('Press Ctrl+C when done. API log will be saved.\n');

  // Save on exit
  const save = () => {
    writeFileSync(OUTPUT_FILE, JSON.stringify(captured, null, 2));
    console.log(`\nSaved ${captured.length} API calls to ${OUTPUT_FILE}`);
    process.exit(0);
  };

  process.on('SIGINT', save);
  process.on('SIGTERM', save);

  // Keep alive
  await new Promise(() => {});
}

main().catch(console.error);
