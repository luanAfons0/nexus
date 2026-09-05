# Nexus

Nexus is the skill manager for Claude and Codex. It gives installed, custom,
and control skills one explicit, recoverable owner and reconciles the native
skill folders of both agents into links that point at that owner.

## Language

### Skills

**Skill**:
A directory with a `SKILL.md` that an agent can invoke by name. Every skill
has exactly one kind: installed, custom, or control.

**Installed Skill**:
A skill fetched from an upstream source by `npx skills` and recorded in the
Nexus Lock.
_Avoid_: third-party skill, locked skill, upstream skill

**Custom Skill**:
A skill the user writes by hand. It has no upstream source and no lock entry;
its presence in the Custom Root is its only manifest.
_Avoid_: hand-authored skill, local skill, private skill

**Control Skill**:
One of the eight skills Nexus ships to operate itself (`nexus-setup`,
`nexus-link`, `nexus-install`, `nexus-new`, `nexus-update`, `nexus-remove`,
`nexus-help`, `nexus`). `nexus` is the menu over list, update, remove, and
the Global Instructions.
_Avoid_: Nexus skill, manager skill, built-in skill

**Skill Name**:
The directory name of a skill. It must be safe (no path, option, or hidden
form) and unique across all three kinds.

**Collision**:
Two skills of different kinds claiming the same Skill Name, or a desired skill
link path already occupied by a Foreign Entry. A collision is a configuration
fault: Nexus reports it and changes nothing. A Foreign Entry at an Instruction
Path is not a collision: Nexus reports it, preserves it, and skips only that
link.
_Avoid_: conflict, clash

### Ownership

**Owner**:
The one directory that holds a skill's real content. Each kind has one owner:
the Canonical Root for installed skills, the Custom Root for custom skills,
and the Nexus home for control skills.
_Avoid_: source of truth, master copy

**Canonical Root**:
`~/.agents/skills`, the directory upstream `npx skills` writes to and the only
owner of Installed Skill content. Custom skill content is never reachable
through it.
_Avoid_: agents root, upstream root

**Custom Root**:
`~/.custom-skills`, the Git repository the user controls that owns Custom
Skills and the Global Instructions. Nexus reads it and never runs Git in it.
Nexus writes exactly one path in it, the Global Instructions file
`GLOBAL.md`, and never writes, moves, or deletes a Custom Skill directory
(ADR 0004).
_Avoid_: custom skills repo, private skills folder

**Agent Home**:
The whole configuration directory of one agent (`~/.claude`, `~/.codex`).
Setup backs it up; Nexus otherwise touches only its Native Skill Root and its
Instruction Path.
_Avoid_: live root, agent root, agent data

**Native Skill Root**:
The folder an agent reads skills from (`~/.claude/skills`, `~/.codex/skills`).
Nexus places Managed Links here and owns nothing else inside it.
_Avoid_: agent skills folder, target root, live root

**Managed Link**:
A relative symlink at a Native Skill Root entry or an Instruction Path that
Nexus created and that resolves into an Owner. Nexus may create, update, or
remove only these.
_Avoid_: Nexus-managed link, reconciled link, symlink

**Foreign Entry**:
Anything at a Native Skill Root entry or an Instruction Path that is not a
Managed Link: a physical
directory or file, a symlink to an unrelated place, or Codex's `.system`
directory. Nexus preserves it and never claims or deletes it.
_Avoid_: physical entry, unrelated link, external link, non-managed entry

**Stale Link**:
A Managed Link whose Skill Name is no longer desired, or whose owner no
longer has a `SKILL.md`. Link removes it.
_Avoid_: broken link, dangling link, orphan

### Instructions

**Global Instructions**:
The one document of user rules that every agent loads at the start of every
session, regardless of project. It is owned by the Custom Root as
`~/.custom-skills/GLOBAL.md` and is byte-identical for all agents. It is the
one path in the Custom Root that Nexus writes: `nexus global edit` replaces
the whole file atomically, and the user commits the change (ADR 0004).
_Avoid_: global rules, rules, memory, system prompt, CLAUDE.md, AGENTS.md

**Instruction Path**:
The native file one agent reads its Global Instructions from
(`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`). Nexus places a Managed Link
here.
_Avoid_: global memory file, rules file, agent instructions file

### Lock

**Nexus Lock**:
`~/.nexus/skill-lock.json`, the validated version-3 lock that is authoritative
for which Installed Skills exist. Only Nexus writes it.
_Avoid_: lock file, the lock, skill lock

**Upstream Lock**:
The lock `npx skills` maintains for itself (normally
`~/.agents/.skill-lock.json`). Nexus reads it after an upstream command and
never treats it as authoritative.
_Avoid_: agents lock, candidate lock

**Snapshot**:
An immutable copy of an Upstream Lock or a skill tree, taken so validation
sees exactly what will be published.
_Avoid_: copy, temp lock

**Publish**:
Replacing the Nexus Lock with a validated Snapshot. Publish happens only after
every validation passes, so a failure leaves the previous Nexus Lock
byte-identical.
_Avoid_: save, write, commit

### Operations

**Bootstrap**:
Linking only the Control Skills into the Native Skill Roots. It runs no
setup, discovers no lock, and installs nothing.

**Setup**:
The one-time, explicit operation that discovers an Upstream Lock, takes a
Backup, publishes the first Nexus Lock, and links. It is disabled once a
Nexus Lock exists.
_Avoid_: init, initialize, migrate

**Link**:
Reconciling both Native Skill Roots against the Nexus Lock, the Custom Root,
and the Control Skills: create or update Managed Links, remove Stale Links,
preserve Foreign Entries.
_Avoid_: sync, relink, reconcile

**Preflight**:
The checks an operation runs before any change. A preflight failure is a
configuration fault and leaves everything as it was.
_Avoid_: validation step, pre-check

**Backup**:
A copy-based, no-clobber, verified copy of an agent's home taken by Setup
(`~/.claude-backup`, `~/.codex-backup`). Nexus never silently overwrites one.

**Untracked Directory**:
A directory under the Canonical Root that the Nexus Lock does not name.
Nexus reports it for review and does not delete it.
_Avoid_: orphan directory, leftover

**Residue**:
A retained temporary or recovery path left behind by an interrupted Setup.
Nexus names it and asks the user to review before retrying.
_Avoid_: garbage, temp files
