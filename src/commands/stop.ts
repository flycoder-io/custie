import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import { getProfile } from '../profile';
import { plistPath, systemdUnitName, isServiceInstalled, restartService } from '../service';

function log(msg: string): void {
  console.log(`\n\x1b[36m>\x1b[0m ${msg}`);
}

function success(msg: string): void {
  console.log(`\x1b[32m+\x1b[0m ${msg}`);
}

function warn(msg: string): void {
  console.log(`\x1b[33m!\x1b[0m ${msg}`);
}

export async function runStop(): Promise<void> {
  const os = platform();
  const profile = getProfile();

  if (os === 'darwin') {
    const plist = plistPath(profile);
    log('Stopping Custie service...');
    try {
      execSync(`launchctl unload "${plist}"`, { stdio: 'pipe' });
      success('Service stopped. Run `custie restart` to start again.');
    } catch {
      warn('Service is not currently loaded.');
    }
  } else if (os === 'linux') {
    log('Stopping Custie service...');
    try {
      execSync(`systemctl --user stop ${systemdUnitName(profile)}`, { stdio: 'pipe' });
      success('Service stopped. Run `custie restart` to start again.');
    } catch {
      warn('Service is not currently running.');
    }
  } else {
    warn(`Unsupported platform: ${os}`);
  }
}

export async function runRestart(): Promise<void> {
  const os = platform();
  if (os !== 'darwin' && os !== 'linux') {
    warn(`Unsupported platform: ${os}`);
    return;
  }

  const profile = getProfile();
  if (!isServiceInstalled(profile)) {
    warn(`No service installed for profile "${profile}". Run \`custie install\` first.`);
    return;
  }

  log('Restarting Custie service...');
  if (restartService(profile)) {
    success('Service restarted.');
  } else {
    warn('Failed to restart. Try `custie install` to reinstall the service.');
  }
}
