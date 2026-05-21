/**
 * A Custie profile identifies an independent instance — its own config,
 * database, automations, logs, and system service. The active profile is read
 * from the `CUSTIE_PROFILE` environment variable, which `cli.ts` populates from
 * the `--profile` flag before dispatching any command.
 *
 * The `default` profile keeps the original flat paths (`~/.config/custie/…`)
 * so existing single-instance installs keep working with no migration.
 */

const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const DEFAULT_PROFILE = 'default';

/**
 * Resolve the active profile name. Returns `default` when unset. Throws on a
 * name that isn't filesystem- and service-label-safe.
 */
export function getProfile(): string {
  const raw = process.env['CUSTIE_PROFILE']?.trim();
  if (!raw || raw === DEFAULT_PROFILE) return DEFAULT_PROFILE;
  if (!PROFILE_PATTERN.test(raw)) {
    throw new Error(
      `Invalid profile name: "${raw}". Use lowercase letters, digits, and hyphens (must start with a letter or digit).`,
    );
  }
  return raw;
}

export function isDefaultProfile(): boolean {
  return getProfile() === DEFAULT_PROFILE;
}
