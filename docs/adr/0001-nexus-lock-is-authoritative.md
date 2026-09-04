# 0001. The Nexus Lock is authoritative, not the Upstream Lock

## Status

Accepted

## Context

Upstream `npx skills` maintains its own lock (normally
`~/.agents/.skill-lock.json`) and rewrites it on every install, update, and
remove. Nexus needs a single source for which installed skills should be
linked into the native skill roots. Two options existed:

1. Read the upstream lock directly at link time.
2. Keep a separate Nexus Lock at `~/.nexus/skill-lock.json`, written only by
   Nexus from a validated snapshot of the upstream lock.

## Decision

Nexus keeps its own lock. After every upstream command, Nexus snapshots the
upstream lock, validates it as an exact version-3 lock, verifies the named
`SKILL.md` trees, and only then publishes the snapshot as the Nexus Lock. Link
reads the Nexus Lock and never the upstream lock.

## Consequences

- A failed or partial upstream command cannot change which skills are linked.
  The previous Nexus Lock stays byte-identical.
- Link is deterministic from Nexus state alone and works when the upstream
  lock is absent, malformed, or a future version Nexus does not understand.
- The two locks can drift. Any change made with `npx skills` outside Nexus is
  invisible until a Nexus command republishes. Untracked directories under
  the canonical root are reported, not adopted.
- Setup must discover and validate the first upstream lock explicitly and is
  disabled once a Nexus Lock exists.
