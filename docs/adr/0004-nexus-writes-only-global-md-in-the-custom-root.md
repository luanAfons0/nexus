# 0004. Nexus writes only GLOBAL.md in the Custom Root

## Status

Accepted

## Context

ADR 0002 and ADR 0003 say that Nexus reads the Custom Root and never writes
to it. The user wants to edit the Global Instructions inside Nexus: first
from a Control Skill in the agent chat, later from a local web page. Neither
front can open an external editor. An agent chat has no terminal editor, and
a web page must send the new content to a process that writes the file. So
Nexus itself must write the Global Instructions.

Three options were considered:

1. Keep the read-only contract and tell the user to edit `GLOBAL.md` by hand.
   This blocks both the chat editor and the web UI.
2. Let the agent write `GLOBAL.md` with its own file tools. This bypasses the
   Nexus preflight rules, and a web page cannot use it at all.
3. Add one Nexus command that writes exactly one named file in the Custom
   Root, with the same preflight rules that link uses.

## Decision

Nexus may write exactly one path in the Custom Root: the Global Instructions
file `~/.custom-skills/GLOBAL.md`. The command is `nexus global edit`. It
replaces the whole file from standard input with a temporary file in the
Custom Root plus a rename, so the file is never half written.

The write is bounded by these rules:

- Nexus writes only `GLOBAL.md`. It never writes, moves, or deletes a Custom
  Skill directory or any other entry in the Custom Root.
- Nexus never creates the Custom Root. A missing Custom Root is a refusal.
- A `GLOBAL.md` that is a symlink or a directory is the same preflight fault
  as in link, and the write is refused.
- Nexus never runs Git in the Custom Root. The user commits the change.
- Every refusal happens before any change, so a refused write leaves the
  Custom Root byte-identical.

ADR 0002 and ADR 0003 stay accepted. Their "never writes to it" sentences now
point at this record.

## Consequences

- The Global Instructions can be edited from the agent chat and from a
  future web page through one CLI command, so the same safety rules apply
  to both fronts.
- The exception is explicit and bounded to one named regular file. Every
  other Custom Root rule in ADR 0002 stays as it is.
- A caller can pass the sha256 of the content it read, and Nexus refuses the
  write when the file changed since. A long-running editor cannot overwrite
  an edit made elsewhere.
- Versioning stays the user's job. Nexus reminds the user to commit in the
  Custom Root and does not commit for them.
