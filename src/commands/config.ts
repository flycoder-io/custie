import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { paths, ensureDirs } from '../paths';
import { loadEnvFiles } from '../config';

function maskToken(value: string): string {
  if (!value || value.length < 12) return '****';
  return value.slice(0, 8) + '...' + value.slice(-4);
}

function isSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.includes('token') || lower.includes('secret');
}

function printConfig(): void {
  loadEnvFiles();

  console.log('\n  Paths:');
  console.log(`    Config dir:   ${paths.CONFIG_DIR}`);
  console.log(`    Data dir:     ${paths.DATA_DIR}`);
  console.log(`    Config file:  ${paths.CONFIG_FILE} ${existsSync(paths.CONFIG_FILE) ? '(exists)' : '(not found)'}`);
  console.log(`    Prompt file:  ${paths.PROMPT_FILE} ${existsSync(paths.PROMPT_FILE) ? '(exists)' : '(not found)'}`);
  console.log(`    Database:     ${paths.DB_FILE} ${existsSync(paths.DB_FILE) ? '(exists)' : '(not found)'}`);
  console.log(`    Log dir:      ${paths.LOG_DIR}`);

  const repoEnv = resolve(process.cwd(), '.env');
  console.log(`    Repo .env:    ${repoEnv} ${existsSync(repoEnv) ? '(exists)' : '(not found)'}`);

  // Show loaded values
  const envKeys = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET',
    'CLAUDE_CWD',
    'CLAUDE_CONFIG_DIR',
    'BOT_NAME',
    'ALLOWED_USER_IDS',
    'OWNER_USER_ID',
    'MAX_TURNS',
  ];

  console.log('\n  Environment:');
  for (const key of envKeys) {
    const value = process.env[key] ?? '';
    const display = isSensitive(key) && value ? maskToken(value) : value || '(not set)';
    console.log(`    ${key}=${display}`);
  }

  console.log('');
}

function editConfig(): Promise<void> {
  ensureDirs();

  // Create config file if it doesn't exist
  if (!existsSync(paths.CONFIG_FILE)) {
    const defaultEnv = resolve(paths.PACKAGE_ROOT, '.env.example');
    if (existsSync(defaultEnv)) {
      const content = readFileSync(defaultEnv, 'utf-8');
      writeFileSync(paths.CONFIG_FILE, content);
    } else {
      writeFileSync(paths.CONFIG_FILE, '');
    }
    console.log(`[custie] Created ${paths.CONFIG_FILE}`);
  }

  const editor = process.env['EDITOR'] || 'vi';
  console.log(`[custie] Opening ${paths.CONFIG_FILE} in ${editor}...`);

  const child = spawn(editor, [paths.CONFIG_FILE], { stdio: 'inherit' });

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Editor exited with code ${code}`));
      }
    });
    child.on('error', (err) => {
      reject(new Error(`Failed to open editor: ${err.message}`));
    });
  });
}

export async function runConfig(args: string[]): Promise<void> {
  if (args.includes('--path')) {
    console.log(paths.CONFIG_FILE);
    return;
  }

  if (args.includes('--edit')) {
    await editConfig();
    return;
  }

  printConfig();
}
