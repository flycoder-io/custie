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
  /** Model passed to the Claude CLI (`--model`). Defaults to 'sonnet' to keep
   * programmatic usage cheap; set CUSTIE_MODEL=opus to restore Opus quality. */
  model: string;
  /** Per-invocation spend cap passed to the CLI (`--max-budget-usd`). A runaway
   * backstop, not a target. Empty/0 disables the cap. */
  maxBudgetUsd?: number;
  ownerUserId?: string;
  autoRespondChannelIds: Set<string>;
}

/**
 * Load env files in priority order (first file wins per variable):
 *   1. ~/.config/custie/config.env
 *   2. repo .env
 *   3. env vars already set in the process
 */
export function loadEnvFiles(): void {
  // Load XDG config.env first — override: true so config.env wins over plist env vars
  if (existsSync(paths.CONFIG_FILE)) {
    dotenv.config({ path: paths.CONFIG_FILE, override: true });
  }

  // Load repo .env second (lower priority than config.env)
  const repoEnv = resolve(process.cwd(), '.env');
  if (existsSync(repoEnv)) {
    dotenv.config({ path: repoEnv, override: false });
  }
}

/** Per-call spend cap in USD. Defaults to a generous runaway backstop ($5);
 * set MAX_BUDGET_USD=0 to disable. With the default 'sonnet' model this is far
 * above any normal Slack reply, so it only catches stuck loops. */
function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return 5;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
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

  const autoRespondChannelIds = new Set(
    (process.env['AUTO_RESPOND_CHANNEL_IDS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  );

  return {
    slackBotToken: requireEnv('SLACK_BOT_TOKEN'),
    slackAppToken: requireEnv('SLACK_APP_TOKEN'),
    slackSigningSecret: requireEnv('SLACK_SIGNING_SECRET'),
    claudeCwd: process.env['CLAUDE_CWD'] ?? process.cwd(),
    claudeConfigDir: process.env['CLAUDE_CONFIG_DIR'] || undefined,
    botName: process.env['BOT_NAME'] ?? 'Custie',
    allowedUserIds,
    maxTurns: parseInt(process.env['MAX_TURNS'] ?? '10', 10),
    model: process.env['CUSTIE_MODEL']?.trim() || 'sonnet',
    maxBudgetUsd: parseBudget(process.env['MAX_BUDGET_USD']),
    ownerUserId,
    autoRespondChannelIds,
  };
}
