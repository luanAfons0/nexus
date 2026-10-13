/**
 * The Global Instructions as Nexus reports them: whether the Owner,
 * `GLOBAL.md`, is present, and the state of each Instruction Path.
 *
 * Reading only. An Instruction Path is in one of four states: `linked` (a
 * Managed Link that resolves to the Owner), `foreign` (anything else there),
 * `absent` (nothing there, Agent Home present) or `no home` (the Agent Home
 * is absent). The words and the JSON shape are the Bash CLI's
 * (`instruction_path_state` in `scripts/lib/list.sh`, `global_instructions_json`
 * in `scripts/lib/global.sh`), which `list --json`, `global show --json` and
 * the Plugin Page read.
 */
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Paths } from './paths.ts';

/** The state of one Instruction Path. */
export type InstructionPathState = 'no home' | 'absent' | 'linked' | 'foreign';

/** The Global Instructions as one JSON object. */
export type GlobalInstructions = {
  /** The path of the Owner, `GLOBAL.md`, present or not. */
  readonly owner: string;
  /** True when the Owner is a regular file. */
  readonly present: boolean;
  /** The SHA-256 of the Owner's bytes, in hex, or null when it is absent. */
  readonly sha256: string | null;
  /** The Owner's text; only when it was asked for, and null when absent. */
  readonly content?: string | null;
  /** The state of Claude's Instruction Path. */
  readonly claude: InstructionPathState;
  /** The state of Codex's Instruction Path. */
  readonly codex: InstructionPathState;
};

/** True when the Owner of the Global Instructions is a regular file. */
export function globalInstructionsPresent(paths: Paths): boolean {
  try {
    return lstatSync(paths.globalInstructions).isFile();
  } catch {
    return false;
  }
}

/** The state of the Instruction Path `path`, whose Owner is `owner`. */
export function instructionPathState(path: string, owner: string): InstructionPathState {
  if (!isDirectory(dirname(path))) return 'no home';
  let isLink: boolean;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return 'absent';
  }
  return isLink && resolvesTo(path, owner) ? 'linked' : 'foreign';
}

/**
 * The Global Instructions as one object, in the key order the Bash CLI
 * writes: `owner, present, sha256, [content,] claude, codex`. `list --json`
 * leaves `content` out; `global show --json` puts it in.
 */
export function readGlobalInstructions(paths: Paths, withContent: boolean): GlobalInstructions {
  const bytes = globalInstructionsPresent(paths) ? readFileSync(paths.globalInstructions) : null;
  const sha256 = bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
  const owner = paths.globalInstructions;
  const claude = instructionPathState(paths.claudeInstructions, owner);
  const codex = instructionPathState(paths.codexInstructions, owner);
  if (!withContent) return { owner, present: bytes !== null, sha256, claude, codex };
  // Invalid UTF-8 becomes U+FFFD, as `jq -Rs` reads it.
  const content = bytes === null ? null : bytes.toString('utf8');
  return { owner, present: bytes !== null, sha256, content, claude, codex };
}

/** The last line of `nexus list`: the Owner and both Instruction Paths. */
export function globalInstructionsLine(paths: Paths): string {
  const owner = globalInstructionsPresent(paths)
    ? paths.globalInstructions
    : `absent (${paths.globalInstructions})`;
  const claude = instructionPathState(paths.claudeInstructions, paths.globalInstructions);
  const codex = instructionPathState(paths.codexInstructions, paths.globalInstructions);
  return `global instructions: ${owner} (claude: ${claude}, codex: ${codex})`;
}

/** True when `path` is a directory, following a symlink (`-d`). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when both paths exist and resolve to the same place (`realpath -e`). */
function resolvesTo(path: string, target: string): boolean {
  try {
    return realpathSync.native(path) === realpathSync.native(target);
  } catch {
    return false;
  }
}
