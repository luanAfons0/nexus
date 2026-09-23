# 0009. A failed check is a tool error, not an envelope

## Status

Accepted

Narrows ADR 0008 in one place. Everything else in ADR 0008 stands, and ADR
0001 is reinforced: the Check writes no line of the Nexus Lock.

## Context

ADR 0008 gave every tool of the Plugin Server the same shape: one subprocess
run of the CLI, and one `{command, exit, stdout, stderr}` envelope, whatever
the exit code. "A CLI refusal is still an answer." That is right for the page,
which is a person reading the exact output of the command they asked for, and
which must show `nexus remove` refusing a name exactly as a terminal shows it.

The Check has a second caller. A Job on a clock calls it over the Tool Bus and
has to decide an Outcome from what comes back, without a person in the room.
A caller cannot decide an Outcome from a result: MCP says a result is a
result, and the exit code is buried in a field the caller would have to know
to read. A check that could not run would then be recorded as a Job that ran.

The failures worth distinguishing are the ones the caller cannot see past: no
`gh`, a `gh` that is not logged in, no lock, an invalid lock. A repository
that cannot be reached is not one of them — that is an answer, and it has a
word of its own.

## Decision

`check_skills` answers a JSON-RPC error, code `-32603`, when `nexus check`
exits non-zero. The message is the last sentence the CLI wrote to standard
error, which is the sentence a person can act on.

A check that ran carries one plain sentence in the text half of its result:

```
37 Installed Skills: 28 current, 9 Behind, 0 unknown. Checked 2026-09-23T01:42:19Z.
```

The same second caller is the reason. It shows one sentence of what the tool
answered, and out of an envelope that sentence is a JSON document with the
counts buried in it. The structured half stays the envelope every other tool
answers, so the page and every other caller still read the whole document.

Every other tool keeps ADR 0008's habit unchanged: a non-zero exit is an
ordinary result carrying the envelope, the text half repeats that envelope,
and the page reads the exit code as it always did.

A Skill whose repository could not be reached stays inside a successful
answer, as one `unknown` row carrying the reason `gh` gave. `unknown` is never
counted as `current`, and the check as a whole is not a failure because one
repository was down.

## Consequences

- One tool of the six has two answer shapes and the other five have one. That
  is the price of having two kinds of caller, and it is paid in the tool that
  has the second kind.
- The page, if it ever calls this tool, must handle a JSON-RPC error where it
  handles an envelope today. The error carries a sentence, so there is
  something to show.
- The Check Result file is written before the answer is shaped, so a caller
  that sees an error can still read the last result that did complete, with
  the moment it ran.
- A new tool has to choose a side deliberately. The question to ask is whether
  the caller is a person reading output or a program deciding an Outcome.
- The counts are now said in two places, the sentence and the document. They
  are built from the same document, so they cannot disagree, but a change to
  either has to keep it that way.
