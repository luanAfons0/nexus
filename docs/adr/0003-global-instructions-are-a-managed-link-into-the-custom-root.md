# 0003. Global Instructions are a Managed Link into the Custom Root

## Status

Accepted

## Context

Claude reads `~/.claude/CLAUDE.md` and Codex reads `~/.codex/AGENTS.md` at
the start of every session. Keeping two copies of the same rules by hand
drifts. Nexus already gives every skill one explicit owner and reconciles the
agents' native folders into links, so the same model was extended to the
Global Instructions. Four owners were considered: a top-level file in the
Custom Root, a new dedicated root, `~/.claude/CLAUDE.md` itself with Codex
linking to it, and a file inside `~/.nexus`. Copying content into each
Instruction Path was considered instead of linking.

## Decision

The Global Instructions are owned by the Custom Root as
`~/.custom-skills/GLOBAL.md`, a regular file the user edits and commits. Each
Instruction Path is a relative Managed Link to that file, created by `link`.
The name is `GLOBAL.md`, not `AGENTS.md`, so Codex does not load it as project
instructions when working inside the Custom Root.

A missing `GLOBAL.md` is a notice, not a fault: link skips the Instruction
Paths and still reconciles skills. A physical file or unrelated symlink at an
Instruction Path is a Foreign Entry: link reports it, preserves it, skips only
that link, and exits 0. This is deliberately more lenient than a skill
collision, because a physical instruction file is the normal state before the
user moves it into the Custom Root by hand, and blocking skill links for it
would punish every new user. A `GLOBAL.md` that is a symlink or a directory is
a fault, the same as a malformed custom skill.

## Consequences

- One edit to `GLOBAL.md` reaches both agents at once; there is no drift and
  no "which side changed" logic.
- The Custom Root now owns two things: Custom Skills and the Global
  Instructions. Nexus still never writes to it or runs Git in it.
- Migration is the user's job: move the existing `CLAUDE.md` to `GLOBAL.md`,
  make its wording agent-neutral, then run link.
- Nexus never creates an Agent Home; an absent `~/.codex` skips that
  Instruction Path with a notice.
- A dangling instruction link (owner file deleted) is a Stale Link and is
  removed, like a stale skill link.
