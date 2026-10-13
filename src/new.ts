/**
 * `nexus new <name>`: reserve one Custom Skill directory in the Custom Root.
 *
 * It makes one empty directory and names it, with the workspace path its
 * evaluations go to. It writes no `SKILL.md` and does not link: the skill is
 * written next, and `nexus link` links it once it has a `SKILL.md` (the
 * `nexus-new` Control Skill runs both). It never creates the Custom Root,
 * which is the person's Git repository (ADR 0002). The sentences and exit
 * codes are the Bash CLI's (`scripts/lib/new.sh`).
 */
import { lstatSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from './cli.ts';
import { customRootFault } from './custom.ts';
import { readLock } from './lock.ts';
import { parseOneSkillName } from './one-skill.ts';
import { error, info } from './output.ts';
import { readPaths } from './paths.ts';

/** Reserve one Custom Skill directory, and give the exit code. */
export const newSkill: Command = async (args) => {
  const parsed = parseOneSkillName(args, {
    count: 'new requires exactly one skill name',
    unsafe: () => 'new requires a safe skill name',
  });
  if ('refusal' in parsed) {
    error(parsed.refusal);
    return 2;
  }
  const { name } = parsed;
  const paths = readPaths();

  const rootFault = customRootFault(paths);
  if (rootFault !== undefined) {
    error(rootFault);
    return 1;
  }
  if (!isDirectory(paths.customRoot)) {
    error(
      `custom skill root does not exist: ${paths.customRoot} ` +
        '(create it and run git init before adding custom skills)',
    );
    return 1;
  }
  if (isFile(paths.lock)) {
    const read = readLock(paths.lock, paths.nexusHome);
    if (!read.ok) {
      for (const sentence of read.errors) error(sentence);
      return 1;
    }
    if (read.lock.names.includes(name)) {
      error(
        `name collides with an installed skill: ${name} (${join(paths.canonicalRoot, name)})`,
      );
      return 1;
    }
  }
  const target = join(paths.customRoot, name);
  if (exists(target)) {
    error(`custom skill already exists: ${target}`);
    return 1;
  }
  try {
    mkdirSync(target);
  } catch {
    error(`cannot create custom skill directory: ${target}`);
    return 1;
  }
  info(`created ${name}: ${target}`);
  info(`workspace ${name}: ${join(paths.customWorkspaces, name)}`);
  return 0;
};

/** True for a directory, following a symlink (`-d`). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True for a regular file, following a symlink (`-f`). */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when anything is at `path`, a dangling symlink too (`-e || -L`). */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
