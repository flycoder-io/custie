import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeResponse {
  sessionId: string;
  text: string;
}

const debug = process.env['DEBUG'] === 'true';

function loadSystemPrompt(): string {
  const root = resolve(import.meta.dirname, '../..');
  const customPath = resolve(root, 'system.md');
  const defaultPath = resolve(root, 'system.default.md');
  const filePath = existsSync(customPath) ? customPath : defaultPath;
  return readFileSync(filePath, 'utf-8').trim();
}

function buildSystemPrompt(botName: string): string {
  return loadSystemPrompt().replaceAll('{{botName}}', botName);
}

function buildOptions(cwd: string, botName: string, claudeConfigDir?: string, resumeSessionId?: string) {
  return {
    cwd,
    ...(claudeConfigDir ? { env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir } } : {}),
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    systemPrompt: {
      type: 'preset' as const,
      preset: 'claude_code' as const,
      append: buildSystemPrompt(botName),
    },
    maxTurns: 3,
    settingSources: ['user', 'project', 'local'] as const,
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
  };
}

async function runQuery(prompt: string, cwd: string, botName: string, claudeConfigDir?: string, resumeSessionId?: string) {
  let sessionId = resumeSessionId ?? '';
  let resultText = '';

  const conversation = query({
    prompt,
    options: buildOptions(cwd, botName, claudeConfigDir, resumeSessionId),
  });

  for await (const message of conversation) {
    if (message.type === 'system' && message.subtype === 'init') {
      sessionId = message.session_id;
    }

    if (message.type === 'result' && message.subtype === 'success') {
      resultText = (message as Extract<SDKMessage, { type: 'result'; subtype: 'success' }>).result;
    }

    if (message.type === 'result' && message.subtype !== 'success') {
      const errMsg = message as Record<string, unknown>;
      const errors = Array.isArray(errMsg['errors'])
        ? (errMsg['errors'] as string[]).join(', ')
        : 'Unknown error';
      resultText = `Error: ${errors}`;
    }
  }

  return { sessionId, text: resultText };
}

export async function askClaude(
  prompt: string,
  cwd: string,
  botName: string,
  claudeConfigDir?: string,
  resumeSessionId?: string,
): Promise<ClaudeResponse> {
  try {
    return await runQuery(prompt, cwd, botName, claudeConfigDir, resumeSessionId);
  } catch (err) {
    if (resumeSessionId) {
      if (debug) console.log(`[agent] session resume failed, starting fresh session`);
      return await runQuery(prompt, cwd, botName, claudeConfigDir);
    }
    throw err;
  }
}
