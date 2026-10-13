/**
 * `nexus remove <name>`: uninstall one Installed Skill through upstream
 * `npx skills remove`, Publish the lock it wrote, and link.
 *
 * Every refusal Nexus can make on its own comes before `npx` is started. A
 * failed `npx` leaves the Nexus Lock as it was, and an Upstream Lock that
 * still names the skill is never Published: a half-done removal must not
 * become the Nexus Lock. Removing the last Installed Skill Publishes a lock
 * that selects no skills. Nexus never deletes from the Canonical Root itself;
 * upstream owns it, so a directory upstream left behind is only named. The
 * sentences and exit codes are the Bash CLI's (`scripts/lib/remove.sh`).
 */
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from './cli.ts';
import { parseOneSkillName, readInstalledSkill } from './one-skill.ts';
import { error, info } from './output.ts';
import { readPaths } from './paths.ts';
import { ensureNpx, publishUpstreamLock, runNpx } from './upstream.ts';

/** Remove one Installed Skill, and give the exit code. */
export const remove: Command = async (args) => {
  const parsed = parseOneSkillName(args, {
    count: 'remove requires exactly one skill name',
    unsafe: (name) => `remove requires a safe skill name: ${name}`,
  });
  if ('refusal' in parsed) {
    error(parsed.refusal);
    return 2;
  }
  const { name } = parsed;
  const paths = readPaths();
  const installed = readInstalledSkill(
    paths,
    name,
    `remove refuses a custom skill: ${name}; ` +
      `delete ${join(paths.customRoot, name)} yourself and run link`,
  );
  if (!installed.ok) {
    for (const sentence of installed.errors) error(sentence);
    return 1;
  }

  const npx = ensureNpx(paths);
  if (npx === undefined) return 1;
  const status = runNpx(npx, ['--yes', 'skills', 'remove', name, '--global', '--yes']);
  if (status !== 0) {
    error(`upstream skill removal failed (status ${status})`);
    return status;
  }

  const published = publishUpstreamLock(paths, {
    check: (_snapshot, lock) =>
      lock.names.includes(name) ? `upstream lock still contains ${name}` : undefined,
    allowEmpty: true,
  });
  if (published !== 0) return 1;

  const target = join(paths.canonicalRoot, name);
  if (exists(target)) info(`untracked canonical skill directory: ${target}`);
  info(
    `removed ${name}: Claude ${join(paths.claudeSkills, name)} and ` +
      `Codex ${join(paths.codexSkills, name)} links reconciled`,
  );
  return 0;
};

/** True when anything is at `path`, a dangling symlink too (`-e || -L`). */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
