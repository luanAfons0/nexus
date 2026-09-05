# Nexus skill manager

Nexus gives Claude and Codex one explicit, recoverable owner for every skill.
Each skill has one kind and one owner: installed skills are owned by the
canonical root `~/.agents/skills`, custom skills by the custom root
`~/.custom-skills`, and control skills by `~/.nexus`. The Nexus lock
`~/.nexus/skill-lock.json` (gitignored) is authoritative for which installed
skills exist. The native Claude and Codex skill roots contain managed links,
relative symlinks into those owners. Anything else in a native skill root is a
foreign entry: a physical directory, a symlink to an unrelated place, or
Codex's `.system` directory. Nexus never claims or deletes a foreign entry.
The custom root also owns the global instructions, `~/.custom-skills/GLOBAL.md`,
which link places at each agent's instruction path as a managed link.
`CONTEXT.md` defines these terms.

## Requirements and first use

Project scripts use Bash 5, GNU coreutils, `jq`, and Python 3 (`python3`). Git
is needed for Git-based sources and normal development; npm/npx is an upstream
prerequisite for installation. Setup preflight checks `jq`, `python3`, and the
required core utilities; it does not check Git, npm, npx, or NVM. Install first
uses a directly available `npx`; if it is unavailable, NVM is the fallback.

From a shell, bootstrap only the control skills with:

```bash
~/.nexus/scripts/nexus bootstrap
```

Bootstrap exposes only the control skills `nexus-setup`, `nexus-link`,
`nexus-install`, `nexus-new`, `nexus-update`, `nexus-remove`, and `nexus-help`
in the native Claude/Codex skill roots. It does not run
setup, copy agent data, discover a lock, or install anything. Setup is always
an explicit operation.

Native invocation forms are:

| Operation | Claude | Codex |
| --- | --- | --- |
| Initialize | `/nexus-setup` | `$nexus-setup` |
| Reconcile links | `/nexus-link` | `$nexus-link` |
| Install selected skills | `/nexus-install` | `$nexus-install` |
| Create a custom skill | `/nexus-new` | `$nexus-new` |
| Update one skill | `/nexus-update` | `$nexus-update` |
| Remove one skill | `/nexus-remove` | `$nexus-remove` |
| Show skills or command help | `/nexus-help` | `$nexus-help` |

The equivalent CLI is `~/.nexus/scripts/nexus {setup,link,install,update,remove,new,list,help}`.

## Setup and recovery

Setup first performs preflight checks, then discovers candidate locks in
`~/.agents` or `~/.skills` (`.skill-lock.json` or `skill-lock.json`). It takes
an immutable snapshot and validates the exact version-3 lock before changing
anything. It creates complete, copy-based, no-clobber backups at
`~/.claude-backup` and `~/.codex-backup`; existing backups are never silently
overwritten. The agent homes remain in place. After backup verification, Nexus
publishes its lock, canonicalizes managed skill symlinks under the canonical
root, and links.

Backup verification covers mode, uid, gid, nanosecond mtime, content, hardlink
topology, and literal symlink targets. It does not promise ACL, xattr, atime,
or a globally atomic snapshot guarantee. If live agent state changes during a
backup, Nexus retries once and then removes the temporary transaction, leaves
live and published paths untouched, and asks you to close Claude/Codex and
retry. A setup failure after publication is deliberately
recoverable: the lock and backups are retained, and output points to
`/nexus-link` or `$nexus-link`. Review retained temporary or recovery paths
before retrying; do not delete them blindly.

Once `~/.nexus/skill-lock.json` exists, setup is disabled and reports that it
is already initialized. Use link afterward. If setup is
interrupted, reports an existing setup mutex, or reports retained residue,
review the named paths, correct the cause, and then run link. Backups are
manual recovery sources: copy only the needed files or directories from
`~/.claude-backup` or `~/.codex-backup` after inspection. Nexus never silently
replaces either backup.

## Link

`nexus link` treats the validated Nexus lock as authoritative. For each
installed skill, each custom skill, and each control skill it creates or
updates a managed link in each native skill root. It removes stale links and
reports skills whose owner has no `SKILL.md`. Foreign entries and collisions
are preserved rather than claimed or deleted. Correct a collision or a missing
skill and rerun link.

Link runs its preflight checks before it changes anything. A malformed custom
root, a name collision, a custom skill reachable through the canonical root,
or an invalid `GLOBAL.md` is a configuration fault, not a per-link failure, so
link reports the fault and leaves both agent roots exactly as they were.

After the skill links, link reconciles the two instruction paths against the
global instructions. See "Global instructions" below.

## Global instructions

Claude loads `~/.claude/CLAUDE.md` and Codex loads `~/.codex/AGENTS.md` at the
start of every session. These two files are the instruction paths. Nexus gives
them one owner: the regular file `~/.custom-skills/GLOBAL.md` at the top of
the custom root. Link places a relative managed link at each instruction path
that resolves to that file, so one edit reaches both agents and both read
byte-identical global instructions. The file is versioned in the custom root
Git repository you already control. Nexus never writes to, moves, or deletes
`GLOBAL.md`. The decision is recorded in
`docs/adr/0003-global-instructions-are-a-managed-link-into-the-custom-root.md`.

The owner is named `GLOBAL.md`, not `AGENTS.md`, because Codex loads an
`AGENTS.md` found in the working tree as project instructions. A file named
`AGENTS.md` at the top of the custom root would be loaded twice when you work
inside that repository. `GLOBAL.md` is a top-level regular file, so the custom
skill scan skips it as repository furniture; it is not a skill.

Migration is one manual step. Move your existing instruction file into the
custom root, make its wording agent-neutral, commit it, then run link:

```bash
mv ~/.claude/CLAUDE.md ~/.custom-skills/GLOBAL.md
~/.nexus/scripts/nexus link
```

Link reconciles each instruction path in this order, and the three skipped
states below are notices, not errors, so link still exits 0:

- The agent home (`~/.claude` or `~/.codex`) is absent: a notice, and that
  instruction path is skipped. Nexus never creates an agent home for the
  instruction link.
- `GLOBAL.md` is absent: one notice for the whole run names the expected path.
  Skills are still reconciled. A managed link at an instruction path is now a
  stale link and is removed; anything else there is left alone.
- `GLOBAL.md` exists and the instruction path is a foreign entry, that is a
  physical file, a symlink to an unrelated place, or a directory: a notice
  names the path and the exact move to make (`mv <path>
  ~/.custom-skills/GLOBAL.md`, then rerun link). The entry is preserved and
  only that link is skipped; the other instruction path is still linked. A
  foreign entry at an instruction path is deliberately not a collision, because
  a physical `CLAUDE.md` is the normal state before you migrate.
- `GLOBAL.md` exists and the instruction path is a managed link to another
  managed place: it is replaced by a link to `GLOBAL.md`.
- `GLOBAL.md` exists and the instruction path is a managed link to it: nothing
  happens and nothing is printed.
- `GLOBAL.md` exists and nothing is at the instruction path: the managed link
  is created.

An empty `GLOBAL.md` is valid and links silently. A `GLOBAL.md` that is a
symlink or a directory is a configuration fault: link reports it in preflight,
exits 1, and changes nothing in either native skill root or instruction path.
List fails with the same error.

`nexus list` ends with one line that shows the owner and the state of each
instruction path, so drift is visible without running link:

```
global instructions: /home/you/.custom-skills/GLOBAL.md (claude: linked, codex: foreign)
```

Each state is exactly one of `linked` (a managed link resolving to
`GLOBAL.md`), `foreign` (anything else at the path, including a managed link
that does not resolve to `GLOBAL.md`), `absent` (nothing at the path, agent
home present), or `no home` (agent home absent). When `GLOBAL.md` is missing
the line reads `global instructions: absent (<owner path>)` followed by the
same per-agent states.

Setup ends with link, so a fresh setup reaches the same state. Bootstrap links
only the control skills and never touches an instruction path.

## Custom skills

Custom skills are owned by the custom root `~/.custom-skills`, a Git
repository you control. Nexus does not use Git: it reads the directory only.
After a `git pull`, run link.

There is no custom lock file. The directory listing is the manifest. Nexus
reads every visible subdirectory of `~/.custom-skills`, and each one must have
a safe skill name and a real (not symlinked) `SKILL.md`. Entries beginning with `.` and
top-level regular files are repository furniture and are skipped, so `.git`,
`.gitignore`, `.workspaces`, `README.md`, and `GLOBAL.md` are ignored. Anything else is a
hard error that names the entry; Nexus does not skip an unexplained directory
silently.

`skill-creator` writes its evaluation output to a `<skill-name>-workspace`
directory beside the skill. In `~/.custom-skills` that directory has no
`SKILL.md` and is therefore an error, so custom skill workspaces belong in
`~/.custom-skills/.workspaces/<skill-name>` instead. Add `.workspaces/` to the
repository's `.gitignore`.

Create a custom skill with:

```bash
~/.nexus/scripts/nexus new skill-name
```

The command validates the name, refuses a name that collides with an installed
or control skill, refuses to create the root itself, creates one empty
directory, and prints the created path and the workspace path. It writes no
`SKILL.md`; `/nexus-new` hands the printed path to `skill-creator`, which
writes the contents, and then runs link.

A custom skill and an installed skill may not share a name. Link detects the
collision in preflight and changes nothing, and install refuses a colliding
`--skill` name before it calls upstream `npx skills`. A symlink under
`~/.agents/skills` that resolves into `~/.custom-skills` is also refused:
custom skill content is never reachable through the canonical root.

## Installing skills

Installation requires exactly one source and at least one repeated `--skill`
argument. Examples:

```bash
~/.nexus/scripts/nexus install owner/repository --skill review --skill testing
~/.nexus/scripts/nexus install https://github.com/owner/repository.git --skill review
~/.nexus/scripts/nexus install /path/to/local/skills --skill review
```

The source is passed as an argument to upstream `npx skills add`; Nexus never
evaluates install arguments as shell code. Upstream `npx skills` maintains its
own state (normally `~/.agents/.skill-lock.json`), but Nexus's
`~/.nexus/skill-lock.json` remains authoritative for link.
After upstream succeeds, Nexus snapshots and validates the produced lock and
the selected canonical `SKILL.md` trees, publishes an exact validated lock
snapshot, then links. A failed upstream command or validation leaves the
existing Nexus lock unchanged and reports any untracked directory under the
canonical root for review.

Private repositories work when the configured Git/npm credentials permit the
underlying `npx skills` command to read them. Keep private credentials outside
this repository. Development and test runs should use an isolated `HOME` and
`NEXUS_HOME`; never use real agent roots for tests. `skill-lock.json` is
gitignored and should not be committed.

## Updating a skill

Update refreshes exactly one installed skill:

```bash
~/.nexus/scripts/nexus update review
```

The name must be a safe, non-control name that the Nexus lock already contains.
Update refuses a control skill name, a custom skill name, and a name that is
not installed. Every refusal happens before Nexus calls upstream, so nothing is
downloaded and no upstream lock is rewritten. Custom skills are not updated
here: run `git pull` in `~/.custom-skills` and then run link.

Nexus passes the name, `--global`, and `--yes` to upstream `npx skills update`
as separate arguments and never evaluates them as shell code. After upstream
succeeds, Nexus snapshots and validates the produced lock, verifies the
canonical `SKILL.md` trees, checks that the lock still contains the skill,
publishes an exact validated lock snapshot, then links. The output reports the
skill's folder hash before and after, so you can tell whether anything changed.
A failed upstream command, an invalid upstream lock, a missing `SKILL.md`, or a
lock that no longer contains the skill leaves the existing Nexus lock unchanged.

## Removing a skill

Removal takes exactly one skill name:

```bash
~/.nexus/scripts/nexus remove skill-name
```

Nexus refuses a missing name, more than one name, an option-like name such as
`--all`, an unsafe name, a control skill name, a custom skill name, and a name
that is not in the Nexus lock. Every refusal happens
before `npx` is located and before upstream runs, so a refused removal changes
nothing. A custom skill is removed by deleting its directory under
`~/.custom-skills` and then running link; Nexus never deletes custom skill
content.

After the refusals, Nexus runs upstream `npx skills remove` with the name,
`--global`, and `--yes` as separate arguments, and never evaluates them as
shell code. On success it snapshots and validates the produced lock, verifies
the removed name is gone from it, publishes the exact validated snapshot, then
links, so the managed links for the name disappear. Foreign entries and other
skills are left alone. A failed upstream
command, or a lock that still contains the name, leaves the Nexus lock
byte-identical. Upstream owns the canonical root; a directory there that
survives the removal is reported as untracked for your review.

## Listing skills and help

`nexus list` is read-only. It prints one line per skill, sorted by name, with
tab-separated columns: name, kind (`installed`, `custom`, `control`), source,
an eight-character `skillFolderHash` prefix, and `updatedAt`. Installed rows
come from the validated Nexus lock; custom and control rows show a dash for
the last three columns because they carry no upstream version. After the
table, one line reports the global instructions (see "Global instructions").
When the lock is absent, `list` prints one info line saying so, then only the
custom and control rows, and still exits 0. An invalid lock reports the
validation error and exits 1.

`nexus help` (also `-h` and `--help`) prints the usage line and one line per
subcommand: `bootstrap`, `setup`, `link`, `install`, `update`, `remove`,
`new`, `list`, and `help`.

The `nexus-help` skill asks which of these two you want, runs the matching
read-only command, and reports the result. It never runs a mutating command.

## Troubleshooting

- **Already initialized:** setup is intentionally disabled; use `/nexus-link`,
  `$nexus-link`, or the CLI link command.
- **Missing, conflicting, or invalid lock:** provide one valid version-3 lock
  in the supported `~/.agents`/`~/.skills` locations, remove ambiguity, and
  retry. Nexus does not guess between conflicting candidates.
- **Changed agent homes or bounded backup retries:** close Claude and Codex,
  inspect the retained backup/recovery paths, then retry setup.
- **Collision:** preserve the foreign entry, resolve it manually,
  and rerun link or bootstrap as appropriate.
- **Foreign entry at an instruction path:** your instruction file has not been
  migrated. Move it to `~/.custom-skills/GLOBAL.md` and rerun link; nothing
  was lost.
- **Global instructions must be a regular file:** `~/.custom-skills/GLOBAL.md`
  is a symlink or a directory. Replace it with a regular file and rerun link.
- **NVM/npx:** ensure direct `npx` works, or install/select a default NVM Node
  version. Nexus only loads NVM as the fallback when `npx` is unavailable.
- **Upstream failure:** inspect the `npx skills` error and any reported
  untracked directories; the prior Nexus lock is preserved.
- **Retained temporary/residue paths:** read the command's exact path and
  recovery message first. Keep a copy until the situation is understood, then
  correct the cause before rerunning.

## Adding another agent

To add another agent, update the code mappings for its native skill root and
link target, add bootstrap links and any invocation adapter, include it in
managed ownership and link, and decide how its backup and setup
preflight should work. Add isolated tests for bootstrap, collisions, link, setup backup/recovery, and install behavior; update this
README with its invocation forms and recovery semantics. Keep the Nexus lock
authoritative and keep the agent's foreign entries untouched. The
phrase “another agent” here is intentional: adding one is a coordinated
ownership change, not merely another symlink.

## Safety contract

Bootstrap only exposes Nexus control entries. Setup is explicit and is **not**
run by bootstrap. Setup backs up before link changes, never silently
overwrites backups, and reports recovery paths. Install requires explicit
source and skill names and does not `eval` arguments.
