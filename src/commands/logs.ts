import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../paths';

export async function runLogs(args: string[]): Promise<void> {
  const showErrors = args.includes('--error') || args.includes('-e');
  const filename = showErrors ? 'custie-error.log' : 'custie.log';
  const logFile = join(paths.LOG_DIR, filename);

  if (!existsSync(logFile)) {
    console.error(`Log file not found: ${logFile}`);
    console.error('Is the service installed? Run `custie install` first.');
    process.exit(1);
  }

  console.log(`Tailing ${logFile} (Ctrl+C to stop)\n`);

  const tail = spawn('tail', ['-f', '-n', '50', logFile], {
    stdio: 'inherit',
  });

  tail.on('error', (err) => {
    console.error(`Failed to tail log file: ${err.message}`);
    process.exit(1);
  });

  tail.on('close', (code) => {
    process.exit(code ?? 0);
  });
}
