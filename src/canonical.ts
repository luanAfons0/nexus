/**
 * Setup's work on the Canonical Root, `~/.agents/skills`: each Installed
 * Skill whose entry there is a symlink becomes a physical copy of what it
 * reaches, so the Canonical Root owns its skills before Link points both
 * agents at them.
 *
 * A symlink is replaced only through steps that can be undone: its target
 * tree is validated (`skill-tree.ts`), copied with every link followed into
 * a temp beside it, the symlink is moved into a fresh recovery directory,
 * the copy is moved into its place, and only then is the symlink removed.
 * Each move is a rename onto nothing, and the move of the live entry checks
 * that it is still the entry that was validated (`identity.ts`, #67): an
 * entry that a person or a program put there meanwhile is a Foreign Entry,
 * and it is kept. Every failure leaves the symlink in place, or names the
 * recovery directory that holds it. The sentences are the Bash CLI's
 * (`scripts/lib/setup.sh`).
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { entryIdentity, reachedIdentity } from './identity.ts';
import { error } from './output.ts';
import type { Paths } from './paths.ts';
import { isWithin, realpathMissing } from './real-paths.ts';
import {
  type Checkpoint,
  isDirectory,
  isPhysicalDirectory,
  isPresent,
  isRegularFile,
  removeOwnedDir,
  type Residue,
} from './residue.ts';
import { listInSystemOrder, skillTreeFault } from './skill-tree.ts';
import { copyTree } from './tree-copy.ts';

/** The prefix of a materialization temp, in the Canonical Root. */
export const CANONICAL_TEMP_PREFIX = '.nexus-canonical-tmp.';

/** The prefix of a recovery directory for a moved symlink, in the Canonical Root. */
export const CANONICAL_RECOVERY_PREFIX = '.nexus-canonical-old.';

/**
 * The sentence that refuses Setup because `~/.agents` or the Canonical Root
 * is not a physical directory (`canonical_root_preflight`), or undefined.
 */
export function canonicalRootFault(paths: Paths): string | undefined {
  const agents = join(paths.home, '.agents');
  if (!isPhysicalDirectory(agents)) {
    return `canonical agent root must be a physical directory: ${agents}`;
  }
  if (isPresent(paths.canonicalRoot) && !isPhysicalDirectory(paths.canonicalRoot)) {
    return `canonical skills root must be a physical directory: ${paths.canonicalRoot}`;
  }
  return undefined;
}

/**
 * Materialize and validate the Canonical Root entry of every Skill Name in
 * `names` (`materialize_canonical_links`). False after the first failure,
 * which is said.
 */
export async function materializeCanonicalLinks(
  paths: Paths,
  names: readonly string[],
  residue: Residue,
  checkpoint: Checkpoint,
): Promise<boolean> {
  for (const name of names) {
    const ok = materializeCanonicalLink(paths, name, residue);
    await checkpoint();
    if (!ok) return false;
    const current = join(paths.canonicalRoot, name);
    if (!isPresent(current)) continue;
    if (!validateCanonicalSkill(paths, current)) return false;
  }
  return true;
}

/** Turn the symlink at one Canonical Root entry into a physical copy (`materialize_canonical_link`). */
function materializeCanonicalLink(paths: Paths, name: string, residue: Residue): boolean {
  const root = paths.canonicalRoot;
  const current = join(root, name);
  if (!isSymlink(current)) return true;
  const target = defaultRealpath(current);
  if (target === undefined) {
    error(
      `managed canonical skill is a broken symlink: ${current}; correct it, then run nexus link`,
    );
    return false;
  }
  if (!isPhysicalSkill(target)) {
    error(
      `managed canonical skill target lacks SKILL.md: ${current}; correct it, then run nexus link`,
    );
    return false;
  }
  const currentId = entryIdentity(current, true);
  if (currentId === undefined) {
    error(`cannot identify managed canonical skill: ${current}`);
    return false;
  }
  const fault = skillTreeFault(target);
  if (fault !== undefined) {
    process.stderr.write(`${fault}\n`);
    error(
      'cannot materialize canonical skill safely: nested source symlink is broken, cyclic, ' +
        `or escapes ${target}`,
    );
    return false;
  }
  try {
    mkdirSync(root, { recursive: true });
  } catch {
    error(`cannot create canonical directory: ${root}`);
    return false;
  }
  let temp: string;
  try {
    temp = mkdtempSync(join(root, CANONICAL_TEMP_PREFIX));
  } catch {
    error(`cannot reserve canonical materialization temp for ${current}`);
    return false;
  }
  residue.temp(temp);
  const dropTemp = (): void => {
    if (cleanupCanonicalTemp(root, temp)) residue.forget(temp);
    else error(`canonical temp retained: ${temp}`);
  };
  const copied = copyTree(target, temp, { dereference: true });
  if (!copied.ok) error(copied.error);
  if (!copied.ok || !isPhysicalSkill(temp)) {
    dropTemp();
    error(`cannot materialize canonical skill: ${current}`);
    return false;
  }
  let recovery: string;
  try {
    recovery = mkdtempSync(join(root, CANONICAL_RECOVERY_PREFIX));
  } catch {
    dropTemp();
    error(`cannot reserve canonical recovery for ${current}`);
    return false;
  }
  residue.recovery(recovery);
  const original = join(recovery, 'original');
  if (!canonicalMove(current, original, currentId)) {
    dropTemp();
    if (!tryRmdir(recovery)) error(`canonical recovery retained: ${recovery}`);
    error(`cannot stage canonical symlink: ${current}`);
    return false;
  }
  if (!canonicalMove(temp, current) || !isPhysicalSkill(current)) {
    const sameTree =
      isPhysicalDirectory(current) &&
      isDirectory(temp) &&
      reachedIdentity(current) === reachedIdentity(temp);
    if (sameTree) {
      if (!cleanupCanonicalTemp(root, current)) {
        error(`canonical staged current retained: ${current}`);
      }
    } else if (isPresent(current)) {
      error(
        `canonical promotion is ambiguous; retained current: ${current}; ` +
          `staged temp: ${temp}; recovery: ${recovery}`,
      );
      return false;
    }
    if (isDirectory(temp) && !cleanupCanonicalTemp(root, temp)) {
      residue.forget(temp);
      residue.recovery(temp);
      error(`canonical temp retained: ${temp}`);
    }
    if (!canonicalMove(original, current)) {
      error(`canonical recovery retained: ${recovery}`);
      return false;
    }
    if (!tryRmdir(recovery)) error(`canonical recovery retained: ${recovery}`);
    error(`cannot promote canonical skill: ${current}`);
    return false;
  }
  try {
    // `unlink`, not `rm`: on Windows only it removes a junction.
    unlinkSync(original);
  } catch {
    error(`canonical recovery retained: ${recovery}`);
    return false;
  }
  if (!tryRmdir(recovery)) {
    error(`canonical recovery retained: ${recovery}`);
    return false;
  }
  residue.forget(temp);
  residue.forget(recovery);
  return true;
}

/**
 * Move a Canonical Root entry to `destination`, which must be free
 * (`canonical_move`, `mv -Tn`). With `expected`, the entry must have that
 * identity before the move and after it; if it had not, the move is taken
 * back and refused, so an entry that took the place of the validated one is
 * never carried away.
 */
function canonicalMove(source: string, destination: string, expected?: string): boolean {
  if (expected !== undefined && entryIdentity(source, true) !== expected) return false;
  if (!moveOntoNothing(source, destination)) return false;
  if (expected !== undefined && entryIdentity(destination, true) !== expected) {
    if (!isPresent(source)) moveOntoNothing(destination, source);
    return false;
  }
  return !isPresent(source);
}

/** Rename `source` to `destination` when nothing is at `destination`; false otherwise. */
function moveOntoNothing(source: string, destination: string): boolean {
  if (isPresent(destination)) return false;
  try {
    renameSync(source, destination);
    return true;
  } catch {
    return false;
  }
}

/** Remove a materialization temp in the Canonical Root (`cleanup_canonical_temp`). */
function cleanupCanonicalTemp(root: string, temp: string): boolean {
  return removeOwnedDir(temp, root, CANONICAL_TEMP_PREFIX);
}

/**
 * Check a physical Canonical Root entry (`validate_canonical_skill`): a
 * physical `SKILL.md`, inside the Canonical Root, and every symlink in it
 * resolving inside the skill. False after the first fault, which is said.
 */
function validateCanonicalSkill(paths: Paths, skill: string): boolean {
  if (!isPhysicalDirectory(skill) || !isRegularFile(join(skill, 'SKILL.md'))) {
    error(`canonical skill must contain a physical SKILL.md: ${skill}`);
    return false;
  }
  const skillReal = realpathOf(skill);
  const file = realpathOf(join(skill, 'SKILL.md'));
  const root = realpathOf(paths.canonicalRoot);
  if (skillReal === undefined || file === undefined || root === undefined) return false;
  if (!isWithin(skillReal, root) || !isWithin(file, skillReal)) {
    error(`canonical skill escapes its physical tree: ${skill}`);
    return false;
  }
  const links = symlinksUnder(skill);
  if (links === undefined) {
    error(`cannot scan canonical skill symlinks: ${skill}`);
    return false;
  }
  for (const link of links) {
    const resolved = realpathOf(link);
    if (resolved === undefined) {
      error(`canonical skill has broken or cyclic symlink: ${link}`);
      return false;
    }
    if (!isWithin(resolved, skillReal)) {
      error(`canonical skill symlink escapes skill tree: ${link}`);
      return false;
    }
  }
  return true;
}

/**
 * Every symlink under `dir`, in the order `find -P dir -type l` lists them:
 * each directory's entries as the system lists them (`listInSystemOrder`),
 * depth first, no link followed. Undefined when a directory cannot be read.
 */
function symlinksUnder(dir: string): readonly string[] | undefined {
  const links: string[] = [];
  const visit = (path: string): boolean => {
    const entries = listInSystemOrder(Buffer.from(path));
    if (entries === undefined) return false;
    for (const entry of entries) {
      const child = `${path}${sep}${entry.name.toString()}`;
      if (entry.isSymbolicLink()) links.push(child);
      else if (entry.isDirectory() && !visit(child)) return false;
    }
    return true;
  };
  return visit(dir) ? links : undefined;
}

/**
 * Where the symlink at `path` leads, as GNU `realpath` with no option gives
 * it: every link followed, and only the last component may be missing.
 * Undefined when it cannot be resolved.
 */
function defaultRealpath(path: string): string | undefined {
  const existing = realpathOf(path);
  if (existing !== undefined) return existing;
  let resolved: string;
  try {
    resolved = realpathMissing(path);
  } catch {
    return undefined;
  }
  return isDirectory(dirname(resolved)) && realpathOf(dirname(resolved)) === dirname(resolved)
    ? resolved
    : undefined;
}

/** The physical path of `path`, every component existing (`realpath -e`); undefined otherwise. */
function realpathOf(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * A physical directory with a physical `SKILL.md`. Bash's `valid_physical_skill`
 * let `SKILL.md` be a symlink; it is only asked of a copy with every link
 * followed, where it never is one.
 */
function isPhysicalSkill(path: string): boolean {
  return isPhysicalDirectory(path) && isRegularFile(join(path, 'SKILL.md'));
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function tryRmdir(dir: string): boolean {
  try {
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}
