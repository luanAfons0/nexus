/**
 * Link and Bootstrap: make both Native Skill Roots and both Instruction Paths
 * hold the Managed Links to their Owners, and no other Managed Link.
 *
 * Link reads the Nexus Lock and the Custom Root, runs every Preflight before
 * any change, then removes Stale Links, makes or repoints one Managed Link
 * per desired skill and agent, and links each Instruction Path to
 * `GLOBAL.md`. A Foreign Entry is never claimed: at a skill path it is a
 * Collision, at an Instruction Path a notice. Bootstrap links the Control
 * Skills alone. One failed link does not stop the others; the count of
 * errors decides the exit code.
 *
 * This module is system-free: what a Managed Link is on disk is the Link
 * primitive's (`link-primitive.ts`). The sentences and their order are the
 * Bash CLI's (`put_link`, and its link and bootstrap commands).
 */
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Command } from './cli.ts';
import { CONTROL_SKILLS, controlSkillTarget, isControlSkill } from './control-skills.ts';
import {
  customCanonicalLinks,
  customCollisions,
  customRootFault,
  globalInstructionsFault,
  readCustomSkills,
} from './custom.ts';
import { reachesDirectory, reachesEntry, reachesFile } from './entries.ts';
import { fault, seamFailure } from './fault.ts';
import { globalInstructionsPresent } from './instructions.ts';
import { type LinkPrimitive, linkPrimitive } from './link-primitive.ts';
import { readLock, type SnapshotWatch } from './lock.ts';
import { error, info } from './output.ts';
import { type Paths, readPaths } from './paths.ts';
import { byteOrder, isSafeSkillName } from './skill-names.ts';

/** The prefix of a recovery container, beside the entry a forced link moves. */
const RECOVERY_PREFIX = '.nexus-backup.';

/** Says errors, and counts them: the count is what a summary line reports. */
type Tally = {
  /** Say one error and count it. */
  readonly error: (message: string) => void;
  /** How many errors were said. */
  readonly count: () => number;
};

/** `nexus link`: Link every Managed Link the Nexus Lock and the Custom Root ask for. */
export const link: Command = async () => linkAll(readPaths(), false);

/** `nexus bootstrap`: link the Control Skills, and nothing else. */
export const bootstrap: Command = async () => {
  const paths = readPaths();
  const primitive = linkPrimitive(paths);
  const tally = newTally();
  for (const name of CONTROL_SKILLS) {
    const owner = controlSkillTarget(paths, name);
    putLink(primitive, tally, owner, join(paths.claudeSkills, name), false);
    putLink(primitive, tally, owner, join(paths.codexSkills, name), false);
  }
  if (tally.count() > 0) {
    error(`bootstrap failed with ${tally.count()} error(s)`);
    return 1;
  }
  info('bootstrap complete: control skills linked');
  return 0;
};

/**
 * Link both Native Skill Roots and both Instruction Paths, and give the
 * exit code. `force` is Setup's alone: it replaces a Foreign Entry at a
 * desired skill path, keeping it in a recovery container until the new link
 * is verified. Install, Update, Remove and `global edit` call this too.
 * Setup passes `watch`, so that a signal names the lock Snapshot as Residue.
 */
export function linkAll(paths: Paths, force: boolean, watch?: SnapshotWatch): number {
  const read = readLock(paths.lock, paths.nexusHome, watch);
  if (!read.ok) {
    for (const sentence of read.errors) error(sentence);
    return 1;
  }
  const lockNames = read.lock.names;

  // Preflight. A malformed Custom Root or an ambiguous desired set is a
  // configuration fault, not a failed link, so nothing changes until every
  // check has passed, and every fault is named in one run.
  const tally = newTally();
  for (const refusal of [customRootFault(paths), globalInstructionsFault(paths)]) {
    if (refusal !== undefined) tally.error(refusal);
  }
  const custom = readCustomSkills(paths);
  for (const sentence of custom.errors) tally.error(sentence);
  for (const sentence of customCanonicalLinks(paths)) tally.error(sentence);
  for (const sentence of customCollisions(paths, lockNames, custom.names)) tally.error(sentence);
  if (tally.count() > 0) {
    error(`link failed with ${tally.count()} error(s); no changes were made`);
    return 1;
  }

  const customSet = new Set(custom.names);
  const desired = new Set([...lockNames, ...custom.names, ...CONTROL_SKILLS]);
  if (![...desired].every(isSafeSkillName)) {
    error('invalid version-3 lock: unsafe desired skill name');
    return 1;
  }
  const names = [...desired].sort(byteOrder);
  const primitive = linkPrimitive(paths);

  removeStaleLinks(primitive, tally, paths.claudeSkills, desired);
  removeStaleLinks(primitive, tally, paths.codexSkills, desired);
  for (const name of names) {
    const owner = skillOwner(paths, customSet, name);
    const claude = join(paths.claudeSkills, name);
    const codex = join(paths.codexSkills, name);
    if (!reachesFile(join(owner, 'SKILL.md'))) {
      tally.error(`missing skill: ${name} (expected ${owner}/SKILL.md)`);
      removeManaged(primitive, tally, claude, 'missing managed link');
      removeManaged(primitive, tally, codex, 'missing managed link');
      continue;
    }
    putLink(primitive, tally, owner, claude, force);
    putLink(primitive, tally, owner, codex, force);
  }
  linkInstructionPaths(paths, primitive, tally);
  if (tally.count() > 0) {
    error(`link failed with ${tally.count()} error(s)`);
    return 1;
  }
  info('link complete: skills reconciled');
  return 0;
}

/**
 * The Global Instructions are owned by `GLOBAL.md` at the top of the Custom
 * Root, and each Instruction Path becomes a Managed Link to it. Three states
 * end in a notice, not an error (ADR 0003): the Owner is absent, a Foreign
 * Entry is at an Instruction Path, or the Agent Home is absent. A Foreign
 * Entry is kept and only that link is skipped; it is not a Collision. Nexus
 * never makes an Agent Home and never writes in the Custom Root.
 */
function linkInstructionPaths(paths: Paths, primitive: LinkPrimitive, tally: Tally): void {
  const present = globalInstructionsPresent(paths);
  if (!present) {
    info(
      `global instructions are absent: ${paths.globalInstructions} ` +
        '(create it and rerun link to link the Instruction Paths)',
    );
  }
  for (const path of [paths.claudeInstructions, paths.codexInstructions]) {
    const home = dirname(path);
    if (!reachesDirectory(home)) {
      info(`skipped ${path}: agent home is absent: ${home}`);
      continue;
    }
    if (!present) {
      removeManaged(primitive, tally, path, 'stale managed link');
      continue;
    }
    const entry = primitive.read(path);
    if (entry === 'foreign link' || entry === 'foreign') {
      info(
        `foreign entry at ${path}: preserved; to manage it, run: ` +
          `mv ${path} ${paths.globalInstructions}, then rerun link`,
      );
      continue;
    }
    putLink(primitive, tally, paths.globalInstructions, path, false);
  }
}

/**
 * Remove every Managed Link in `dir` whose Skill Name is no longer desired.
 * Codex's `.system` and every Foreign Entry are left alone.
 */
function removeStaleLinks(
  primitive: LinkPrimitive,
  tally: Tally,
  dir: string,
  desired: ReadonlySet<string>,
): void {
  if (!reachesDirectory(dir)) return;
  for (const name of readdirSync(dir).sort(byteOrder)) {
    if (name === '.system' || desired.has(name)) continue;
    removeManaged(primitive, tally, join(dir, name), 'stale managed link');
  }
}

/** Remove the entry at `path` if it is a Managed Link, and say so as `what`. */
function removeManaged(primitive: LinkPrimitive, tally: Tally, path: string, what: string): void {
  if (primitive.read(path) !== 'managed') return;
  if (primitive.remove(path)) {
    info(`removed ${what}: ${path}`);
  } else {
    tally.error(`cannot remove ${what}: ${path}`);
  }
}

/**
 * Make `path` a Managed Link to `owner` (`put_link`). An entry that already
 * reaches the Owner is left as it is, silently. A Managed Link elsewhere is
 * repointed in one step. A Foreign Entry is a Collision, unless `force`.
 * Every failure is one counted sentence; true when the link is in place.
 */
function putLink(
  primitive: LinkPrimitive,
  tally: Tally,
  owner: string,
  path: string,
  force: boolean,
): boolean {
  const fail = (message: string): false => {
    tally.error(message);
    return false;
  };
  if (!reachesEntry(owner)) return fail(`missing link target: ${owner}`);
  const parent = dirname(path);
  try {
    mkdirSync(parent, { recursive: true });
  } catch {
    return fail(`cannot create parent: ${parent}`);
  }

  const entry = primitive.read(path);
  if (entry === 'managed' || entry === 'foreign link') {
    if (primitive.reaches(path, owner)) return true;
    if (!force && entry === 'foreign link') return fail(`collision at ${path} (external symlink)`);
  } else if (entry === 'foreign' && !force) {
    return fail(`collision at ${path}`);
  }

  const staged = primitive.stage(owner, path);
  if (!staged.ok) return fail(staged.error);
  if (entry === 'foreign') return replaceForeign(primitive, tally, owner, path, staged.path);
  if (!promote(primitive, tally, staged.path, path)) {
    primitive.discard(staged.path);
    return fail(`cannot install link: ${path}`);
  }
  if (!primitive.reaches(path, owner)) return fail(`link verification failed: ${path}`);
  return true;
}

/**
 * Setup's forced link over a Foreign Entry: move the entry into a fresh
 * recovery container beside it, promote the staged link, verify it, and
 * only then delete the entry. On any failure the entry goes back, or the
 * container is kept and named.
 */
function replaceForeign(
  primitive: LinkPrimitive,
  tally: Tally,
  owner: string,
  path: string,
  staged: string,
): boolean {
  const parent = dirname(path);
  const fail = (message: string): false => {
    tally.error(message);
    return false;
  };
  let container: string;
  try {
    container = mkdtempSync(join(parent, RECOVERY_PREFIX));
  } catch {
    primitive.discard(staged);
    return fail(`cannot reserve recovery container for ${path}`);
  }
  if (!isFreshContainer(container, parent)) {
    if (reachesDirectory(container)) tryRmdir(container);
    primitive.discard(staged);
    return fail(`invalid recovery container: ${container}`);
  }
  const retained = `recovery container retained: ${container}`;
  const original = join(container, 'original');
  if (!move(path, original)) {
    primitive.discard(staged);
    if (!tryRmdir(container)) tally.error(retained);
    return fail(`cannot stage existing collision: ${path}`);
  }
  if (!promote(primitive, tally, staged, path)) {
    if (!restore(tally, original, path)) {
      tally.error(retained);
      primitive.discard(staged);
      return false;
    }
    if (!tryRmdir(container)) tally.error(retained);
    primitive.discard(staged);
    return fail(`cannot install link: ${path}`);
  }
  if (!primitive.reaches(path, owner)) {
    if (!primitive.remove(path)) tally.error(`cannot remove incorrect link: ${path}`);
    if (!restore(tally, original, path)) return fail(retained);
    if (!tryRmdir(container)) tally.error(retained);
    return fail(`link verification failed: ${path}`);
  }
  try {
    rmSync(original, { recursive: true, force: true });
  } catch {
    return fail(retained);
  }
  if (!tryRmdir(container)) return fail(retained);
  return true;
}

/**
 * Put the staged link at `path` (Bash `stage_move "$tmp" "$link"`). The
 * fault points `stage`, `promote` and `restore` fail it.
 */
function promote(primitive: LinkPrimitive, tally: Tally, staged: string, path: string): boolean {
  if (fault('stage')) return seamFailure('staged link creation failed', tally.error);
  if (fault('promote', 'restore')) return seamFailure('staged move failed', tally.error);
  return primitive.promote(staged, path);
}

/**
 * Put a Foreign Entry back from its recovery container (Bash
 * `stage_move "$original" "$link"`). The fault points `stage` and `restore`
 * fail it.
 */
function restore(tally: Tally, original: string, path: string): boolean {
  if (fault('stage')) return seamFailure('staged link creation failed', tally.error);
  if (fault('restore')) return seamFailure('staged move failed', tally.error);
  return move(original, path);
}

/** True when `container` is an empty recovery container made in `parent`. */
function isFreshContainer(container: string, parent: string): boolean {
  return (
    dirname(container) === parent &&
    basename(container).startsWith(RECOVERY_PREFIX) &&
    reachesDirectory(container) &&
    readdirSync(container).length === 0
  );
}

/**
 * The Owner of a desired skill: the Control Skills' root, the Custom Root, or
 * the Canonical Root.
 */
function skillOwner(paths: Paths, customSet: ReadonlySet<string>, name: string): string {
  if (isControlSkill(name)) return controlSkillTarget(paths, name);
  return customSet.has(name) ? join(paths.customRoot, name) : join(paths.canonicalRoot, name);
}

/** Rename `from` to `to`; false when it failed. */
function move(from: string, to: string): boolean {
  try {
    renameSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/** Remove the empty directory `dir`; false when it failed or was not empty. */
function tryRmdir(dir: string): boolean {
  try {
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

function newTally(): Tally {
  let count = 0;
  return {
    error(message) {
      error(message);
      count += 1;
    },
    count: () => count,
  };
}
