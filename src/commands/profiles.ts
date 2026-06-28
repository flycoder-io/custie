import { existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { platform } from 'node:os';
import { paths } from '../paths';
import { serviceLabel, systemdUnitName } from '../service';

/** All profile names: `default` plus every directory under PROFILES_DIR. */
export function listProfiles(): string[] {
  const profiles = ['default'];
  if (existsSync(paths.PROFILES_DIR)) {
    for (const entry of readdirSync(paths.PROFILES_DIR)) {
      try {
        if (statSync(join(paths.PROFILES_DIR, entry)).isDirectory()) {
          profiles.push(entry);
        }
      } catch {
        /* unreadable entry — skip */
      }
    }
  }
  return profiles;
}

/** Whether the profile's system service is currently loaded/active. */
export function isServiceRunning(profile: string): boolean {
  try {
    if (platform() === 'darwin') {
      const out = execSync('launchctl list', { encoding: 'utf-8', stdio: 'pipe' });
      return out.split('\n').some((line) => line.endsWith(`\t${serviceLabel(profile)}`));
    }
    if (platform() === 'linux') {
      execSync(`systemctl --user is-active ${systemdUnitName(profile)}`, { stdio: 'pipe' });
      return true;
    }
  } catch {
    /* `is-active` exits non-zero when inactive — treat as not running */
  }
  return false;
}

export async function runProfiles(): Promise<void> {
  const profiles = listProfiles();

  console.log('\n  Profiles:\n');
  for (const profile of profiles) {
    const status = isServiceRunning(profile)
      ? '\x1b[32mrunning\x1b[0m'
      : '\x1b[90mstopped\x1b[0m';
    console.log(`    ${profile.padEnd(20)} ${status}`);
  }
  console.log('\n  Target a profile with --profile <name> on any command.\n');
}
