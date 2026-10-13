/**
 * Every path Nexus reads or writes, built once from the home directory.
 *
 * The home directory comes from `os.homedir()`, which reads `HOME` on Linux
 * and macOS and `USERPROFILE` on Windows, so one test home moves all of it.
 * `NEXUS_HOME` moves the Nexus home alone; empty means unset, as the Bash
 * CLI's `${NEXUS_HOME:-$HOME/.nexus}` reads it. Each path is the Bash CLI's
 * (`nexus_init`), built with `node:path`.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where Nexus finds and keeps everything. */
export type Paths = {
  /** The home directory. */
  readonly home: string;
  /** The Nexus home: `~/.nexus`, or `NEXUS_HOME`. */
  readonly nexusHome: string;
  /** The Nexus Lock: `<Nexus home>/skill-lock.json`. */
  readonly lock: string;
  /** The Check Result, beside the lock and never part of it. */
  readonly checkResult: string;
  /** The Owner of the Control Skills: `<Nexus home>/skills`. */
  readonly controlRoot: string;
  /** The Canonical Root: `~/.agents/skills`. */
  readonly canonicalRoot: string;
  /** The Upstream Lock that `npx skills` writes: `~/.agents/.skill-lock.json`. */
  readonly upstreamLock: string;
  /** The Custom Root: `~/.custom-skills`. */
  readonly customRoot: string;
  /** Where a Custom Skill's workspace goes: `<Custom Root>/.workspaces`. */
  readonly customWorkspaces: string;
  /** The Owner of the Global Instructions: `<Custom Root>/GLOBAL.md`. */
  readonly globalInstructions: string;
  /** Claude's Native Skill Root: `~/.claude/skills`. */
  readonly claudeSkills: string;
  /** Codex's Native Skill Root: `~/.codex/skills`. */
  readonly codexSkills: string;
  /** Claude's Instruction Path: `~/.claude/CLAUDE.md`. */
  readonly claudeInstructions: string;
  /** Codex's Instruction Path: `~/.codex/AGENTS.md`. */
  readonly codexInstructions: string;
};

/** Read every path from the home directory and the environment. */
export function readPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = homedir();
  const nexusHome = env.NEXUS_HOME === undefined || env.NEXUS_HOME === ''
    ? join(home, '.nexus')
    : env.NEXUS_HOME;
  const customRoot = join(home, '.custom-skills');
  return {
    home,
    nexusHome,
    lock: join(nexusHome, 'skill-lock.json'),
    checkResult: join(nexusHome, 'skill-check.json'),
    controlRoot: join(nexusHome, 'skills'),
    canonicalRoot: join(home, '.agents', 'skills'),
    upstreamLock: join(home, '.agents', '.skill-lock.json'),
    customRoot,
    customWorkspaces: join(customRoot, '.workspaces'),
    globalInstructions: join(customRoot, 'GLOBAL.md'),
    claudeSkills: join(home, '.claude', 'skills'),
    codexSkills: join(home, '.codex', 'skills'),
    claudeInstructions: join(home, '.claude', 'CLAUDE.md'),
    codexInstructions: join(home, '.codex', 'AGENTS.md'),
  };
}
