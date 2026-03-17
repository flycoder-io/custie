import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths } from '../paths';

export interface ClaudeResponse {
  sessionId: string;
  text: string;
}

const debug = process.env['DEBUG'] === 'true';

function loadSystemPrompt(): string {
  // Check user-customized prompt first, then default in package root
  const customPath = paths.PROMPT_FILE;
  const defaultPath = resolve(paths.PACKAGE_ROOT, 'system.default.md');
  const filePath = existsSync(customPath) ? customPath : defaultPath;
  return readFileSync(filePath, 'utf-8').trim();
}

function loadCapabilities(): string {
  const capabilitiesPath = resolve(paths.PACKAGE_ROOT, 'system.capabilities.md');
  if (!existsSync(capabilitiesPath)) return '';
  return readFileSync(capabilitiesPath, 'utf-8').trim();
}

function buildSystemPrompt(botName: string): string {
  const prompt = loadSystemPrompt().replaceAll('{{botName}}', botName);
  const capabilities = loadCapabilities();
  return capabilities ? `${prompt}\n\n${capabilities}` : prompt;
}

function buildArgs(
  prompt: string,
  botName: string,
  resumeSessionId?: string,
): string[] {
  const args = [
    '--print',
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--no-chrome',
    '--append-system-prompt',
    buildSystemPrompt(botName),
    '--setting-sources',
    'user,project,local',
  ];

  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }

  args.push(prompt);

  return args;
}

function runCli(
  prompt: string,
  cwd: string,
  botName: string,
  claudeConfigDir?: string,
  resumeSessionId?: string,
): Promise<ClaudeResponse> {
  return new Promise((resolve, reject) => {
    const args = buildArgs(prompt, botName, resumeSessionId);
    const env = { ...process.env };
    if (claudeConfigDir) {
      env['CLAUDE_CONFIG_DIR'] = claudeConfigDir;
    }

    if (debug) {
      console.log(`[agent] spawning claude CLI in ${cwd}`);
      console.log(`[agent] args: ${args.join(' ')}`);
    }

    const child = spawn('claude', args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Close stdin immediately — CLI in -p mode reads the prompt from args,
    // but will hang waiting for stdin EOF if left open.
    child.stdin.end();

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      if (debug && stderr) {
        console.log(`[agent] stderr: ${stderr.trim()}`);
      }

      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude CLI exited with code ${code}: ${stderr.trim()}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim()) as {
          type: string;
          subtype: string;
          result?: string;
          session_id?: string;
          errors?: string[];
        };

        const sessionId = result.session_id ?? resumeSessionId ?? '';

        if (result.type === 'result' && result.subtype === 'success') {
          resolve({ sessionId, text: result.result ?? '' });
          return;
        }

        // Handle error results
        if (debug) console.log(`[agent] error result:`, JSON.stringify(result));

        if (result.subtype === 'error_max_turns') {
          resolve({
            sessionId,
            text:
              "That query was a bit too complex for me to handle here. You can continue this session directly:\n" +
              `\`claude --resume ${sessionId}\``,
          });
          return;
        }

        const errors = (result.errors ?? []).filter(Boolean).join(', ') || 'Unknown error';
        resolve({ sessionId, text: `Error: ${errors}` });
      } catch {
        // If JSON parsing fails, treat stdout as plain text
        resolve({ sessionId: resumeSessionId ?? '', text: stdout.trim() || 'No response' });
      }
    });
  });
}

export async function askClaude(
  prompt: string,
  cwd: string,
  botName: string,
  _maxTurns: number,
  claudeConfigDir?: string,
  resumeSessionId?: string,
): Promise<ClaudeResponse> {
  try {
    return await runCli(prompt, cwd, botName, claudeConfigDir, resumeSessionId);
  } catch (err) {
    if (resumeSessionId) {
      if (debug) console.log(`[agent] session resume failed, starting fresh session`);
      return await runCli(prompt, cwd, botName, claudeConfigDir);
    }
    throw err;
  }
}
