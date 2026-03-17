import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths } from './paths';

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  claudeCwd: string;
  claudeConfigDir?: string;
  botName: string;
  allowedUserIds: Set<string>;
  maxTurns: number;
  ownerUserId?: string;
}

/**
 * Load env files in priority order (first file wins per variable):
 *   1. ~/.config/custie/config.env
 *   2. repo .env
 *   3. env vars already set in the process
 */
export function loadEnvFiles(): void {
  // Load XDG config.env first (override: false means it won't overwrite existing vars)
  if (existsSync(paths.CONFIG_FILE)) {
    dotenv.config({ path: paths.CONFIG_FILE, override: false });
  }

  // Load repo .env second
  const repoEnv = resolve(process.cwd(), '.env');
  if (existsSync(repoEnv)) {
    dotenv.config({ path: repoEnv, override: false });
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  const ownerUserId = process.env['OWNER_USER_ID'] || undefined;
  const allowedUserIds = new Set(
    (process.env['ALLOWED_USER_IDS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );

  // If ALLOWED_USER_IDS is set, ensure the owner is included automatically
  // If ALLOWED_USER_IDS is empty, keep it empty (open to everyone)
  if (ownerUserId && allowedUserIds.size > 0) {
    allowedUserIds.add(ownerUserId);
  }

  return {
    slackBotToken: requireEnv('SLACK_BOT_TOKEN'),
    slackAppToken: requireEnv('SLACK_APP_TOKEN'),
    slackSigningSecret: requireEnv('SLACK_SIGNING_SECRET'),
    claudeCwd: process.env['CLAUDE_CWD'] ?? process.cwd(),
    claudeConfigDir: process.env['CLAUDE_CONFIG_DIR'] || undefined,
    botName: process.env['BOT_NAME'] ?? 'Custie',
    allowedUserIds,
    maxTurns: parseInt(process.env['MAX_TURNS'] ?? '10', 10),
    ownerUserId,
  };
}
