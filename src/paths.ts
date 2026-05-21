import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getProfile } from './profile';

const home = homedir();

const XDG_CONFIG_HOME = process.env['XDG_CONFIG_HOME'] || join(home, '.config');
const XDG_DATA_HOME = process.env['XDG_DATA_HOME'] || join(home, '.local', 'share');

export const paths = {
  /** Profile-independent config root: `~/.config/custie`. */
  get BASE_CONFIG_DIR() {
    return join(XDG_CONFIG_HOME, 'custie');
  },
  /** Profile-independent data root: `~/.local/share/custie`. */
  get BASE_DATA_DIR() {
    return join(XDG_DATA_HOME, 'custie');
  },
  /** Where named profiles live: `~/.config/custie/profiles`. */
  get PROFILES_DIR() {
    return join(XDG_CONFIG_HOME, 'custie', 'profiles');
  },

  /** Config dir for the active profile. `default` uses the base dir. */
  get CONFIG_DIR() {
    const profile = getProfile();
    return profile === 'default' ? this.BASE_CONFIG_DIR : join(this.PROFILES_DIR, profile);
  },
  /** Data dir for the active profile. `default` uses the base dir. */
  get DATA_DIR() {
    const profile = getProfile();
    return profile === 'default'
      ? this.BASE_DATA_DIR
      : join(this.BASE_DATA_DIR, 'profiles', profile);
  },

  get CONFIG_FILE() {
    return join(this.CONFIG_DIR, 'config.env');
  },
  get PROMPT_FILE() {
    return join(this.CONFIG_DIR, 'prompt.md');
  },
  get DB_FILE() {
    return join(this.DATA_DIR, 'custie.db');
  },
  get LOG_DIR() {
    return join(this.DATA_DIR, 'logs');
  },
  get UPLOADS_DIR() {
    return join(this.DATA_DIR, 'uploads');
  },
  get AUTOMATIONS_FILE() {
    return join(this.CONFIG_DIR, 'automations.yml');
  },
  get CHANNELS_FILE() {
    return join(this.CONFIG_DIR, 'channels.yml');
  },

  PACKAGE_ROOT: resolve(import.meta.dirname, '..'),
};

export function ensureDirs(): void {
  for (const dir of [paths.CONFIG_DIR, paths.DATA_DIR, paths.LOG_DIR, paths.UPLOADS_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
