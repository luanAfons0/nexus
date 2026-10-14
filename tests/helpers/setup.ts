/**
 * How a test looks at what Setup left in its home, and how it runs Setup.
 *
 * These read files and spawn programs only. They never import a Nexus
 * module, so the CLI stays the one seam (Seam 1).
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { newHome, runNexus, type Run } from './nexus.ts';

/** The names a Setup temp or recovery path starts with (`assert_no_setup_residue`). */
const RESIDUE_PREFIXES: readonly string[] = [
  '.nexus-lock.',
  '.nexus-setup-backup.',
  '.nexus-setup-lock.',
  '.nexus-setup-source.',
  '.nexus-setup-copy.',
  '.nexus-canonical-tmp.',
  '.nexus-canonical-old.',
];

/**
 * Every path within three levels under `home` whose name a Setup temp or
 * recovery path has, as `assert_no_setup_residue` looks for them. Empty when
 * Setup left nothing.
 */
export function setupResidue(home: string, prefixes = RESIDUE_PREFIXES): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (prefixes.some((prefix) => name.startsWith(prefix))) found.push(path);
      if (isDirectory(path)) walk(path, depth + 1);
    }
  };
  walk(home, 1);
  return found;
}

/** What one run of Setup left: the run, and the home it ran in. */
export type SetupRun = { readonly home: string; readonly run: Run };

/** Make a home with `build`, run Setup on it, and give back both. */
export function runSetup(name: string, build: (home: string) => void): SetupRun {
  const home = newHome(name);
  build(home);
  return { home, run: runNexus(home, ['setup']) };
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
