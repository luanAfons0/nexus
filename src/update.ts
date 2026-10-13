/**
 * `nexus update <name>`: update one Installed Skill through upstream
 * `npx skills update`, Publish the lock it wrote, and link.
 *
 * Every refusal Nexus can make on its own comes before `npx` is started. A
 * failed `npx` leaves the Nexus Lock as it was, and an Upstream Lock that no
 * longer names the skill is never Published (ADR 0001). The sentences and
 * exit codes are the Bash CLI's.
 */
import { join } from 'node:path';
import type { Command } from './cli.ts';
import { compactJson } from './json.ts';
import { lockField, type NexusLock } from './lock.ts';
import { parseOneSkillName, readInstalledSkill } from './one-skill.ts';
import { error, info } from './output.ts';
import { readPaths } from './paths.ts';
import { ensureNpx, publishUpstreamLock, runNpx } from './upstream.ts';

/** Update one Installed Skill, and give the exit code. */
export const update: Command = async (args) => {
  const parsed = parseOneSkillName(args, {
    count: 'update requires exactly one skill name',
    unsafe: () => 'update requires a safe skill name',
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
    `update refuses a custom skill: ${name} (${join(paths.customRoot, name)}); ` +
      'pull it in the custom root and run link',
  );
  if (!installed.ok) {
    for (const sentence of installed.errors) error(sentence);
    return 1;
  }
  const oldHash = folderHash(installed.lock, name);

  const npx = ensureNpx(paths);
  if (npx === undefined) return 1;
  const status = runNpx(npx, ['--yes', 'skills', 'update', name, '--global', '--yes']);
  if (status !== 0) {
    error(`upstream skill update failed (status ${status})`);
    return status;
  }

  // The lock that passes the check is the one Published, byte for byte.
  let published: NexusLock | undefined;
  const check = (_snapshot: string, lock: NexusLock): string | undefined => {
    published = lock;
    return lock.names.includes(name) ? undefined : `upstream lock no longer contains ${name}`;
  };
  if (publishUpstreamLock(paths, { check }) !== 0) return 1;
  const newHash = published === undefined ? 'unknown' : folderHash(published, name);
  info(
    `updated ${name}: hash ${oldHash} -> ${newHash}; ` +
      `canonical ${join(paths.canonicalRoot, name)}; ` +
      `Claude ${join(paths.claudeSkills, name)}; Codex ${join(paths.codexSkills, name)}`,
  );
  return 0;
};

/**
 * The skill's `skillFolderHash`, as `update_lock_hash` reads it with
 * `jq -r '... // "unknown"'`: `unknown` when the lock has none or it is
 * empty, and the JSON of a value that is not a string.
 */
function folderHash(lock: NexusLock, name: string): string {
  const hash = lockField(lock, name, 'skillFolderHash');
  if (hash === undefined || hash === '') return 'unknown';
  return typeof hash === 'string' ? hash : compactJson(hash);
}
