import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export interface ClaudeResponse {
  sessionId: string;
  text: string;
}

export async function askClaude(
  prompt: string,
  cwd: string,
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
      systemPrompt: { type: 'preset', preset: 'claude_code' },
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
