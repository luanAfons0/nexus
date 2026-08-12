# Nexus Skill Manager Design

**Date:** 2026-08-12  
**Status:** Approved design

## Purpose

Nexus provides one consistent way to install and expose user-level agent skills across Claude Code and Codex on WSL2. It centralizes the installed-skill inventory without becoming another store for downloaded skills.

The first release provides three model-facing operations:

- Claude Code: `/nexus:setup`, `/nexus:link`, `/nexus:install`
- Codex: `$nexus-setup`, `$nexus-link`, `$nexus-install`

Each model-specific entry point delegates to the same deterministic command-line implementation.

## Scope

Version 1 supports:

- Migrating an existing version-3 agent-skills lockfile into Nexus.
- Creating complete, non-overwriting backups of `~/.claude` and `~/.codex`.
- Reconciling skill links for Claude Code and Codex.
- Installing one or more selected skills from a Git shorthand, Git URL, or local directory through the existing `skills` CLI.
- Bootstrapping Nexus's own control skills before Nexus setup has run.
- Adding other agents later by extending the target mapping.

Version 1 does not provide marketplace search, direct archive download handling, skill removal from the canonical store, or a general agent configuration format.

## Ownership Model

Nexus uses the following layout:

```text
~/.nexus/
├── .gitignore
├── README.md
├── skill-lock.json                 # local runtime state; never committed
├── scripts/
│   └── nexus                       # deterministic command engine
├── skills/
│   ├── nexus-setup/
│   │   ├── SKILL.md
│   │   └── claude-command.md
│   ├── nexus-link/
│   │   ├── SKILL.md
│   │   └── claude-command.md
│   └── nexus-install/
│       ├── SKILL.md
│       └── claude-command.md
└── tests/
    └── run.sh

~/.agents/skills/                   # physical managed third-party skills
~/.claude/skills/                   # agent-facing symlinks
~/.codex/skills/                    # agent-facing symlinks and untouched .system
```

The three Nexus control skills are the only skills physically stored beneath `~/.nexus/skills`. They are project code, are linked separately, and do not appear as downloadable entries in `skill-lock.json`.

All downloaded third-party skills live physically beneath `~/.agents/skills`. Nexus never copies those skill directories into its own repository. `~/.nexus/skill-lock.json` is the authoritative inventory used by `link`.

The project `.gitignore` contains `skill-lock.json` because that file is machine-specific and can contain private repository locations.

## Command Engine

`scripts/nexus` is an executable Bash program with these subcommands:

```text
nexus bootstrap
nexus setup
nexus link
nexus install <source> --skill <name> [--skill <name> ...]
```

The implementation uses Bash, Git, `jq`, `cp`, and standard WSL2 utilities. Installation delegates repository discovery and copying to `npx skills`; Nexus does not reimplement that ecosystem's installer or lockfile writer.

All paths derive from `HOME`, allowing the complete behavior to be tested under a temporary fake home. Arguments are passed as Bash arrays. The program never uses `eval` or constructs executable command strings from user input.

## Bootstrap

Bootstrap makes the Nexus control operations discoverable before setup creates the Nexus lockfile. It is the only first-use command that does not require setup.

It creates or verifies links for the three Nexus control skills in the supported agent locations. It also creates Claude command adapters under `~/.claude/commands/nexus/` so Claude exposes the requested colon-style commands:

```text
~/.claude/commands/nexus/setup.md
~/.claude/commands/nexus/link.md
~/.claude/commands/nexus/install.md
```

Codex uses the linked `nexus-setup`, `nexus-link`, and `nexus-install` skills through `$` mentions or its skill selector. Focused descriptions also allow both agents to match the skills from natural-language requests.

Bootstrap never creates `skill-lock.json`, downloads a third-party skill, creates an agent backup, or modifies unrelated entries. If a destination is an unrelated file, directory, or external symlink, bootstrap reports the collision and leaves it unchanged.

## Setup Transaction

### Disabled state

If `~/.nexus/skill-lock.json` already exists, setup performs no mutations. It reports that Nexus is initialized and directs the caller to `/nexus:link` in Claude or `$nexus-link` in Codex.

### Preflight

When Nexus has no lockfile, setup searches these candidates:

1. `~/.agents/.skill-lock.json`
2. `~/.agents/skill-lock.json`
3. `~/.skills/.skill-lock.json`
4. `~/.skills/skill-lock.json`

If no candidate exists, setup stops with an actionable error. If multiple candidates exist with different contents, setup stops and lists them rather than selecting one silently. Identical candidates are accepted using the precedence above.

The selected file must be valid JSON containing a numeric `version` and an object-valued `skills` property. Version 1 accepts the current version-3 format. Every skill key must be a safe single path component. Setup validates all prerequisites before writing anything.

Setup refuses to overwrite either `~/.claude-backup` or `~/.codex-backup`.

### Backups

Setup copies, rather than moves, the complete `~/.claude` and `~/.codex` directories. It uses `cp -a` temporary sibling destinations and verifies paths, entry types, regular-file contents, hardlink topology, literal symlink targets, mode, uid/gid where available, and nanosecond mtime before publication. ACLs, xattrs, atime, and other filesystem-specific metadata are outside the v1 verification promise. A successful temporary copy is renamed to:

```text
~/.claude-backup
~/.codex-backup
```

The original agent directories remain in place and active. This permits Claude or Codex to call setup itself. Because a running agent may update live state while files are being copied, the backup is a preserved filesystem copy rather than a globally atomic point-in-time snapshot; setup never mutates the source state being backed up.

If either source agent directory is absent, setup creates an empty corresponding backup directory and reports that fact. If either backup operation fails, setup does not install links or create the Nexus lockfile.

### Lock migration and initial linking

After both backups succeed, setup atomically copies the validated source lockfile to `~/.nexus/skill-lock.json`. It then invokes link reconciliation in migration mode.

Before replacing agent-side entries, setup enforces the canonical ownership model for every lockfile-managed skill. If `~/.agents/skills/<name>` is already a physical directory, it is left unchanged. If it is a symlink to a valid skill directory elsewhere—such as an existing link back into `~/.claude/skills`—setup copies the dereferenced contents into a verified temporary sibling directory and atomically promotes that directory to the canonical path. This prevents a later agent link from creating a symlink cycle. Untracked canonical entries and the original symlink targets are left unchanged.

Migration mode may replace collisions inside `~/.claude/skills` and `~/.codex/skills` because their complete original state is available in the backups. It does not replace content elsewhere. Codex's `~/.codex/skills/.system` directory is always preserved.

Setup concludes by verifying every created link and printing the selected source lockfile, skill counts, missing canonical skills, and backup paths.

## Link Reconciliation

Link reads only `~/.nexus/skill-lock.json`. A missing or invalid Nexus lockfile causes a failure without filesystem changes.

The desired set consists of:

- Every skill key in the Nexus lockfile, sourced from `~/.agents/skills/<name>`.
- The three Nexus control skills, sourced from `~/.nexus/skills/<name>`.

For each downloaded skill, the canonical directory and its `SKILL.md` must exist. Link creates relative symlinks at `~/.claude/skills/<name>` and `~/.codex/skills/<name>`. A correct link is an idempotent no-op.

Link can replace a broken or outdated symlink only when its resolved or lexical target is beneath `~/.agents/skills` or `~/.nexus/skills`. An ordinary link operation never replaces an unrelated physical directory, file, or external symlink; it reports the collision and continues checking other entries.

Link explicitly removes managed agent symlinks in either of these cases:

- Their skill no longer appears in the Nexus lockfile and they are not Nexus control skills.
- Their skill remains recorded but the canonical directory or `SKILL.md` no longer exists, making the agent link broken.

Link never deletes a physical skill directory. Missing canonical skills are summarized and cause a nonzero exit status.

New and replacement links are created under unique temporary names in the destination directory, verified, and renamed into place. Stale temporary links from interrupted Nexus operations can be safely removed on the next run. The `.system` entry in Codex's skill directory is never treated as a managed link.

## Installation Flow

Install requires an existing, valid Nexus lockfile. It accepts:

- GitHub shorthand such as `owner/repository`.
- A full Git URL, including authenticated/private repositories supported by the upstream CLI.
- A local directory containing one or more skills.
- One or more explicitly selected skill names through repeated `--skill` arguments.

If `npx` is unavailable in the process PATH, Nexus loads `${NVM_DIR:-$HOME/.nvm}/nvm.sh` and selects the configured default Node version. This supports calls launched from non-interactive agent shells without sourcing the user's entire `.bashrc`.

Nexus snapshots its authoritative lockfile, then invokes the upstream installer using argument arrays:

```text
npx skills add <source> --global --agent universal \
  --skill <name> [--skill <name> ...] --yes
```

The `universal` target places the physical installation in the canonical global `~/.agents/skills` store. Nexus remains responsible for Claude and Codex links.

After a successful upstream command, Nexus validates the upstream `~/.agents/.skill-lock.json`, verifies that every newly selected canonical skill contains `SKILL.md`, and atomically copies the updated lockfile to `~/.nexus/skill-lock.json`. It then calls link reconciliation and reports each canonical directory and agent link.

If the upstream command fails, Nexus retains its previous authoritative lockfile. It reports canonical skill directories that appeared during the failed attempt but does not silently add them to the inventory. A future successful install or manual cleanup can resolve those untracked directories.

## Error and Recovery Behavior

All commands provide nonzero exit statuses for incomplete outcomes and print actionable errors to standard error.

The safety rules are:

- Never overwrite an existing agent backup.
- Never delete a physical downloaded skill from `~/.agents/skills` during link reconciliation.
- Never replace unrelated entries during bootstrap or ordinary linking.
- Do not publish a Nexus lockfile until both backups succeed during setup.
- Do not publish an updated Nexus lockfile until the external installer succeeds and its output validates.
- Preserve Codex system skills.

If setup fails after temporary backup creation, it leaves the original agent directories untouched, removes only temporary paths it created when safe, and prints their locations if cleanup is not possible. Since setup copies rather than moves the sources, recovery never requires restoring the live directories merely to keep either agent functional.

The README documents how to inspect backups and manually restore selected files. Nexus does not automatically overwrite live agent state from a backup.

## Documentation

`README.md` explains:

- Why Nexus exists and its ownership model.
- Required commands and the NVM behavior.
- Initial bootstrap.
- Native Claude and Codex invocation syntax.
- Setup, link, and install examples.
- The authoritative and upstream lockfile relationship.
- Backup guarantees and manual recovery.
- Collision and missing-skill behavior.
- How to extend the target map for another model.

## Verification Strategy

`tests/run.sh` is a dependency-light Bash test harness. Every test sets `HOME` to a unique temporary directory and invokes the real Nexus script. No test reads or writes the user's live Claude, Codex, Agents, or Nexus state.

A stub `npx` executable simulates successful installation, failed installation, lockfile updates, and canonical skill creation. A fake NVM initialization file verifies non-interactive resolution.

The suite covers:

1. Complete backup creation with hidden files and symlinks preserved.
2. Existing backup refusal.
3. Setup disablement when the Nexus lockfile exists.
4. Lockfile discovery, duplicate-equivalence handling, and conflicting-candidate refusal.
5. Materialization of a managed canonical symlink before agent-link replacement, without creating a cycle.
6. Correct control and third-party link creation.
7. Link idempotency.
8. Explicit removal of stale and broken managed links.
9. Preservation and reporting of unrelated collisions.
10. Preservation of Codex `.system`.
11. Successful install, lock publication, and automatic link reconciliation.
12. Failed install preserving the prior Nexus lockfile.
13. NVM-based `npx` resolution from a reduced PATH.

Before touching real agent directories, verification runs:

```text
bash -n scripts/nexus tests/run.sh
bash tests/run.sh
```

After those checks pass, bootstrap runs against the real home directory. Final verification is read-only: resolve each control link, confirm each target stays within `~/.nexus/skills`, and confirm each target contains `SKILL.md` or a Claude command adapter as appropriate.

## Success Criteria

The implementation is complete when:

- Either agent can invoke its native Nexus control entry points after bootstrap.
- Setup creates both non-overwriting complete backup directories, imports the existing lockfile, and reconciles links without moving the live agent directories.
- A second setup invocation makes no changes and directs the caller to link.
- Link creates, repairs, and explicitly removes only Nexus-managed links while preserving unrelated and system content.
- Install uses the existing `skills` CLI, updates Nexus's ignored lockfile only after validation, and automatically links the selected skills for both agents.
- The isolated test suite and syntax checks pass.
- The real bootstrap links verify without modifying downloaded third-party skills.
