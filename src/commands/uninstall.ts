import { unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

const PLIST_NAME = 'io.flycoder.custie.plist';
const SYSTEMD_SERVICE = 'custie.service';

function log(msg: string): void {
  console.log(`\n\x1b[36m>\x1b[0m ${msg}`);
}

function success(msg: string): void {
  console.log(`\x1b[32m+\x1b[0m ${msg}`);
}

function warn(msg: string): void {
  console.log(`\x1b[33m!\x1b[0m ${msg}`);
}

function run(cmd: string): void {
  execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
}

export async function runUninstall(): Promise<void> {
  const os = platform();
  log('Uninstalling Custie service...');

  if (os === 'darwin') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', PLIST_NAME);
    try {
      run(`launchctl unload "${plistPath}"`);
    } catch {
      /* not loaded */
    }
    try {
      unlinkSync(plistPath);
    } catch {
      /* not present */
    }
    success('LaunchAgent removed.');
  } else if (os === 'linux') {
    try {
      run('systemctl --user disable --now custie');
    } catch {
      /* not active */
    }
    const unitPath = join(homedir(), '.config', 'systemd', 'user', SYSTEMD_SERVICE);
    try {
      unlinkSync(unitPath);
    } catch {
      /* not present */
    }
    try {
      run('systemctl --user daemon-reload');
    } catch {
      /* ignore */
    }
    success('systemd user service removed.');
  } else {
    warn(`Unsupported platform: ${os}`);
  }

  console.log('\n  Config and data directories were NOT removed.');
}
