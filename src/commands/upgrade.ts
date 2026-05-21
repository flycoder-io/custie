import { execSync } from 'node:child_process';
import { isServiceInstalled, restartService } from '../service';
import { listProfiles } from './profiles';

declare const __VERSION__: string;

/** Restart every profile with an installed service so each picks up the new binary. */
function restartInstalledProfiles(): void {
  const installed = listProfiles().filter(isServiceInstalled);
  if (installed.length === 0) {
    console.log('\nNo installed services to restart.');
    return;
  }

  console.log(`\nRestarting ${installed.length} instance(s)...`);
  for (const profile of installed) {
    if (restartService(profile)) {
      console.log(`  ${profile} — restarted`);
    } else {
      console.log(`  ${profile} — restart failed; run: custie restart --profile ${profile}`);
    }
  }
}

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

    restartInstalledProfiles();

    console.log('\nReload your shell to use the new version:');
    console.log('  source ~/.zshrc   # or source ~/.bashrc');
  } catch (err) {
    console.error('Upgrade failed:', (err as Error).message);
    console.error('\nYou can upgrade manually with: npm install -g custie@latest');
    process.exit(1);
  }
}
