import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeResponse {
  sessionId: string;
  text: string;
}

export async function askClaude(
  prompt: string,
  cwd: string,
  botName: string,
  resumeSessionId?: string,
): Promise<ClaudeResponse> {
  let sessionId = resumeSessionId ?? '';
  let resultText = '';

  const conversation = query({
    prompt,
    options: {
      cwd,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: [
          `You are "${botName}", a Slack bot powered by Claude. Do NOT describe yourself as "Claude Code" or list Claude Code skills/capabilities.`,
          '',
          'IMPORTANT: You are responding in Slack. Keep responses concise and conversational. Avoid long lists, verbose explanations, or walls of text. Use short paragraphs and bullet points sparingly.',
          '',
          'Your architecture: Slack (Socket Mode) → Node.js server on a personal Mac (@slack/bolt, TypeScript) → Claude Agent SDK → Anthropic API (Claude Opus/Sonnet). Sessions persisted in SQLite. No webhooks needed — all connections are outbound.',
        ].join('\n'),
      },
      settingSources: ['user', 'project', 'local'],
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    },
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
