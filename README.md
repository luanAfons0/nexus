# Nexus skill manager

Nexus gives Claude and Codex one explicit, recoverable owner for installed
skills. `~/.nexus` owns the Nexus manager and its control skills. Third-party
skill content is canonical under `~/.agents/skills`; the authoritative Nexus
state is `~/.nexus/skill-lock.json` (gitignored). Hand-authored skills are
canonical under `~/.custom-skills`. The native Claude and Codex skill folders
contain reconciled relative links into those owners. Nexus does not take
ownership of unrelated physical entries, external links, or Codex's `.system`
directory.

## Requirements and first use

Project scripts use Bash 5, GNU coreutils, `jq`, and Python 3 (`python3`). Git
is needed for Git-based sources and normal development; npm/npx is an upstream
prerequisite for installation. Setup preflight checks `jq`, `python3`, and the
required core utilities; it does not check Git, npm, npx, or NVM. Install first
uses a directly available `npx`; if it is unavailable, NVM is the fallback.

From a shell, initialize only Nexus's control links with:

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
| Show skills or command help | `/nexus-help` | `$nexus-help` |

The equivalent CLI is `~/.nexus/scripts/nexus {setup,link,install,update,remove,new,list,help}`.

## Setup and recovery

Setup first performs preflight checks, then discovers candidate locks in
`~/.agents` or `~/.skills` (`.skill-lock.json` or `skill-lock.json`). It takes
an immutable snapshot and validates the exact version-3 lock before changing
anything. It creates complete, copy-based, no-clobber backups at
`~/.claude-backup` and `~/.codex-backup`; existing backups are never silently
overwritten. The live roots remain in place. After backup verification, Nexus
publishes its lock, canonicalizes managed skill symlinks under
`~/.agents/skills`, and reconciles native links.

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
is already initialized. Use link to reconcile afterward. If setup is
interrupted, reports an existing setup mutex, or reports retained residue,
review the named paths, correct the cause, and then run link. Backups are
manual recovery sources: copy only the needed files or directories from
`~/.claude-backup` or `~/.codex-backup` after inspection. Nexus never silently
replaces either backup.

## Link reconciliation

`nexus link` treats the validated Nexus lock as authoritative. For each locked
third-party skill, each custom skill, and each control skill it creates or
updates relative managed links in Claude and Codex. It explicitly removes stale
or broken Nexus-managed links, and reports missing canonical skills. Physical
entries, unrelated or external symlinks, collisions, and Codex `.system` are
preserved rather than claimed or deleted. Correct a collision or missing
canonical skill and rerun link.

Link runs its preflight checks before it changes anything. A malformed custom
root, a name collision, or a custom skill reachable through the canonical root
is a configuration fault, not a per-link failure, so link reports the fault and
leaves both agent roots exactly as they were.

## Custom skills

Skills you write yourself are canonical under `~/.custom-skills`, a Git
repository you control. Nexus does not use Git: it reads the directory only.
After a `git pull`, run link to reconcile the updated files.

There is no custom lock file. The directory listing is the manifest. Nexus
reads every visible subdirectory of `~/.custom-skills`, and each one must have
a safe skill name and a physical `SKILL.md`. Entries beginning with `.` and
top-level regular files are repository furniture and are skipped, so `.git`,
`.gitignore`, `.workspaces`, and `README.md` are ignored. Anything else is a
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
`~/.nexus/skill-lock.json` remains authoritative for link reconciliation.
After upstream succeeds, Nexus snapshots and validates the produced lock and
the selected canonical `SKILL.md` trees, publishes an exact validated lock
snapshot, then links. A failed upstream command or validation leaves the
existing Nexus lock unchanged and reports any untracked canonical skill
directories for review.

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

## Listing skills and help

`nexus list` is read-only. It prints one line per skill, sorted by name, with
tab-separated columns: name, kind (`installed`, `custom`, `control`), source,
an eight-character `skillFolderHash` prefix, and `updatedAt`. Installed rows
come from the validated Nexus lock; custom and control rows show a dash for
the last three columns because they carry no upstream version. When the lock
is absent, `list` prints one info line saying so, then only the custom and
control rows, and still exits 0. An invalid lock reports the validation error
and exits 1.

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
- **Changed live roots or bounded backup retries:** close Claude and Codex,
  inspect the retained backup/recovery paths, then retry setup.
- **Collision:** preserve the physical/unrelated entry, resolve it manually,
  and rerun link or bootstrap as appropriate.
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
managed ownership/link reconciliation, and decide how its backup and setup
preflight should work. Add isolated tests for bootstrap, collisions, link
reconciliation, setup backup/recovery, and install behavior; update this
README with its invocation forms and recovery semantics. Keep the Nexus lock
authoritative and keep the agent's unrelated/system entries untouched. The
phrase “another agent” here is intentional: adding one is a coordinated
ownership change, not merely another symlink.

## Safety contract

Bootstrap only exposes Nexus control entries. Setup is explicit and is **not**
run by bootstrap. Setup backs up before link changes, never silently
overwrites backups, and reports recovery paths. Install requires explicit
source and skill names and does not `eval` arguments.

## Daily Worklog

The private `daily` skill and its deterministic runtime live at
`~/.custom-skills/daily`. Start the first setup with
`~/.custom-skills/daily/scripts/dailyctl setup`; it installs the stable launcher
under the user's XDG bin directory and carries its own runtime copy, so
scheduled `dailyctl` commands do not depend on this checkout remaining at the
same path. The runtime setup report shows whether Claude and Codex resolve the
same canonical source and recommends a client restart only when discovery has
not refreshed.

Daily Worklog stores reports under the XDG data directory, configuration under
XDG config, and diagnostics under XDG state. These directories and files are
owner-only. The local server listens only on loopback and requires a one-time
bootstrap URL plus a strict session cookie; it is not a LAN or multi-user
service. Data is plaintext to any process or person that can read the user's
OS account, which is the local threat-model boundary. Source Evidence is
optional and expires after 30 days; dismissed Inbox items expire after 7 days.
