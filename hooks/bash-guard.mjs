#!/usr/bin/env node
// PreToolUse(Bash) guard for Custie. Two jobs, both aimed at the same failure:
// a single Bash tool call that hangs the whole turn until Custie's wall-clock
// timeout SIGKILLs it (which also drops the Slack session).
//
//   1. BLOCK foreground-forever commands (`pnpm dev`, `tail -f`, a watcher, an
//      undetached `docker run`). These never exit by design — tell the model to
//      background them instead.
//   2. WRAP everything else in `timeout` so a command that is SUPPOSED to exit
//      but unexpectedly hangs (a browser-automation / CDP / network script like
//      `node scripts/cia-query.mjs`) gets killed after a bounded time instead of
//      eating the turn. Only simple commands are wrapped — see below.
//
// Wired in via `agent.ts` (`--settings` with a PreToolUse hook). Applies ONLY to
// Custie's CLI invocations, never to the user's own Claude Code.
//
// Protocol: read the hook payload as JSON on stdin.
//   - exit 0 (no output)            -> allow unchanged
//   - exit 2 (+ stderr)             -> block; stderr is the reason shown to the model
//   - exit 0 + JSON updatedInput    -> allow, but run the rewritten command

import { readFileSync, existsSync } from 'node:fs';

function allow() {
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '';
  }
}

let toolInput = {};
let command = '';
try {
  const payload = JSON.parse(readStdin() || '{}');
  toolInput = payload?.tool_input ?? {};
  command = String(toolInput.command ?? '');
} catch {
  // Unparseable payload: fail open so we never wedge a turn over a guard bug.
  allow();
}

if (!command.trim()) allow();

// --- 1. Already safe: backgrounded, detached, or already bounded by timeout ---
// `&&`/`||`/`&>`/`2>&1` are NOT backgrounding, so match a real trailing `&`.
const ALREADY_SAFE = [
  /\bnohup\b/,
  /\bdisown\b/,
  /(^|[^&|>])&\s*$/, // trailing single & (job control), not &&/&>/2>&1
  /\btimeout\s+/, // already wrapped (incl. our own rewrite)
  /\bgtimeout\s+/,
];
if (ALREADY_SAFE.some((re) => re.test(command))) allow();

// --- 2. Foreground-forever runners: block with guidance ---
const LONG_RUNNING = [
  { re: /\btail\s+-[a-zA-Z]*f/, hint: 'tail -f follows forever' },
  { re: /\b(pnpm|npm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch|preview)\b/, hint: 'package dev/start/serve/watch script' },
  { re: /\bnext\s+dev\b/, hint: 'next dev server' },
  { re: /\bvite\b(?!\s+build)/, hint: 'vite dev server (without build)' },
  { re: /\bnodemon\b/, hint: 'nodemon watcher' },
  { re: /\btsx\s+watch\b/, hint: 'tsx watch' },
  { re: /\b(jest|vitest|playwright)\b.*--watch\b/, hint: 'test watcher' },
  { re: /\bvitest\b(?!\s+run)/, hint: 'vitest (defaults to watch mode; use `vitest run`)' },
  { re: /\b--watch(=true)?\b/, hint: 'a --watch flag' },
  { re: /\bdocker\s+run\b(?![^\n]*\s-d\b)(?![^\n]*--detach\b)/, hint: 'docker run without -d/--detach' },
  { re: /\bdocker[\s-]+compose\s+up\b(?![^\n]*\s-d\b)(?![^\n]*--detach\b)/, hint: 'docker compose up without -d' },
  { re: /\bpython\d?\s+-m\s+http\.server\b/, hint: 'python http.server' },
  { re: /\bserve\b(?!\s)/, hint: 'static `serve`' },
  { re: /\binotifywait\b.*\s-m\b/, hint: 'inotifywait -m (monitor mode)' },
];

const blocked = LONG_RUNNING.find(({ re }) => re.test(command));
if (blocked) {
  process.stderr.write(
    `Blocked: this looks like a long-running foreground process (${blocked.hint}). ` +
      `In Custie this would hang the whole turn until it is force-killed, which also ` +
      `drops the conversation session. Do NOT run it in the foreground.\n\n` +
      `If you need it running, background it and return the PID:\n` +
      `  nohup <cmd> > /tmp/<name>.log 2>&1 & disown; echo $!\n` +
      `then poll the log / port to confirm it started.\n\n` +
      `If you only need a bounded run (build, one-shot check), wrap it: ` +
      `\`timeout 120 <cmd>\`.`,
  );
  process.exit(2);
}

// --- 3. Wrap simple commands in `timeout` (the should-exit-but-might-hang case) ---

// Locate a real `timeout` binary. launchd's PATH may omit homebrew, so probe
// absolute paths and fall open (no wrap) if none is found.
function findTimeoutBin() {
  const candidates = [
    '/opt/homebrew/bin/timeout',
    '/opt/homebrew/bin/gtimeout',
    '/usr/local/bin/timeout',
    '/usr/local/bin/gtimeout',
    '/usr/bin/timeout',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

// Skip wrapping anything that isn't a single simple command — prefixing
// `timeout N` only governs the FIRST simple command, so pipes/chains/subshells
// and shell builtins (cd must run in the tool's own shell) would break or be
// only partially covered. Leave those to the wall-clock backstop.
function isSimpleCommand(cmd) {
  const c = cmd.trim();
  if (/[\n;`]|\|\||&&|(^|[^>&])\|[^|]|\$\(|<\(|>\(/.test(c)) return false; // chains/pipes/subshells
  if (/(^|[^&|>])&(\s|$)/.test(c)) return false; // backgrounding
  if (/^\w+=/.test(c)) return false; // leading VAR=... assignment
  const first = c.split(/\s+/)[0];
  const BUILTINS = new Set([
    'cd', 'export', 'source', '.', 'eval', 'exec', ':', 'set', 'unset',
    'alias', 'pushd', 'popd', 'pwd', 'echo', 'true', 'false', 'wait', 'kill',
  ]);
  return !BUILTINS.has(first);
}

// Known legitimately-long single commands: don't false-kill these at the default
// cap. The wall-clock still backstops them.
const SKIP_WRAP = [
  /\b(npm|pnpm|yarn|bun)\s+(install|ci|add|i|up|update|upgrade|dedupe)\b/,
  /\bgit\s+(clone|fetch|pull|push)\b/,
  /\b(docker|podman)\s+(build|pull|push)\b/,
  /\bbrew\s+(install|upgrade|update|reinstall)\b/,
  /\bpip3?\s+install\b/,
];

function timeoutSeconds() {
  const raw = process.env.CUSTIE_BASH_TIMEOUT_SECONDS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 300;
}

const timeoutBin = findTimeoutBin();
if (!timeoutBin || !isSimpleCommand(command) || SKIP_WRAP.some((re) => re.test(command))) {
  allow();
}

const secs = timeoutSeconds();
// -v: print a clear "timeout: sending signal..." line to stderr so the model
//     knows WHY the command died (vs. a mysterious exit 124).
// -k 5: SIGKILL 5s after SIGTERM if the command ignores TERM.
const wrapped = `${timeoutBin} -v -k 5 ${secs} ${command}`;
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...toolInput, command: wrapped },
    },
  }),
);
process.exit(0);
