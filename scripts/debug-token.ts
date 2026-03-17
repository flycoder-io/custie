/**
 * Debug: find where the xoxc- token lives in the browser context.
 * Usage: npx tsx scripts/debug-token.ts
 */

import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const USER_DATA_DIR = resolve(tmpdir(), 'custie-playwright-profile');

async function main() {
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://api.slack.com/apps');
  await page.waitForTimeout(3000);

  // 1. Check cookies
  const cookies = await context.cookies('https://api.slack.com');
  console.log('\n=== COOKIES ===');
  for (const c of cookies) {
    const val = c.value.length > 40 ? c.value.slice(0, 40) + '...' : c.value;
    console.log(`  ${c.name} = ${val}`);
    if (c.value.includes('xox')) {
      console.log(`  >>> FOUND TOKEN IN COOKIE: ${c.name}`);
    }
  }

  // Also check slack.com cookies
  const slackCookies = await context.cookies('https://slack.com');
  console.log('\n=== SLACK.COM COOKIES ===');
  for (const c of slackCookies) {
    if (c.value.includes('xox')) {
      console.log(`  >>> FOUND TOKEN IN COOKIE: ${c.name} = ${c.value.slice(0, 40)}...`);
    }
  }

  // 2. Check JS globals
  console.log('\n=== JS GLOBALS ===');
  const jsToken = await page.evaluate(() => {
    const results: string[] = [];

    // Check common Slack boot data locations
    const w = window as Record<string, unknown>;
    if (w.boot_data) results.push(`boot_data found: ${JSON.stringify(w.boot_data).slice(0, 200)}`);
    if (w.api_token) results.push(`api_token: ${w.api_token}`);
    if (w.TS) results.push(`TS found: ${JSON.stringify(Object.keys(w.TS as object)).slice(0, 200)}`);

    // Search all script tags for xoxc-
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const text = s.textContent || '';
      const match = text.match(/xoxc-[a-f0-9-]+/);
      if (match) {
        results.push(`Found in script tag: ${match[0].slice(0, 40)}...`);
      }
    }

    // Check localStorage
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      const val = localStorage.getItem(key) || '';
      if (val.includes('xoxc-')) {
        results.push(`localStorage[${key}]: ${val.slice(0, 60)}...`);
      }
    }

    // Check meta tags
    const metas = document.querySelectorAll('meta');
    for (const m of metas) {
      const content = m.getAttribute('content') || '';
      if (content.includes('xox')) {
        results.push(`meta[${m.getAttribute('name')}]: ${content.slice(0, 60)}`);
      }
    }

    return results;
  });
  for (const r of jsToken) {
    console.log(`  ${r}`);
  }

  // 3. Try intercepting with a click that triggers API
  console.log('\n=== INTERCEPTING API CALLS ===');
  console.log('  Clicking around to trigger API calls...');

  const intercepted: string[] = [];
  page.on('request', (req) => {
    const postData = req.postData() || '';
    const match = postData.match(/xoxc-[a-f0-9-]+/);
    if (match && !intercepted.includes(match[0])) {
      intercepted.push(match[0]);
      console.log(`  >>> INTERCEPTED xoxc token from ${req.url()}`);
      console.log(`  >>> Token: ${match[0].slice(0, 40)}...`);
    }
  });

  // Try navigating to a specific app page which should trigger API calls
  const appLinks = await page.locator('a[href*="/apps/A"]').all();
  if (appLinks.length > 0) {
    console.log('  Clicking first app link...');
    await appLinks[0].click();
    await page.waitForTimeout(3000);
  }

  if (intercepted.length === 0) {
    console.log('  No xoxc- token intercepted from clicks.');
  }

  console.log('\nDone. Press Ctrl+C to exit.');
  await new Promise(() => {});
}

main().catch(console.error);
