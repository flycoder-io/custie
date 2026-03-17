import { existsSync, copyFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { paths, ensureDirs } from '../paths';

export async function runPrompt(): Promise<void> {
  ensureDirs();

  // Copy default prompt if user hasn't customized yet
  if (!existsSync(paths.PROMPT_FILE)) {
    const defaultPrompt = resolve(paths.PACKAGE_ROOT, 'system.default.md');
    if (!existsSync(defaultPrompt)) {
      console.error('[custie] system.default.md not found in package root.');
      process.exit(1);
    }
    copyFileSync(defaultPrompt, paths.PROMPT_FILE);
    console.log(`[custie] Copied default prompt to ${paths.PROMPT_FILE}`);
  }

  const editor = process.env['EDITOR'] || 'vi';
  console.log(`[custie] Opening ${paths.PROMPT_FILE} in ${editor}...`);

  const child = spawn(editor, [paths.PROMPT_FILE], { stdio: 'inherit' });

  return new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Editor exited with code ${code}`));
      }
    });
    child.on('error', (err) => {
      reject(new Error(`Failed to open editor: ${err.message}`));
    });
  });
}
