/**
 * What a test puts in its home before it runs the CLI, and how it looks at
 * the home after: the Node forms of `custom_home`, `write_skill`,
 * `write_lock` and `snapshot_tree` of the Bash suite.
 *
 * These write and read files only. They never import a Nexus module, so the
 * CLI stays the one seam (Seam 1).
 */
import { lstatSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { newHome } from './nexus.ts';

/**
 * A test home with an empty Custom Root, both Native Skill Roots and the
 * Canonical Root, as `custom_home` makes it.
 */
export function customHome(name: string): string {
  const home = newHome(name);
  for (const dir of ['.custom-skills', '.claude/skills', '.codex/skills', '.agents/skills']) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  return home;
}

/** Write a skill directory `<dir>/<name>` with a `SKILL.md` that names it. */
export function writeSkill(dir: string, name: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}

/** Write a version-3 lock at `path` that names each skill, as `write_lock` does. */
export function writeLock(path: string, names: readonly string[]): void {
  const entry = {
    source: 'test',
    sourceType: 'local',
    sourceUrl: 'https://example.invalid/skills',
    skillFolderHash: 'test-hash',
    installedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const skills = Object.fromEntries(names.map((name) => [name, entry]));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ version: 3, ...entry, skills }, null, 2)}\n`);
}

/**
 * Every entry under `root` as `type|relative path|link target`, sorted by
 * byte order, as `snapshot_tree` prints it with `find -printf '%y|%P|%l'`.
 * Two equal snapshots mean nothing under the root was added, removed,
 * retyped or repointed. An absent root is the empty list.
 */
export function snapshotTree(root: string): readonly string[] {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      const stats = lstatSync(path);
      const target = stats.isSymbolicLink() ? readlinkSync(path) : '';
      lines.push(`${typeLetter(path)}|${relative}|${target}`);
      if (stats.isDirectory()) walk(path, relative);
    }
  };
  try {
    if (!lstatSync(root).isDirectory()) return [];
  } catch {
    return [];
  }
  walk(root, '');
  return lines.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

/** The letter `find -printf %y` gives the type of one entry. */
function typeLetter(path: string): string {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) return 'l';
  if (stats.isDirectory()) return 'd';
  if (stats.isFile()) return 'f';
  if (stats.isFIFO()) return 'p';
  if (stats.isSocket()) return 's';
  if (stats.isCharacterDevice()) return 'c';
  if (stats.isBlockDevice()) return 'b';
  return 'U';
}
