/**
 * What `update`, `remove` and `new` share: each takes exactly one Skill Name,
 * and `update` and `remove` act only on an Installed Skill.
 *
 * Every refusal here comes before `npx` is looked for, so a name Nexus cannot
 * own never reaches upstream and no Upstream Lock is rewritten. Like the
 * other shared modules this prints nothing: it gives the sentences, and the
 * command prints them. The sentences are the Bash CLI's, for update, remove
 * and new.
 */
import { isControlSkill } from './control-skills.ts';
import { customRootFault, readCustomSkills } from './custom.ts';
import { type LockRead, readLock } from './lock.ts';
import type { Paths } from './paths.ts';
import { isSafeSkillName } from './skill-names.ts';

/** The sentences one command refuses its arguments with. */
export type NameSentences = {
  /** Said when there is not exactly one argument. */
  readonly count: string;
  /** Said for a name that starts with `-` or is not safe. */
  readonly unsafe: (name: string) => string;
};

/**
 * Read the one Skill Name in `args`, as `parse_update_args` and its twins
 * do: the name, or the sentence that refuses it with exit 2.
 */
export function parseOneSkillName(
  args: readonly string[],
  sentences: NameSentences,
): { readonly name: string } | { readonly refusal: string } {
  const [name] = args;
  if (args.length !== 1 || name === undefined) return { refusal: sentences.count };
  if (name.startsWith('-') || !isSafeSkillName(name)) return { refusal: sentences.unsafe(name) };
  if (isControlSkill(name)) return { refusal: `reserved control skill name: ${name}` };
  return { name };
}

/**
 * Read the Nexus Lock and accept `name` only as an Installed Skill: the
 * Custom Root must be sound, `name` must be no Custom Skill (`customRefusal`
 * says why not), and the lock must name it. Gives the lock, or the
 * sentences that refuse with exit 1.
 */
export function readInstalledSkill(paths: Paths, name: string, customRefusal: string): LockRead {
  const rootFault = customRootFault(paths);
  if (rootFault !== undefined) return { ok: false, errors: [rootFault] };
  const custom = readCustomSkills(paths);
  if (custom.errors.length > 0) return { ok: false, errors: custom.errors };
  if (custom.names.includes(name)) return { ok: false, errors: [customRefusal] };
  const read = readLock(paths.lock, paths.nexusHome);
  if (!read.ok) return read;
  if (!read.lock.names.includes(name)) {
    return { ok: false, errors: [`skill is not installed: ${name}`] };
  }
  return read;
}
