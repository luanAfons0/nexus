/**
 * The Custom Root as the manifest of Custom Skills (ADR 0002).
 *
 * There is no lock: the listing is the manifest. Every visible directory at
 * the top of the Custom Root must be a valid Custom Skill with a real
 * `SKILL.md`; dot entries (`.git`, `.workspaces`) and top-level files
 * (`README.md`, `GLOBAL.md`) are furniture and are skipped; anything else is
 * a fault that names its path. Nexus only reads here, and never runs Git.
 * The sentences are the Bash CLI's (`scripts/lib/custom.sh`).
 */
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isControlSkill } from './control-skills.ts';
import type { Paths } from './paths.ts';
import { isWithin, realpathMissing, resolvedLinkTarget } from './real-paths.ts';
import { byteOrder, isSafeSkillName } from './skill-names.ts';

/** The Custom Skills the Custom Root holds, and every fault found on the way. */
export type CustomSkills = {
  /** The name of each valid Custom Skill, in byte order. */
  readonly names: readonly string[];
  /** One sentence per entry that is not a valid Custom Skill. Empty when none. */
  readonly errors: readonly string[];
};

/**
 * The fault of a Custom Root that exists but is not a physical directory, or
 * undefined. An absent Custom Root is no fault: it holds no Custom Skill.
 */
export function customRootFault(paths: Paths): string | undefined {
  const stats = lstatOrUndefined(paths.customRoot);
  if (stats === undefined || stats.isDirectory()) return undefined;
  return `custom skill root must be a physical directory: ${paths.customRoot}`;
}

/**
 * The fault of a Global Instructions Owner that exists but is not a regular
 * file, or undefined. An absent or empty `GLOBAL.md` is no fault (ADR 0003).
 */
export function globalInstructionsFault(paths: Paths): string | undefined {
  const path = paths.globalInstructions;
  const stats = lstatOrUndefined(path);
  if (stats === undefined || stats.isFile()) return undefined;
  if (stats.isSymbolicLink()) {
    return `global instructions must be a regular file, not a symlink: ${path}`;
  }
  if (stats.isDirectory()) {
    return `global instructions must be a regular file, not a directory: ${path}`;
  }
  return `global instructions must be a regular file: ${path}`;
}

/**
 * Read the Custom Skills. Each bad entry adds one sentence and the scan goes
 * on, so one run names every fault; the valid names are still given, because
 * Link checks them for a Collision in the same Preflight.
 */
export function readCustomSkills(paths: Paths): CustomSkills {
  const root = paths.customRoot;
  if (lstatOrUndefined(root)?.isDirectory() !== true) return { names: [], errors: [] };
  const names: string[] = [];
  const errors: string[] = [];
  const entries = readdirSync(root).filter((name) => !name.startsWith('.')).sort(byteOrder);
  for (const name of entries) {
    const child = join(root, name);
    const stats = lstatOrUndefined(child);
    if (stats === undefined) continue;
    if (stats.isSymbolicLink()) {
      errors.push(`custom skill entry must not be a symlink: ${child}`);
    } else if (stats.isFile()) {
      continue;
    } else if (!stats.isDirectory()) {
      errors.push(`unexpected entry in custom skill root: ${child}`);
    } else if (!isSafeSkillName(name)) {
      errors.push(`unsafe custom skill name: ${child}`);
    } else if (isControlSkill(name)) {
      errors.push(`reserved control skill name in custom skill root: ${child}`);
    } else if (lstatOrUndefined(join(child, 'SKILL.md'))?.isFile() !== true) {
      errors.push(`custom skill is missing SKILL.md: ${join(child, 'SKILL.md')}`);
    } else {
      names.push(name);
    }
  }
  return { names, errors };
}

/**
 * One sentence per Collision of a Custom Skill with an Installed Skill: two
 * Owners for one Skill Name, which no field can settle (ADR 0002).
 */
export function customCollisions(
  paths: Paths,
  lockNames: readonly string[],
  customNames: readonly string[],
): readonly string[] {
  const installed = new Set(lockNames);
  return customNames
    .filter((name) => installed.has(name))
    .map(
      (name) =>
        `custom skill collides with an installed skill: ${name} ` +
        `(${join(paths.customRoot, name)} and ${join(paths.canonicalRoot, name)})`,
    );
}

/**
 * One sentence per link in the Canonical Root that reaches into the Custom
 * Root (`custom_canonical_preflight`). A Custom Skill is owned by the Custom
 * Root alone; reached through the Canonical Root it would have two Owners.
 * Dot entries count too.
 */
export function customCanonicalLinks(paths: Paths): readonly string[] {
  const canonical = paths.canonicalRoot;
  if (!isDirectory(canonical)) return [];
  let customRoot: string;
  try {
    customRoot = realpathMissing(paths.customRoot);
  } catch {
    return [];
  }
  const sentences: string[] = [];
  for (const name of readdirSync(canonical).sort(byteOrder)) {
    const child = join(canonical, name);
    if (lstatOrUndefined(child)?.isSymbolicLink() !== true) continue;
    const resolved = resolvedLinkTarget(child);
    if (resolved === undefined || !isWithin(resolved, customRoot)) continue;
    sentences.push(
      `custom skill link in canonical root: ${child} -> ${resolved} ` +
        `(remove it; custom skills are owned by ${paths.customRoot})`,
    );
  }
  return sentences;
}

/** True when `path` is a directory, following a symlink (`-d`). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}
