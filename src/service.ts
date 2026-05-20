import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';
import { DEFAULT_PROFILE } from './profile';

/**
 * System-service identifiers for a profile. The `default` profile keeps the
 * original names, so an existing single-instance install needs no reinstall
 * after upgrading to a profile-aware version.
 */

/** launchd label — e.g. `io.flycoder.custie` / `io.flycoder.custie.flycoder`. */
export function serviceLabel(profile: string): string {
  return profile === DEFAULT_PROFILE
    ? 'io.flycoder.custie'
    : `io.flycoder.custie.${profile}`;
}

/** launchd plist filename for the profile. */
export function plistName(profile: string): string {
  return `${serviceLabel(profile)}.plist`;
}

/** Absolute path to the profile's launchd plist under ~/Library/LaunchAgents. */
export function plistPath(profile: string): string {
  return join(homedir(), 'Library', 'LaunchAgents', plistName(profile));
}

/** systemd user unit name — e.g. `custie` / `custie-flycoder`. */
export function systemdUnitName(profile: string): string {
  return profile === DEFAULT_PROFILE ? 'custie' : `custie-${profile}`;
}

/** Absolute path to the profile's systemd user unit file. */
export function systemdUnitPath(profile: string): string {
  return join(homedir(), '.config', 'systemd', 'user', `${systemdUnitName(profile)}.service`);
}

/** Whether the profile's system service has been installed on this machine. */
export function isServiceInstalled(profile: string): boolean {
  if (platform() === 'darwin') return existsSync(plistPath(profile));
  if (platform() === 'linux') return existsSync(systemdUnitPath(profile));
  return false;
}

/**
 * Restart one profile's system service. Returns false if it could not be
 * (re)started — e.g. the service is not installed.
 */
export function restartService(profile: string): boolean {
  const os = platform();
  if (os === 'darwin') {
    const plist = plistPath(profile);
    try {
      execSync(`launchctl unload "${plist}"`, { stdio: 'pipe' });
    } catch {
      /* not loaded — `load` will start it fresh */
    }
    try {
      execSync(`launchctl load "${plist}"`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
  if (os === 'linux') {
    try {
      execSync(`systemctl --user restart ${systemdUnitName(profile)}`, { stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
