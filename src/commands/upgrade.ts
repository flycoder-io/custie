import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

function getVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('../../package.json') as { version: string };
  return pkg.version;
}

export async function runUpgrade(): Promise<void> {
  const current = getVersion();
  console.log(`Current version: ${current}`);
  console.log('Checking for updates...\n');

  try {
    const latest = execSync('npm view custie version', { encoding: 'utf-8' }).trim();

    if (latest === current) {
      console.log(`Already on the latest version (${current}).`);
      return;
    }

    console.log(`New version available: ${latest}`);
    console.log('Upgrading...\n');

    execSync('npm install -g custie@latest', { stdio: 'inherit' });
    console.log(`\nUpgraded from ${current} to ${latest}.`);
  } catch (err) {
    console.error('Upgrade failed:', (err as Error).message);
    console.error('\nYou can upgrade manually with: npm install -g custie@latest');
    process.exit(1);
  }
}
