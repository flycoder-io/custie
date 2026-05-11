import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const PLIST_NAME = 'io.flycoder.custie.plist';
const SYSTEMD_SERVICE = 'custie';

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

  if (os === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', PLIST_NAME);
    log('Stopping Custie service...');
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
      success('Service stopped. Run `custie restart` to start again.');
    } catch {
      warn('Service is not currently loaded.');
    }
  } else if (os === 'linux') {
    log('Stopping Custie service...');
    try {
      execSync(`systemctl --user stop ${SYSTEMD_SERVICE}`, { stdio: 'pipe' });
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

  if (os === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', PLIST_NAME);
    log('Restarting Custie service...');
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
    } catch {
      // Service may not be loaded — load will start it fresh.
    }
    try {
      execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
      success('Service restarted.');
    } catch {
      warn('Failed to restart. Is the service installed? Run `custie install` first.');
    }
  } else if (os === 'linux') {
    log('Restarting Custie service...');
    try {
      execSync(`systemctl --user restart ${SYSTEMD_SERVICE}`, { stdio: 'pipe' });
      success('Service restarted.');
    } catch {
      warn('Failed to restart. Is the service installed? Run `custie install` first.');
    }
  } else {
    warn(`Unsupported platform: ${os}`);
  }
}
