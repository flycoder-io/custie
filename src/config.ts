import 'dotenv/config';

export interface Config {
  slackBotToken: string;
  slackAppToken: string;
  slackSigningSecret: string;
  claudeCwd: string;
  allowedUserIds: Set<string>;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    slackBotToken: requireEnv('SLACK_BOT_TOKEN'),
    slackAppToken: requireEnv('SLACK_APP_TOKEN'),
    slackSigningSecret: requireEnv('SLACK_SIGNING_SECRET'),
    claudeCwd: process.env['CLAUDE_CWD'] ?? process.cwd(),
    allowedUserIds: new Set(
      (process.env['ALLOWED_USER_IDS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    ),
  };
}
