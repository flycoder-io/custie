import { join } from 'node:path';
import { homedir } from 'node:os';
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
