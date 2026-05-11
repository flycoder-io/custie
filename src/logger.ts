// Prefix every console line with an ISO timestamp so logs stay debuggable.
// Skipped for interactive TTYs so CLI output (help text, prompts) stays clean;
// only applies when stdout/stderr are redirected (e.g. launchd / systemd logs).
// Idempotent: lines that already start with [YYYY-...] are passed through
// untouched (e.g. the explicit `[${ts()}]` calls in index.ts).

const ALREADY_STAMPED = /^\[\d{4}-\d{2}-\d{2}T/;

function withTimestamp(write: (chunk: string) => boolean): (chunk: string | Uint8Array) => boolean {
  return (chunk) => {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.length === 0 || text === '\n') return write(text);
    const ts = new Date().toISOString();
    const prefixed = text
      .split('\n')
      .map((line, idx, arr) => {
        if (idx === arr.length - 1 && line === '') return line;
        if (ALREADY_STAMPED.test(line)) return line;
        return `[${ts}] ${line}`;
      })
      .join('\n');
    return write(prefixed);
  };
}

if (!process.stdout.isTTY) {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = withTimestamp(stdoutWrite) as typeof process.stdout.write;
}
if (!process.stderr.isTTY) {
  const stderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = withTimestamp(stderrWrite) as typeof process.stderr.write;
}
