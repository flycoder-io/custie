import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const home = homedir();

const XDG_CONFIG_HOME = process.env['XDG_CONFIG_HOME'] || join(home, '.config');
const XDG_DATA_HOME = process.env['XDG_DATA_HOME'] || join(home, '.local', 'share');

export const paths = {
  CONFIG_DIR: join(XDG_CONFIG_HOME, 'custie'),
  DATA_DIR: join(XDG_DATA_HOME, 'custie'),

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
  get AUTOMATIONS_FILE() {
    return join(this.CONFIG_DIR, 'automations.yml');
  },

  PACKAGE_ROOT: resolve(import.meta.dirname, '..'),
};

export function ensureDirs(): void {
  for (const dir of [paths.CONFIG_DIR, paths.DATA_DIR, paths.LOG_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
