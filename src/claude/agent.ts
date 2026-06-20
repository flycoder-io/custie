import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { paths } from '../paths';

export interface ClaudeResponse {
  sessionId: string;
  text: string;
  isError?: boolean;
  /**
   * True when the error appears to be transient (network failure, 5xx) — the
   * underlying session is intact and the caller should keep it for the next
   * `--resume`. False / undefined means the error baked into the session file
   * (e.g. a 4xx replaying on every resume) and the caller should drop it.
   */
  isTransientError?: boolean;
  /**
   * True when the prompt exceeded the model's context window. The caller should
   * drop the session and retry with progressively less context (thread history,
   * then bare prompt), and show a friendly message if nothing works.
   */
  isContextTooLong?: boolean;
  /**
   * True when the subprocess hit the wall-clock timeout and was killed. Unlike a
   * 4xx baked into the session file, a timeout does NOT necessarily corrupt the
   * session — so the caller should KEEP it and try `--resume` next time rather
   * than dropping the whole conversation. If the resumed turn replays an error,
   * the normal non-transient path drops it then.
   */
  isTimeout?: boolean;
}

const debug = process.env['DEBUG'] === 'true';

const TRANSIENT_ERROR_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /Unable to connect to API/i,
  /ConnectionRefused/i,
  /socket hang up/i,
  /network/i,
];

const CONTEXT_TOO_LONG_PATTERNS = [
  /prompt is too long/i,
  /context.{0,20}too long/i,
  /too many tokens/i,
  /context length exceeded/i,
  /maximum context length/i,
];

function isContextTooLongError(text: string): boolean {
  return CONTEXT_TOO_LONG_PATTERNS.some((p) => p.test(text));
}

function isTransientError(text: string, apiErrorStatus: number | null | undefined): boolean {
  // No HTTP status usually means the request never reached the API (DNS,
  // connect, TLS). Treat as transient.
  if (apiErrorStatus == null) {
    return TRANSIENT_ERROR_PATTERNS.some((p) => p.test(text));
  }
  // 5xx: server-side, retry-safe.
  if (apiErrorStatus >= 500 && apiErrorStatus < 600) return true;
  // 408 Request Timeout, 429 Rate Limited: retry-safe.
  if (apiErrorStatus === 408 || apiErrorStatus === 429) return true;
  // 4xx (auth, bad input): the failure persists in the session file. Not transient.
  return false;
}

// Hard timeout for the Claude CLI subprocess. The CLI runs with --output-format json,
// which only prints on completion, so we can't detect idle — only total wall-clock.
// A subprocess hanging this long is almost always stuck on a long-running command
// (dev server, watcher) inside a Bash tool call. The PreToolUse Bash guard now
// blocks the common foreground-forever offenders, so this is the backstop for the
// rest: 10 min covers genuinely long thinking + tool loops while cutting the dead
// wait (and the friendly timeout message) well before the old 15 min.
const DEFAULT_MAX_DURATION_SECONDS = 600;
// Grace period between SIGTERM and SIGKILL when the timeout fires.
const KILL_GRACE_MS = 10_000;

function getMaxDurationMs(): number {
  const raw = process.env['CLAUDE_MAX_DURATION_SECONDS'];
  if (!raw) return DEFAULT_MAX_DURATION_SECONDS * 1000;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_DURATION_SECONDS * 1000;
  return parsed * 1000;
}

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

interface CliOptions {
  model?: string;
  maxBudgetUsd?: number;
}

// PreToolUse(Bash) guard injected ONLY into Custie's CLI invocations (not the
// user's own Claude Code). It blocks foreground-forever commands before they run
// so a stuck `pnpm dev` / `tail -f` can't hang the turn until the wall-clock
// timeout kills it (which would also drop the session). Passed via `--settings`
// as an inline JSON string so it stays in-repo and touches no config dir.
function buildHookSettings(): string {
  const guardScript = resolve(paths.PACKAGE_ROOT, 'hooks/bash-guard.mjs');
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node '${guardScript}'` }],
        },
      ],
    },
  });
}

function buildArgs(
  prompt: string,
  botName: string,
  options: CliOptions,
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
    '--settings',
    buildHookSettings(),
  ];

  // Model selection (cost lever): defaults to a cheaper model upstream; only
  // passed when set so an empty value falls back to the CLI default.
  if (options.model) {
    args.push('--model', options.model);
  }

  // Per-invocation spend cap: a runaway backstop. The CLI ends the turn once
  // this dollar amount is reached rather than looping indefinitely.
  if (options.maxBudgetUsd && options.maxBudgetUsd > 0) {
    args.push('--max-budget-usd', String(options.maxBudgetUsd));
  }

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
  options: CliOptions,
  claudeConfigDir?: string,
  resumeSessionId?: string,
): Promise<ClaudeResponse> {
  return new Promise((resolve, reject) => {
    const args = buildArgs(prompt, botName, options, resumeSessionId);
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
    let timedOut = false;

    const maxDurationMs = getMaxDurationMs();
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      console.warn(
        `[agent] subprocess exceeded ${maxDurationMs / 1000}s — sending SIGTERM (likely stuck on a long-running command)`,
      );
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed) {
          console.warn('[agent] subprocess still alive after SIGTERM — sending SIGKILL');
          child.kill('SIGKILL');
        }
      }, KILL_GRACE_MS).unref();
    }, maxDurationMs);
    timeoutHandle.unref();

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (debug && stderr) {
        console.log(`[agent] stderr: ${stderr.trim()}`);
      }

      if (timedOut) {
        const minutes = Math.round(maxDurationMs / 60_000);
        resolve({
          sessionId: resumeSessionId ?? '',
          text:
            `I got stuck for over ${minutes} minutes and had to be terminated. ` +
            `Most likely cause: a Bash tool call to a long-running process (dev server, watcher, ` +
            `\`tail -f\`, etc.) that never exits. If you wanted to start a server, ask me to run it ` +
            `in the background (\`nohup ... > /tmp/log 2>&1 & disown\`) and I'll come back with the PID.`,
          isError: true,
          isTimeout: true,
        });
        return;
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
          is_error?: boolean;
          api_error_status?: number | null;
        };

        const sessionId = result.session_id ?? resumeSessionId ?? '';

        // `subtype: "success"` can coexist with `is_error: true` (e.g. when
        // an upstream API returns 400 "Could not process image"). Once that
        // happens, the CLI persists the failed turn into the session file —
        // any future --resume on this session_id replays the bad content and
        // returns the same error in 0ms. Flag it so the caller can drop the
        // session rather than save it.
        if (result.is_error) {
          // Always log (not gated on DEBUG): an is_error result is the upstream
          // source of the "failed twice" retry button, so it must be visible in
          // production logs. api_error_status pinpoints rate limit / usage-pool
          // (429), server (5xx), and auth/input (4xx) failures.
          console.error(
            `[agent] is_error result: api_error_status=${result.api_error_status ?? 'null'} ` +
              `subtype=${result.subtype} result="${(result.result ?? '').slice(0, 300)}"`,
          );
          const text = result.result || `API Error: ${result.api_error_status ?? 'unknown'}`;
          const contextTooLong = isContextTooLongError(text);
          resolve({
            sessionId,
            text,
            isError: true,
            isTransientError: !contextTooLong && isTransientError(text, result.api_error_status),
            isContextTooLong: contextTooLong || undefined,
          });
          return;
        }

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
              'That query was a bit too complex for me to handle here. You can continue this session directly:\n' +
              `\`claude --resume ${sessionId}\``,
          });
          return;
        }

        const errors = (result.errors ?? []).filter(Boolean).join(', ') || 'Unknown error';
        resolve({ sessionId, text: `Error: ${errors}`, isError: true });
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
  options: CliOptions,
  claudeConfigDir?: string,
  resumeSessionId?: string,
): Promise<ClaudeResponse> {
  try {
    return await runCli(prompt, cwd, botName, options, claudeConfigDir, resumeSessionId);
  } catch (err) {
    if (resumeSessionId) {
      if (debug) console.log(`[agent] session resume failed, starting fresh session`);
      return await runCli(prompt, cwd, botName, options, claudeConfigDir);
    }
    throw err;
  }
}
