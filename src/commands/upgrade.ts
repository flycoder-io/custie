import { execSync } from 'node:child_process';

declare const __VERSION__: string;

export async function runUpgrade(): Promise<void> {
  const current = __VERSION__;
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
    console.log('\nReload your shell to use the new version:');
    console.log('  source ~/.zshrc   # or source ~/.bashrc');
  } catch (err) {
    console.error('Upgrade failed:', (err as Error).message);
    console.error('\nYou can upgrade manually with: npm install -g custie@latest');
    process.exit(1);
  }
}
