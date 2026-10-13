/**
 * What a fault point changes, by the name of its fault: the files a Bash
 * override touched, moved or corrupted with `touch`, `chmod`, `ln` and `mv`.
 *
 * The names of the files here are the ones the fault cases' homes hold
 * (`tests/setup-faults.test.ts`). They live here, and not at the fault
 * points, so the code under test holds one `if (fault(...))` line per point
 * and knows no fixture. `faultChange` in `fault.ts` runs one of these only
 * for the fault a run honours.
 */
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** One change: the path it is made at, and the Backup's attempt (1 or 2). */
type Change = (path: string, attempt: number) => void;

/** A time the changes write: `2026-01-01 00:00:00.987654321`, local, as `touch -d`. */
const LATE = new Date(2026, 0, 1).getTime() / 1000 + 0.987654321;

/** A whole second the changes write: 2026-01-01T00:00:00Z. */
const WHOLE_SECOND = Date.UTC(2026, 0, 1) / 1000;

/** Each change, by the fault it belongs to. */
export const FAULT_CHANGES: Readonly<Record<string, Change>> = {
  // An Agent Home that changes while the Backup copies it.
  backup_source_content: (home) => {
    writeFileSync(join(home, 'payload'), 'changed');
    utimesSync(join(home, 'payload'), WHOLE_SECOND, WHOLE_SECOND);
  },
  backup_retry_once: (home) => appendFileSync(join(home, 'retry-marker'), 'retry-state\n'),
  backup_retry_always: (home, attempt) => {
    appendFileSync(join(home, 'retry-marker'), `unstable-${attempt}\n`);
  },
  backup_source_mode: (home) => chmodSync(join(home, 'payload'), 0o640),
  backup_source_time: (home) => utimesSync(join(home, 'payload'), WHOLE_SECOND, WHOLE_SECOND),
  backup_source_symlink: (home) => {
    unlinkSync(join(home, 'line\nlink'));
    symlinkSync('other\n', join(home, 'line\nlink'));
  },
  backup_source_relink: (home) => {
    unlinkSync(join(home, 'hardlink'));
    copyFileSync(join(home, 'payload'), join(home, 'hardlink'));
  },

  // A Backup copy that is not the tree it copied.
  backup_copy_corrupt: (copy) => writeFileSync(join(copy, 'corrupt'), 'corrupt'),
  backup_root_corrupt: (copy) => {
    chmodSync(copy, 0o700);
    utimesSync(copy, LATE, LATE);
  },
  backup_child_corrupt: (copy) => {
    appendFileSync(join(copy, 'child'), ''); // `touch` makes a missing file.
    utimesSync(join(copy, 'child'), LATE, LATE);
  },
  backup_symlink_corrupt: (copy) => {
    tryChange(() => unlinkSync(join(copy, 'trailing-newline-link')));
    symlinkSync('literal-target', join(copy, 'trailing-newline-link'));
  },

  // A Backup path, or a promoted Backup, that something else took.
  backup_destination_empty: (backup) => mkdirSync(backup),
  backup_destination_full: (backup) => {
    mkdirSync(backup);
    writeFileSync(join(backup, 'occupant'), 'occupant\n');
  },
  backup_final_corrupt: (backup) => tryChange(() => chmodSync(join(backup, '.hidden'), 0o600)),
  backup_promote_ambiguous: (backup) => {
    renameSync(backup, `${backup}.unknown`);
    mkdirSync(backup);
  },

  // A Canonical Root entry that something else took after its validation.
  canonical_late_collision: (entry) => {
    unlinkSync(entry);
    writeFileSync(entry, 'late collision\n');
  },
  canonical_late_repoint: (entry) => {
    unlinkSync(entry);
    symlinkSync(join(homedir(), 'elsewhere'), entry, 'junction');
  },
  canonical_destination_empty: (entry) => mkdirSync(entry),

  // A published Nexus Lock that changed after its publication.
  lock_post_publish_corrupt: (lock) => writeFileSync(lock, 'corrupt'),
};

/**
 * Make one change of a fault as the shell command of the Bash override made
 * it: a change that fails stops nothing (the command's own line is not said).
 */
export function tryChange(change: () => void): void {
  try {
    change();
  } catch {
    // As `chmod` or `rm` that failed inside the override: the override went on.
  }
}
