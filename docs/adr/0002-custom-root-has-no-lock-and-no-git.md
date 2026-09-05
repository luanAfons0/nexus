# 0002. The Custom Root has no lock and Nexus never runs Git in it

## Status

Accepted

## Context

Custom skills are hand-written and live in `~/.custom-skills`, a Git
repository the user controls. Installed skills are tracked by a lock with
source, hash, and timestamp. The question was whether custom skills should
have a similar manifest and whether Nexus should pull or commit that
repository for the user.

## Decision

The directory listing is the manifest. Every visible subdirectory of the
custom root must be a valid custom skill with a real `SKILL.md`; dot entries
and top-level files are ignored; anything else is a hard error. Nexus reads
the custom root, never deletes from it, and never runs Git in it. Nexus writes
exactly one path in it, the Global Instructions file `GLOBAL.md`, under the
rules of ADR 0004; it never writes a Custom Skill directory. Custom skills
carry no version, hash, or source in `nexus list`.

## Consequences

- There is no second lock to keep consistent, and no way for the custom root
  to be half-registered.
- A stray directory (for example a `skill-creator` workspace) breaks link
  loudly instead of being skipped. Workspaces go under `.workspaces/`.
- Updating custom skills is the user's job: `git pull`, then link.
- Custom and installed skills cannot share a name, because there is no lock
  field to say which one wins; link refuses the collision in preflight.
