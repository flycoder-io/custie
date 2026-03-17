import 'dotenv/config';

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
