/**
 * `nexus install <source> --skill <name>...`: install the named skills from
 * one source through upstream `npx skills`, Publish the lock it wrote, and
 * link.
 *
 * Every refusal Nexus can make on its own comes before `npx` is started: a
 * bad argument, a malformed Custom Root, and a name a Custom Skill already
 * owns. So nothing is downloaded and no Upstream Lock is rewritten for an
 * install that could never be linked. A failed `npx` leaves the Nexus Lock as
 * it was, and names each skill directory it may have left behind, because
 * Nexus deletes nothing it does not own.
 *
 * The sentences and exit codes are the Bash CLI's (`scripts/lib/install.sh`).
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from './cli.ts';
import { isControlSkill } from './control-skills.ts';
import { customRootFault, readCustomSkills } from './custom.ts';
import { error, info } from './output.ts';
import { readPaths } from './paths.ts';
import { isSafeSkillName } from './skill-names.ts';
import { ensureNpx, publishUpstreamLock, runNpx } from './upstream.ts';

/** What the arguments of `install` ask for. */
type InstallRequest = {
  /** The one source, as `npx skills add` reads it. */
  readonly source: string;
  /** Each `--skill` name, in the order given. */
  readonly skills: readonly string[];
};

/** Install the named skills, and give the exit code. */
export const install: Command = async (args) => {
  const request = parseInstallArgs(args);
  if (typeof request === 'string') {
    error(request);
    return 2;
  }
  const paths = readPaths();

  const rootFault = customRootFault(paths);
  if (rootFault !== undefined) {
    error(rootFault);
    return 1;
  }
  const custom = readCustomSkills(paths);
  if (custom.errors.length > 0) {
    for (const sentence of custom.errors) error(sentence);
    return 1;
  }
  const customNames = new Set(custom.names);
  for (const name of request.skills) {
    if (customNames.has(name)) {
      const owner = join(paths.customRoot, name);
      error(`install skill collides with a custom skill: ${name} (${owner})`);
      return 1;
    }
  }

  const npx = ensureNpx(paths);
  if (npx === undefined) return 1;
  const status = runNpx(npx, [
    '--yes',
    'skills',
    'add',
    request.source,
    '--global',
    '--agent',
    'universal',
    ...request.skills.flatMap((name) => ['--skill', name]),
    '--yes',
  ]);
  if (status !== 0) {
    error(`upstream skill installation failed (status ${status})`);
    for (const name of request.skills) {
      const target = join(paths.canonicalRoot, name);
      if (isDirectory(target)) info(`untracked canonical skill directory: ${target}`);
    }
    return status;
  }

  if (publishUpstreamLock(paths) !== 0) return 1;
  for (const name of request.skills) {
    info(
      `installed ${name}: canonical ${join(paths.canonicalRoot, name)}; ` +
        `Claude ${join(paths.claudeSkills, name)}; Codex ${join(paths.codexSkills, name)}`,
    );
  }
  return 0;
};

/**
 * Read the arguments as `parse_install_args` does: the request, or the
 * sentence that refuses it. A word that starts with `-` is never a source and
 * never a skill name.
 */
function parseInstallArgs(args: readonly string[]): InstallRequest | string {
  let source = '';
  const skills: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;
    if (arg === '--skill') {
      index += 1;
      const name = args[index];
      if (
        name === undefined ||
        name.startsWith('-') ||
        !isSafeSkillName(name) ||
        isControlSkill(name)
      ) {
        return 'install requires --skill NAME with a safe, non-control skill name';
      }
      skills.push(name);
    } else if (arg.startsWith('-')) {
      return `unknown install flag: ${arg}`;
    } else {
      if (source !== '') return 'install accepts exactly one source';
      source = arg;
    }
  }
  if (source === '') return 'install requires one source';
  if (skills.length === 0) return 'install requires at least one --skill NAME';
  return { source, skills };
}

/** True when `path` is a directory, following a symlink (`-d`). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
