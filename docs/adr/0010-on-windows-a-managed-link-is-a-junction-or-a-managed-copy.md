# 0010. On Windows a Managed Link is a junction or a Managed Copy

## Status

Accepted

Amends ADR 0003 on Windows. On Linux and macOS ADR 0003 stands: each
Instruction Path is a relative symlink to `GLOBAL.md`, and every other
Managed Link is a relative symlink too.

## Context

Nexus is ported to TypeScript on Node 24 so that it runs on Windows with no
WSL (spec #72). Every Managed Link was a relative symlink. On Windows a
symlink needs Developer Mode or an administrator, and most people on Windows
have neither. Nexus must work on the machine a person already has.

Windows has two other ways to make one path show another's content. A
junction is a directory reparse point that any user can make, but it reaches
only a directory and holds an absolute target. A hard link reaches a file
with no privilege, but it is the same file only until the file is replaced:
`nexus global edit` replaces `GLOBAL.md` with a rename (ADR 0004), which would
break a hard link the first time.

## Decision

On Windows Nexus never makes a symlink, even with Developer Mode on, so one
system has one behaviour.

- A Native Skill Root entry is a junction to its Owner directory. A junction
  is a Managed Link when it resolves into an Owner, the same rule as a
  symlink. Its absolute target is accepted.
- An Instruction Path is a Managed Copy: a regular file whose bytes equal
  `GLOBAL.md`. Nexus records the SHA-256 of each Managed Copy it writes in the
  Managed Copies file, `~/.nexus/managed-copies.json`, which Git ignores like
  the Check Result. A file at an Instruction Path is a Managed Copy only when
  its hash equals the record. Any other file there is a Foreign Entry:
  reported, preserved, and that one link skipped, as ADR 0003 says.
- Link refreshes a Managed Copy whose bytes differ from `GLOBAL.md` while its
  hash still matches the record. `nexus global edit` does the same right
  after it replaces `GLOBAL.md`. When `GLOBAL.md` is absent, Link removes a
  Managed Copy and its record, as it removes a stale instruction link.

Only the Link primitive (`src/link-primitive.ts`) knows this. Link, Bootstrap,
Setup and every other command see the same four answers on every system:
nothing, managed, a foreign link, or a Foreign Entry.

## Considered Options

- Symlinks everywhere, with Developer Mode required on Windows. Rejected: it
  stops most people on Windows before the first link.
- A hard link at each Instruction Path. Rejected: the atomic replace of
  `GLOBAL.md` breaks it.
- A Managed Copy with no record, managed whenever its bytes equal
  `GLOBAL.md`. Rejected: after `GLOBAL.md` changes, a stale copy and a file
  the person wrote by hand look the same, and Nexus would overwrite the
  person's file.

## Consequences

- On Windows two edits do not meet: an edit to an Instruction Path does not
  reach `GLOBAL.md`. It makes that path a Foreign Entry, which Link reports
  with the same hint as any other Foreign Entry, and Nexus keeps the file.
- A Managed Copy follows `GLOBAL.md` only when Link or `nexus global edit`
  runs. A hand edit to `GLOBAL.md` reaches the agents on the next `nexus link`.
- A lost or unreadable Managed Copies file records nothing, so every copy
  reads as a Foreign Entry and is kept: the safe side of not knowing.
- Windows cannot rename over a directory or a junction, so a junction is
  replaced by moving the old entry aside under a staged name first, and
  putting it back if the new one cannot take its place. A Managed Copy is
  renamed over the old copy in one step.
- A Linux install does not move across to Windows (spec #72, out of scope).
