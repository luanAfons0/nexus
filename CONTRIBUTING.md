# Contributing to Nexus

Nexus owns an Agent Context: the Skills and the Global Instructions that
Claude and Codex load before they read a prompt. It moves symbolic links
around inside a person's home directory. A mistake here costs somebody the
setup they work in every day, so this file is longer than a project of this
size usually needs.

## Read these first

- [`CONTEXT.md`](CONTEXT.md) defines every word this repo uses — Agent
  Context, Installed Skill, Custom Skill, Control Skill, Owner, Canonical
  Root, Custom Root, Managed Link, Foreign Entry, Nexus Lock, Setup, Link —
  and the synonyms to avoid. Use its words in code, in comments, in tests, in
  issues and in commit messages.
- [`docs/adr/`](docs/adr) holds the decisions that are expensive to reverse.
  Read the ADR that covers the area you are about to change. If your change
  contradicts one, say so in the pull request instead of overriding it
  quietly.
- [`AGENTS.md`](AGENTS.md) is the same ground in short form, for coding
  agents.

## What you need

Bash 5, GNU coreutils, `jq`, Python 3 and Git. Also `npx`, if you touch
installing or updating: Nexus calls upstream `npx skills` for those two
operations and for nothing else.

Nexus is developed and tested on Linux and on WSL. The scripts assume GNU
coreutils, so macOS with the BSD tools is untried rather than unsupported. If
you run the suite there, open an issue with what breaks.

## Get the code

```bash
git clone https://github.com/luanAfons0/nexus.git
cd nexus
bash tests/run.sh
```

The clone does not have to live at `~/.nexus`. The CLI finds its own files
from the path of `scripts/nexus`, and the home directory it manages comes from
`$HOME`. An installed Nexus lives at `~/.nexus`; a clone you develop in can
live anywhere.

Run every command from the repository root.

## Run the tests

```bash
bash tests/run.sh
```

That is the whole suite and its only entry point. It prints one line per
behaviour and ends with a count, which has to read `0 failed`:

```
96 passed, 0 failed
```

Every test builds its own home directory under a temporary root and drives the
CLI over its command line, exactly as a person does. Two properties keep that
honest, and a change must keep both:

- **No test sources a library of the CLI to reach inside it.** The seam is the
  command line and the files the CLI writes into a home directory.
- **A test never touches a real home.** `run_nexus_overridden` refuses to run
  against anything that is not a validated fake home under the temporary root.

Where a new test goes:

- A behaviour of one subcommand belongs in `tests/cases/<subcommand>.sh`. Each
  file defines its test functions and appends their names to `CASE_TESTS`.
- Anything that spans subcommands, or that drives Setup, belongs in
  `tests/run.sh` next to its relatives.
- A failure you need to force — an interrupted Setup, a failing upstream
  command, a late Collision — belongs in `tests/faults.sh`, which injects it
  by overriding one shell function.

A test name is a sentence about behaviour, not about code:
`setup_canonical_late_collision_is_preserved`.

## Try a change by hand, safely

Never point a half-finished change at your own Agent Context. Use the sandbox:

```bash
scripts/dev-home bootstrap     # link the Control Skills, in the sandbox
scripts/dev-home list          # what the sandbox home holds
scripts/dev-home setup         # the real Setup, against throwaway files
scripts/dev-home --reset list  # start the sandbox home again from empty
```

`scripts/dev-home` runs `scripts/nexus` with `$HOME` pointed at
`.scratch/home` inside the repository, which Git ignores. Every path Nexus
touches is derived from `$HOME`, so the Canonical Root, the Custom Root, both
Native Skill Roots and both Instruction Paths all land in the sandbox. It
refuses to run if the sandbox would hold your real home, and it deletes only a
directory it marked as its own. `NEXUS_DEV_HOME` moves the sandbox elsewhere.

## The page, and FirstMate

Nexus is a FirstMate Plugin (ADR 0008). The FirstMate Host serves the Plugin
Page in `web/` and runs the Plugin Server `mcp`; Nexus opens no listener of
its own. Changes to the CLI, the tests or the docs need none of this. Changes
to `web/` or `mcp` need a running Host:

1. Install FirstMate: <https://github.com/luanAfons0/FirstMate>.
2. Register this clone as a Plugin, from the FirstMate repository:
   `node src/cli.ts add nexus /absolute/path/to/your/nexus/clone`.
3. Open `http://127.0.0.1:4747/p/nexus/`.

The Host serves the clone you registered, so an edit in `web/` is one reload
away. Every tool the page can call is one subprocess call to the Nexus CLI, so
the Plugin Server touches no file itself. Keep it that way.

## How the code is written

- Plain Bash functions, single quotes, two-space indent, lines under 100
  columns. There is no formatter; match the file you are in.
- **No new dependencies**, at runtime or for development. Bash, coreutils,
  `jq` and Python 3 are the whole toolbox, and upstream `npx skills` is called
  only where it already is.
- Comments say **why**, in the project's words, and name the ADR when a
  decision is behind the code (`(ADR 0004)`).
- Errors are sentences a person can act on, and name the path they are about:
  `nexus: error: custom skill is missing SKILL.md: /path/SKILL.md`. Fail early
  and loudly; say nothing when nothing is wrong.
- A preflight failure is a configuration fault: report it and change nothing.

Safety properties that a change may not weaken, however good the reason looks:

- A Foreign Entry is preserved. Nexus never claims or deletes one.
- Nexus writes exactly one path in the Custom Root, `GLOBAL.md` (ADR 0004).
- The Nexus Lock is published only after every validation passes, so a failure
  leaves the previous lock byte-identical (ADR 0001).
- A Backup is never silently overwritten.
- An argument — a Skill Name, an install source — is passed to upstream as an
  argument. It is never evaluated as shell code.

## Commits

Conventional Commits, with the subject written in the project's own words:

```
feat: show and control the Web UI from the Windows notification area
fix: find Nexus and FirstMate from the home directory, not one user's path
docs: record the Tray as a Windows client of the CLI in ADR 0007
chore: check every change with a machine
feat!: delete the Web UI, the Run File and the Tray
```

`feat`, `fix`, `docs`, `chore`, and `!` for a change that breaks something
somebody depends on. One commit is one whole, working change: code, tests and
docs together. No attribution, co-author or "generated by" lines.

## Pull requests

1. Branch from `main`. Name it after the issue: `issue-67-late-collision`.
2. Leave `bash tests/run.sh` green. The `Check` workflow runs that one command
   on `ubuntu-latest` for every pull request, and `main` is protected by a
   ruleset that keeps it green.
3. Update `README.md` when you change a command, a path, an address or an
   environment variable.
4. Open the pull request with `gh pr create --base main`, and write
   `Closes #<issue>` in the body.
5. Say in the description which ADR covers what you changed, and whether you
   contradict one.

Small, obvious fixes do not need an issue first. Anything that changes a
command, the shape of the Nexus Lock, or a safety property does: open an issue
and let it be discussed before you write the code.

## Issues

Issues live in GitHub Issues for `luanAfons0/nexus`. A bug report is most
useful with the exact command, its whole output, and the versions of Bash,
`jq` and Python 3.

Triage uses five labels: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human` and `wontfix`. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md). A new issue
gets `needs-triage` and a maintainer sorts it from there.

Security problems do not belong in an issue. See [`SECURITY.md`](SECURITY.md).
