// Skill discovery. The Claude CLI resolves skills from a few well-known
// locations; Custie scans the same directories so it can list them in Slack
// without spawning the CLI. Discovery is a plain filesystem walk — fast, no
// token cost — so it is safe to run inside a slash command's 3-second ack.

import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import yaml from 'js-yaml';

export type SkillSource = 'user' | 'project' | 'plugin';

export interface Skill {
  name: string;
  description: string;
  source: SkillSource;
}

/** Default Claude config dir used when `CLAUDE_CONFIG_DIR` is unset. */
function defaultConfigDir(): string {
  return join(homedir(), '.claude');
}

/** Expand a leading `~` so a `CLAUDE_CONFIG_DIR` like `~/.claude` resolves. */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Parse the YAML frontmatter (`name`, `description`) of a SKILL.md file. */
function parseFrontmatter(file: string): { name?: string; description?: string } {
  let content: string;
  try {
    content = readFileSync(file, 'utf-8');
  } catch {
    return {};
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    const fm = yaml.load(match[1]!) as Record<string, unknown> | null;
    const name = typeof fm?.['name'] === 'string' ? fm['name'] : undefined;
    const description = typeof fm?.['description'] === 'string' ? fm['description'] : undefined;
    return { name, description };
  } catch {
    return {};
  }
}

/**
 * Recursively collect `SKILL.md` paths under `root`, bounded by `maxDepth`.
 * Hidden directories and `node_modules` are skipped to keep the walk cheap.
 */
function findSkillFiles(root: string, maxDepth: number, out: string[]): void {
  if (maxDepth < 0 || !existsSync(root)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      if (entry.name === 'SKILL.md') out.push(join(root, entry.name));
    } else if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      findSkillFiles(join(root, entry.name), maxDepth - 1, out);
    }
  }
}

/** Collect skills found under `root`, tagging each with `source`. */
function collectFrom(root: string, source: SkillSource, maxDepth: number): Skill[] {
  const files: string[] = [];
  findSkillFiles(root, maxDepth, files);
  return files.map((file) => {
    const fm = parseFrontmatter(file);
    // Fall back to the containing directory name when frontmatter has no name.
    const name = fm.name?.trim() || basename(dirname(file));
    return { name, description: (fm.description ?? '').trim(), source };
  });
}

/**
 * List the skills available to the Claude CLI for a given working directory.
 * Scans project skills, user skills, and plugin skills, then dedupes by name
 * (project beats user beats plugin) and sorts alphabetically.
 */
export function listSkills(configDir: string | undefined, cwd: string): Skill[] {
  const base = configDir ? expandHome(configDir) : defaultConfigDir();

  const collected = [
    ...collectFrom(join(cwd, '.claude', 'skills'), 'project', 2),
    ...collectFrom(join(base, 'skills'), 'user', 2),
    ...collectFrom(join(base, 'plugins'), 'plugin', 8),
  ];

  const byName = new Map<string, Skill>();
  for (const skill of collected) {
    if (skill.name && !byName.has(skill.name)) byName.set(skill.name, skill);
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
