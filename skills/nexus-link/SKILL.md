---
name: nexus-link
description: Reconcile, repair, or remove stale Nexus-managed links so Claude and Codex load the same Agent Context; also trigger when explicitly invoked as $nexus-link.
---

# Nexus link reconciliation

Only run this mutating command when the user asks you to reconcile or repair links. For informational or diagnostic questions about Nexus links, explain the operation without executing anything.

Run the Nexus link command exactly once:

```bash
~/.nexus/scripts/nexus link
```

Link reconciles the Native Skill Roots first, then the two Instruction Paths (`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`): each becomes a relative Managed Link to the Global Instructions owned by `~/.custom-skills/GLOBAL.md`, so both agents read byte-identical instructions.

Report the command output clearly. Never bypass validation errors or collision errors; report them and stop.

Some lines are notices, not errors, and link still exits 0:

- `global instructions are absent`: there is no `~/.custom-skills/GLOBAL.md` yet. Skills were still reconciled. Tell the user to create that file and rerun link.
- `foreign entry at <path>`: a physical file, an unrelated symlink, or a directory sits at an Instruction Path. Nexus preserved it and skipped only that link. Show the user the exact `mv` command from the notice; the move is theirs to make, never yours.
- `skipped <path>: agent home is absent`: that agent is not installed. Nexus never creates an Agent Home.

`global instructions must be a regular file` is an error: `GLOBAL.md` is a symlink or a directory, and link changed nothing. Report it and stop.
