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

export async function runPause(): Promise<void> {
  const os = platform();

  if (os === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', PLIST_NAME);
    log('Pausing Custie service...');
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: 'pipe' });
      success('Service paused. Run `custie resume` to restart.');
    } catch {
      warn('Service is not currently loaded.');
    }
  } else if (os === 'linux') {
    log('Pausing Custie service...');
    try {
      execSync(`systemctl --user stop ${SYSTEMD_SERVICE}`, { stdio: 'pipe' });
      success('Service paused. Run `custie resume` to restart.');
    } catch {
      warn('Service is not currently running.');
    }
  } else {
    warn(`Unsupported platform: ${os}`);
  }
}

export async function runResume(): Promise<void> {
  const os = platform();

  if (os === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', PLIST_NAME);
    log('Resuming Custie service...');
    try {
      execSync(`launchctl load "${plistPath}"`, { stdio: 'pipe' });
      success('Service resumed.');
    } catch {
      warn('Failed to resume. Is the service installed? Run `custie install` first.');
    }
  } else if (os === 'linux') {
    log('Resuming Custie service...');
    try {
      execSync(`systemctl --user start ${SYSTEMD_SERVICE}`, { stdio: 'pipe' });
      success('Service resumed.');
    } catch {
      warn('Failed to resume. Is the service installed? Run `custie install` first.');
    }
  } else {
    warn(`Unsupported platform: ${os}`);
  }
}
