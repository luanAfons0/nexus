# Contributing to Nexus

Nexus owns an Agent Context: the Skills and the Global Instructions that
Claude and Codex load before they read a prompt. It moves Managed Links
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

Node 24 or newer, npm and Git. Also `gh`, if you touch `nexus check`. Nexus
calls upstream `npx skills` to install, update and remove a skill, and for
nothing else. The suite runs fake `gh` and `npx` programs in their place.

Nexus is TypeScript on Node 24, with no build step: Node runs the `.ts` files
directly. `npm install` brings the two development dependencies, `typescript`
and `@types/node`. Nexus has no runtime dependency.

Nexus is developed and tested on Linux, on WSL and on Windows. macOS is
untried rather than unsupported. If you run the suite there, open an issue
with what breaks.

## Get the code

```bash
git clone https://github.com/luanAfons0/nexus.git
cd nexus
npm install
npm run check
```

The clone does not have to live at `~/.nexus`. The CLI finds its own files
from the path of `src/nexus.js`, and the home directory it manages comes from
`$HOME` (`%USERPROFILE%` on Windows). An installed Nexus lives at `~/.nexus`;
a clone you develop in can live anywhere.

Run every command from the repository root.

## Run the tests

```bash
npm run check
```

`npm run check` is the whole suite. It checks the types with `tsc --noEmit`,
then runs every test with `node --test`, on Linux and on Windows. Its tests
drive `node src/nexus.js` through `tests/helpers/nexus.ts`, with fake `gh` and
`npx` programs first on PATH. `node --test tests/link.test.ts` runs one file
while you work on it. The suite must end with no failed test.

Every test builds its own home directory under a temporary root and drives the
CLI over its command line, exactly as a person does. Two properties keep that
honest, and a change must keep both:

- **No test imports a Nexus module to reach inside it.** The seam is the
  command line and the files the CLI writes into a home directory.
- **A test never touches a real home.** `runNexus` in
  `tests/helpers/nexus.ts` refuses to run against anything that is not a
  marked test home under the temporary root.

Where a new test goes:

- A behaviour of one subcommand belongs in the `tests/<area>.test.ts` file of
  its area, such as `tests/link.test.ts` or `tests/check.test.ts`.
- The text of the README and of the Control Skills is checked by
  `tests/documentation.test.ts`.
- A failure you need to force — an interrupted Setup, a failing upstream
  command, a late Collision — is a named fault point. The CLI honours
  `NEXUS_FAULT=<name>` only with `NEXUS_TEST_MODE=1` and the test-home marker
  file `.nexus-test-home` in the home, so a fault can never reach a person's
  Agent Context. Each point is one `if (fault(...))` line at its site, in the
  terms of `src/fault.ts`. Its case belongs in `tests/faults.test.ts`,
  `tests/setup-faults.test.ts` or `tests/interruption.test.ts`.

A test name is a sentence about behaviour, not about code:
`'a Foreign Entry at a desired link path is a Collision and is kept'`.

## Try a change by hand, safely

Never point a half-finished change at your own Agent Context. Use the sandbox:

```bash
node scripts/dev-home.ts bootstrap     # link the Control Skills, in the sandbox
node scripts/dev-home.ts list          # what the sandbox home holds
node scripts/dev-home.ts setup         # the real Setup, against throwaway files
node scripts/dev-home.ts --reset list  # start the sandbox home again from empty
```

`node scripts/dev-home.ts` runs `src/nexus.js` with the Node that runs it. It
points `HOME` and `USERPROFILE` at `.scratch/home` inside the repository,
which Git ignores, and `NEXUS_HOME` at `.nexus` in it. Every path Nexus
touches is derived from the home, so the Canonical Root, the Custom Root, both
Native Skill Roots and both Instruction Paths all land in the sandbox. It
works on Linux and on Windows. It refuses to run if the sandbox would hold
your real home, and it deletes only a directory it marked as its own.
`NEXUS_DEV_HOME` moves the sandbox elsewhere.

## The page, and FirstMate

Nexus is a FirstMate Plugin (ADR 0008). The FirstMate Host serves the Plugin
Page in `web/` and runs the Plugin Server `mcp.ts`; Nexus opens no listener of
its own. Changes to the CLI, the tests or the docs need none of this. Changes
to `web/` or `mcp.ts` need a running Host:

1. Install FirstMate: <https://github.com/luanAfons0/FirstMate>. Open the
   FirstMate App, which starts the Host.
2. Register this clone as a Plugin, with FirstMate's command line:
   `firstmate add nexus /absolute/path/to/your/nexus/clone`.
3. Open `http://127.0.0.1:4747/p/nexus/`.

The Host serves the clone you registered, so an edit in `web/` is one reload
away. Every tool the page can call is one subprocess call to the Nexus CLI, so
the Plugin Server touches no file itself. Keep it that way.

## How the code is written

- TypeScript that Node 24 runs directly. A file starts with a header comment:
  what the file is, then why it is that way. Every exported name carries a
  one-line `/** … */`.
- Plain functions and object literals. No classes, no default exports, no
  inheritance, no framework. `readonly` on every field of an exported type.
- Node built-ins carry the `node:` prefix. Local imports carry the `.ts`
  extension, because Node runs the TypeScript directly.
- Single quotes, semicolons, two-space indent, lines under 100 columns. There
  is no formatter; match the file you are in.
- **No new dependencies**, at runtime or for development. Nexus has no runtime
  dependency, and `typescript` and `@types/node` are its only development
  dependencies. Upstream `npx skills` is called only where it already is.
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
2. Leave `npm run check` green. The `Check` workflow runs it on Linux and on
   Windows, in the jobs `Types and tests on Linux` and `Types and tests on
   Windows`, for every pull request, and `main` is protected by a ruleset that
   keeps it green.
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
useful with the exact command, its whole output, the versions of Node, Git and
`gh`, and the system: Linux, macOS, Windows or WSL.

Triage uses five labels: `needs-triage`, `needs-info`, `ready-for-agent`,
`ready-for-human` and `wontfix`. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md). A new issue
gets `needs-triage` and a maintainer sorts it from there.

Security problems do not belong in an issue. See [`SECURITY.md`](SECURITY.md).
