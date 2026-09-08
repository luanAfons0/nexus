# Nexus context manager

Nexus is the context manager for Claude and Codex. An agent's context is the
set of files it loads before it reads your prompt: its skills and its global
instructions. Nexus gives every part of that context one explicit,
recoverable owner and reconciles both agents to it, so Claude and Codex load
the same skills and byte-identical global instructions.

Each skill has one kind and one owner: installed skills are owned by the
canonical root `~/.agents/skills`, custom skills by the custom root
`~/.custom-skills`, and control skills by `~/.nexus`. The Nexus lock
`~/.nexus/skill-lock.json` (gitignored) is authoritative for which installed
skills exist. The native Claude and Codex skill roots contain managed links,
relative symlinks into those owners. Anything else in a native skill root is a
foreign entry: a physical directory, a symlink to an unrelated place, or
Codex's `.system` directory. Nexus never claims or deletes a foreign entry.
The custom root also owns the global instructions, `~/.custom-skills/GLOBAL.md`,
which link places at each agent's instruction path as a managed link.
`CONTEXT.md` defines these terms.

## Requirements and first use

Project scripts use Bash 5, GNU coreutils, `jq`, and Python 3 (`python3`). Git
is needed for Git-based sources and normal development; npm/npx is an upstream
prerequisite for installation. Setup preflight checks `jq`, `python3`, and the
required core utilities; it does not check Git, npm, npx, or NVM. Install first
uses a directly available `npx`; if it is unavailable, NVM is the fallback.

From a shell, bootstrap only the control skills with:

```bash
~/.nexus/scripts/nexus bootstrap
```

Bootstrap exposes only the control skills `nexus-setup`, `nexus-link`,
`nexus-install`, `nexus-new`, `nexus-update`, `nexus-remove`, `nexus-help`,
and `nexus` in the native Claude/Codex skill roots. It does not run
setup, copy agent data, discover a lock, or install anything. Setup is always
an explicit operation.

Native invocation forms are:

| Operation | Claude | Codex |
| --- | --- | --- |
| Initialize | `/nexus-setup` | `$nexus-setup` |
| Reconcile links | `/nexus-link` | `$nexus-link` |
| Install selected skills | `/nexus-install` | `$nexus-install` |
| Create a custom skill | `/nexus-new` | `$nexus-new` |
| Update one skill | `/nexus-update` | `$nexus-update` |
| Remove one skill | `/nexus-remove` | `$nexus-remove` |
| Show skills or command help | `/nexus-help` | `$nexus-help` |
| Open the Web UI: list, update, remove, edit global instructions | `/nexus` | `$nexus` |

The equivalent CLI is `~/.nexus/scripts/nexus {setup,link,install,update,remove,new,list,global,ui,help}`.

## Setup and recovery

Setup first performs preflight checks, then discovers candidate locks in
`~/.agents` or `~/.skills` (`.skill-lock.json` or `skill-lock.json`). It takes
an immutable snapshot and validates the exact version-3 lock before changing
anything. It creates complete, copy-based, no-clobber backups at
`~/.claude-backup` and `~/.codex-backup`; existing backups are never silently
overwritten. The agent homes remain in place. After backup verification, Nexus
publishes its lock, canonicalizes managed skill symlinks under the canonical
root, and links.

Backup verification covers mode, uid, gid, nanosecond mtime, content, hardlink
topology, and literal symlink targets. It does not promise ACL, xattr, atime,
or a globally atomic snapshot guarantee. If live agent state changes during a
backup, Nexus retries once and then removes the temporary transaction, leaves
live and published paths untouched, and asks you to close Claude/Codex and
retry. A setup failure after publication is deliberately
recoverable: the lock and backups are retained, and output points to
`/nexus-link` or `$nexus-link`. Review retained temporary or recovery paths
before retrying; do not delete them blindly.

Once `~/.nexus/skill-lock.json` exists, setup is disabled and reports that it
is already initialized. Use link afterward. If setup is
interrupted, reports an existing setup mutex, or reports retained residue,
review the named paths, correct the cause, and then run link. Backups are
manual recovery sources: copy only the needed files or directories from
`~/.claude-backup` or `~/.codex-backup` after inspection. Nexus never silently
replaces either backup.

## Link

`nexus link` treats the validated Nexus lock as authoritative. For each
installed skill, each custom skill, and each control skill it creates or
updates a managed link in each native skill root. It removes stale links and
reports skills whose owner has no `SKILL.md`. Foreign entries and collisions
are preserved rather than claimed or deleted. Correct a collision or a missing
skill and rerun link.

Link runs its preflight checks before it changes anything. A malformed custom
root, a name collision, a custom skill reachable through the canonical root,
or an invalid `GLOBAL.md` is a configuration fault, not a per-link failure, so
link reports the fault and leaves both agent roots exactly as they were.

After the skill links, link reconciles the two instruction paths against the
global instructions. See "Global instructions" below.

## Global instructions

Claude loads `~/.claude/CLAUDE.md` and Codex loads `~/.codex/AGENTS.md` at the
start of every session. These two files are the instruction paths. Nexus gives
them one owner: the regular file `~/.custom-skills/GLOBAL.md` at the top of
the custom root. Link places a relative managed link at each instruction path
that resolves to that file, so one edit reaches both agents and both read
byte-identical global instructions. The file is versioned in the custom root
Git repository you already control. The decision is recorded in
`docs/adr/0003-global-instructions-are-a-managed-link-into-the-custom-root.md`.

`GLOBAL.md` is the one path in the custom root that Nexus writes. `nexus
global edit` replaces the whole file from standard input with a temporary
file in the custom root plus a rename, so the file is never half written.
Nexus never creates the custom root, never writes any other entry in it,
never moves or deletes `GLOBAL.md`, and never runs Git in it; you commit the
change yourself. A refused write leaves the custom root byte-identical. The
exception is recorded in
`docs/adr/0004-nexus-writes-only-global-md-in-the-custom-root.md`.

Read the global instructions with `nexus global show`, which prints the file
bytes as-is, or `nexus global show --json`, which prints one object with the
owner path, `present`, `sha256`, `content`, and the `claude` and `codex`
instruction path states. Replace them with the full new content on standard
input:

```bash
~/.nexus/scripts/nexus global show --json
printf '%s\n' 'Answer in short sentences.' | ~/.nexus/scripts/nexus global edit --if-match <sha256>
```

`global edit` runs these checks in this order before any write, and any
failure exits 1 with the tree byte-identical: the custom root exists and is a
directory; `GLOBAL.md` is not a symlink or a directory (the same fault as in
link preflight); and, when `--if-match <sha256>` is given, the sha256 of the
current content equals it. `--if-match` is optional. Pass the `sha256` from
`global show --json` so an edit made elsewhere since you read the file is
refused instead of overwritten; the refusal names the expected and the
actual hash. An absent file and an empty file both hash as the empty string
(`e3b0c442...b855`), so that one value means "I expect no content yet".
Empty standard input writes an empty file, which is valid. There is no size
limit.

When `GLOBAL.md` did not exist before the write, `global edit` runs link
afterward through the same path as `nexus link` and forwards its output,
including any foreign entry notice, so both instruction paths become managed
links at once. That link run has the same needs as `nexus link`: with no
Nexus lock yet it reports the missing lock and exits 1, the new `GLOBAL.md`
stays in place, and setup followed by link finishes the job. When the file
existed, link does not run and nothing is printed. Exit codes: 0 success, 1 refusal or fault, 2 usage (unknown flag,
extra argument, or `--if-match` without a hex sha256).

The owner is named `GLOBAL.md`, not `AGENTS.md`, because Codex loads an
`AGENTS.md` found in the working tree as project instructions. A file named
`AGENTS.md` at the top of the custom root would be loaded twice when you work
inside that repository. `GLOBAL.md` is a top-level regular file, so the custom
skill scan skips it as repository furniture; it is not a skill.

Migration is one manual step. Move your existing instruction file into the
custom root, make its wording agent-neutral, commit it, then run link:

```bash
mv ~/.claude/CLAUDE.md ~/.custom-skills/GLOBAL.md
~/.nexus/scripts/nexus link
```

Link reconciles each instruction path in this order, and the three skipped
states below are notices, not errors, so link still exits 0:

- The agent home (`~/.claude` or `~/.codex`) is absent: a notice, and that
  instruction path is skipped. Nexus never creates an agent home for the
  instruction link.
- `GLOBAL.md` is absent: one notice for the whole run names the expected path.
  Skills are still reconciled. A managed link at an instruction path is now a
  stale link and is removed; anything else there is left alone.
- `GLOBAL.md` exists and the instruction path is a foreign entry, that is a
  physical file, a symlink to an unrelated place, or a directory: a notice
  names the path and the exact move to make (`mv <path>
  ~/.custom-skills/GLOBAL.md`, then rerun link). The entry is preserved and
  only that link is skipped; the other instruction path is still linked. A
  foreign entry at an instruction path is deliberately not a collision, because
  a physical `CLAUDE.md` is the normal state before you migrate.
- `GLOBAL.md` exists and the instruction path is a managed link to another
  managed place: it is replaced by a link to `GLOBAL.md`.
- `GLOBAL.md` exists and the instruction path is a managed link to it: nothing
  happens and nothing is printed.
- `GLOBAL.md` exists and nothing is at the instruction path: the managed link
  is created.

An empty `GLOBAL.md` is valid and links silently. A `GLOBAL.md` that is a
symlink or a directory is a configuration fault: link reports it in preflight,
exits 1, and changes nothing in either native skill root or instruction path.
List fails with the same error.

`nexus list` ends with one line that shows the owner and the state of each
instruction path, so drift is visible without running link:

```
global instructions: /home/you/.custom-skills/GLOBAL.md (claude: linked, codex: foreign)
```

Each state is exactly one of `linked` (a managed link resolving to
`GLOBAL.md`), `foreign` (anything else at the path, including a managed link
that does not resolve to `GLOBAL.md`), `absent` (nothing at the path, agent
home present), or `no home` (agent home absent). When `GLOBAL.md` is missing
the line reads `global instructions: absent (<owner path>)` followed by the
same per-agent states.

Setup ends with link, so a fresh setup reaches the same state. Bootstrap links
only the control skills and never touches an instruction path.

## Custom skills

Custom skills are owned by the custom root `~/.custom-skills`, a Git
repository you control. Nexus does not use Git. It reads the directory and
writes exactly one path in it, the global instructions file `GLOBAL.md` (see
"Global instructions"). It never writes, moves, or deletes a custom skill
directory. After a `git pull`, run link.

There is no custom lock file. The directory listing is the manifest. Nexus
reads every visible subdirectory of `~/.custom-skills`, and each one must have
a safe skill name and a real (not symlinked) `SKILL.md`. Entries beginning with `.` and
top-level regular files are repository furniture and are skipped, so `.git`,
`.gitignore`, `.workspaces`, `README.md`, and `GLOBAL.md` are ignored. Anything else is a
hard error that names the entry; Nexus does not skip an unexplained directory
silently.

`skill-creator` writes its evaluation output to a `<skill-name>-workspace`
directory beside the skill. In `~/.custom-skills` that directory has no
`SKILL.md` and is therefore an error, so custom skill workspaces belong in
`~/.custom-skills/.workspaces/<skill-name>` instead. Add `.workspaces/` to the
repository's `.gitignore`.

Create a custom skill with:

```bash
~/.nexus/scripts/nexus new skill-name
```

The command validates the name, refuses a name that collides with an installed
or control skill, refuses to create the root itself, creates one empty
directory, and prints the created path and the workspace path. It writes no
`SKILL.md`; `/nexus-new` hands the printed path to `skill-creator`, which
writes the contents, and then runs link.

A custom skill and an installed skill may not share a name. Link detects the
collision in preflight and changes nothing, and install refuses a colliding
`--skill` name before it calls upstream `npx skills`. A symlink under
`~/.agents/skills` that resolves into `~/.custom-skills` is also refused:
custom skill content is never reachable through the canonical root.

## Installing skills

Installation requires exactly one source and at least one repeated `--skill`
argument. Examples:

```bash
~/.nexus/scripts/nexus install owner/repository --skill review --skill testing
~/.nexus/scripts/nexus install https://github.com/owner/repository.git --skill review
~/.nexus/scripts/nexus install /path/to/local/skills --skill review
```

The source is passed as an argument to upstream `npx skills add`; Nexus never
evaluates install arguments as shell code. Upstream `npx skills` maintains its
own state (normally `~/.agents/.skill-lock.json`), but Nexus's
`~/.nexus/skill-lock.json` remains authoritative for link.
After upstream succeeds, Nexus snapshots and validates the produced lock and
the selected canonical `SKILL.md` trees, publishes an exact validated lock
snapshot, then links. A failed upstream command or validation leaves the
existing Nexus lock unchanged and reports any untracked directory under the
canonical root for review.

Private repositories work when the configured Git/npm credentials permit the
underlying `npx skills` command to read them. Keep private credentials outside
this repository. Development and test runs should use an isolated `HOME` and
`NEXUS_HOME`; never use real agent roots for tests. `skill-lock.json` is
gitignored and should not be committed.

## Updating a skill

Update refreshes exactly one installed skill:

```bash
~/.nexus/scripts/nexus update review
```

The name must be a safe, non-control name that the Nexus lock already contains.
Update refuses a control skill name, a custom skill name, and a name that is
not installed. Every refusal happens before Nexus calls upstream, so nothing is
downloaded and no upstream lock is rewritten. Custom skills are not updated
here: run `git pull` in `~/.custom-skills` and then run link.

Nexus passes the name, `--global`, and `--yes` to upstream `npx skills update`
as separate arguments and never evaluates them as shell code. After upstream
succeeds, Nexus snapshots and validates the produced lock, verifies the
canonical `SKILL.md` trees, checks that the lock still contains the skill,
publishes an exact validated lock snapshot, then links. The output reports the
skill's folder hash before and after, so you can tell whether anything changed.
A failed upstream command, an invalid upstream lock, a missing `SKILL.md`, or a
lock that no longer contains the skill leaves the existing Nexus lock unchanged.

## Removing a skill

Removal takes exactly one skill name:

```bash
~/.nexus/scripts/nexus remove skill-name
```

Nexus refuses a missing name, more than one name, an option-like name such as
`--all`, an unsafe name, a control skill name, a custom skill name, and a name
that is not in the Nexus lock. Every refusal happens
before `npx` is located and before upstream runs, so a refused removal changes
nothing. A custom skill is removed by deleting its directory under
`~/.custom-skills` and then running link; Nexus never deletes custom skill
content.

After the refusals, Nexus runs upstream `npx skills remove` with the name,
`--global`, and `--yes` as separate arguments, and never evaluates them as
shell code. On success it snapshots and validates the produced lock, verifies
the removed name is gone from it, publishes the exact validated snapshot, then
links, so the managed links for the name disappear. Foreign entries and other
skills are left alone. A failed upstream
command, or a lock that still contains the name, leaves the Nexus lock
byte-identical. Upstream owns the canonical root; a directory there that
survives the removal is reported as untracked for your review.

## Listing skills and help

`nexus list` is read-only. It prints one line per skill, sorted by name, with
tab-separated columns: name, kind (`installed`, `custom`, `control`), source,
an eight-character `skillFolderHash` prefix, and `updatedAt`. Installed rows
come from the validated Nexus lock; custom and control rows show a dash for
the last three columns because they carry no upstream version. After the
table, one line reports the global instructions (see "Global instructions").
When the lock is absent, `list` prints one info line saying so, then only the
custom and control rows, and still exits 0. An invalid lock reports the
validation error and exits 1.

`nexus list --json` prints the same state as one JSON object for scripts and
the Web UI. `skills` is an array sorted by name; each row has
`name`, `kind`, `source`, `hash` (the full `skillFolderHash`, not the
eight-character prefix), and `updatedAt`, with null for the last three on
custom and control rows. `globalInstructions` has the same shape as `global
show --json` without `content`. When the lock is absent the info line goes
to standard error, so standard output stays valid JSON. The table output
without the flag is unchanged.

`nexus help` (also `-h` and `--help`) prints the usage line and one line per
subcommand: `bootstrap`, `setup`, `link`, `install`, `update`, `remove`,
`new`, `list`, `global`, `ui`, and `help`.

`nexus global show` prints the global instructions as-is to standard output,
and nothing when `GLOBAL.md` is absent; both exit 0. `nexus global show
--json` prints one object with the owner path, `present`, `sha256` of the
content (null when absent), `content` (null when absent), and the `claude`
and `codex` instruction path states using the same four words as `list`. A
symlink or directory named `GLOBAL.md`, or an absent custom root, is the same
fault as in link preflight and exits 1. An unknown flag or an extra argument
exits 2.

The `nexus-help` skill asks which of these two you want, runs the matching
read-only command, and reports the result. It never runs a mutating command.

## The nexus launcher skill

`/nexus` in Claude and `$nexus` in Codex start the Web UI: the skill runs
`nexus ui`, prints the handshake line with the URL, and ends. The run
detaches itself and the command returns, so the run outlives the agent
session that started it and the skill needs no `nohup`, no log file, and no
`disown`. The printed URL is the contract. The server tries to open a
browser on its own, but from an agent sandbox it often cannot, so open the
URL by hand. To end the run, press `Stop server` in the page header or run
`nexus ui --stop`. The skill never runs install, setup, link, update,
remove, or global itself; the page does those through the same CLI, so the
same refusals apply. The former chat menu is gone.

## Web UI

`nexus ui` serves a local page, the Web UI, from Python's `http.server`.
It is the one command in which Nexus opens a network listener, and that
listener is bound to `127.0.0.1` only. The run detaches by default and ends
on `nexus ui --stop` or on `Stop server` in the page; `--foreground` keeps it
in the terminal, where Ctrl-C or SIGTERM stops it. The page shows every skill
of all three kinds in one
table and edits the global instructions in a GitHub-style editor with Edit
and Preview tabs, line numbers, soft wrap, and Cancel and "Save changes"
buttons ("Save", not "Commit", so the word is not confused with publish or
Git). The preview renderer is vendored in `~/.nexus`; the page makes no
network fetch.

The contract is recorded in
`docs/adr/0005-nexus-opens-one-loopback-listener-only-in-nexus-ui.md`:

- One listener, only in `nexus ui`, on `127.0.0.1` only.
- The server never touches `GLOBAL.md`, the Nexus lock, or any skill root.
  Every read and every mutation is a subprocess call to the CLI: `list
  --json`, `global show --json`, `global edit --if-match`, `update`, and
  `remove`. ADR 0004 is unchanged: the CLI is still the one writer of
  `GLOBAL.md`.
- Every request passes a loopback guard: loopback peer, exact `Host`,
  matching `Origin` when present, and a per-run Run Token in the URL path.
  Mutating requests need a JSON content type.

`docs/adr/0006-a-web-ui-run-is-recorded-in-a-run-file-and-can-be-stopped.md`
revises exactly one clause of ADR 0005 — "There is no detached mode, no pid
file, and no `stop` command" — and leaves every other clause standing. A run
records itself in a Run File in the Nexus home, holding its pid, its port, its
Run Token, and its mode, and removes the file when it ends. The Run File does
not widen the network surface: it is created at owner-only permissions, it
lives in the Nexus home and is never served by the page, it dies with the run,
and a reader who can open it already has your filesystem.

`docs/adr/0007-the-tray-is-a-windows-client-of-the-nexus-cli.md` adds the
Tray, the Windows notification-area client of the CLI, and states what it may
never do: it owns no state, it reads no Nexus file, and every action it takes
is a `nexus ui` call. ADR 0005 is unchanged by it — the Tray opens no socket
of its own, so it adds no network surface. See [The Tray](#the-tray).

### Start and stop

```bash
~/.nexus/scripts/nexus ui
~/.nexus/scripts/nexus ui --port 8765 --no-open
~/.nexus/scripts/nexus ui --foreground
~/.nexus/scripts/nexus ui --status
~/.nexus/scripts/nexus ui --stop
~/.nexus/scripts/nexus ui --open
```

`nexus ui` binds the port, prints the handshake line, detaches, and returns
your prompt, so starting the Web UI does not cost you a terminal. The
detached run ends on `nexus ui --stop` or on `Stop server` in the page.
`nexus ui --foreground` keeps the run in the terminal, where Ctrl-C or
SIGTERM stops it. Either way, on exit the run kills any CLI child still
running. The default port is ephemeral, chosen by the system; `--port N`
binds a fixed port. Exit codes: 0 on a clean stop, 1 when the port cannot be
bound, when a run is already live, when `python3` is missing, or when the
`web` directory in the Nexus home is absent, and 2 on usage.

Detaching happens after the bind, so a port that cannot be bound still exits
1 with its own message before anything detaches. A detached run has no
terminal for its diagnostics, so they go to the log `~/.nexus/ui.log`,
truncated at each start and owner-only, because a refusal line carries the
path it refused and so the Run Token. The handshake line still reaches
standard output.

One run at a time. `nexus ui` refuses to start while the Run File names a run
whose port still answers, prints that run's URL, and exits 1. Where the
recorded run does not answer, the Run File is stale: Nexus removes it and
starts normally.

Every run records itself in the Run File `~/.nexus/ui-run.json`, which holds
the run's pid, its port, its Run Token, and its mode. It is created at
owner-only permissions, because it holds the Run Token, and the run removes
it when it ends: on Ctrl-C, on SIGTERM, and after a shutdown request.

`nexus ui --status` prints the live URL of the recorded run, in the same
shape as the handshake line, and `nexus ui --stop` ends that run. Both are
whole modes and take no other flag; combining one with `--port`, `--no-open`,
or the other is a usage fault and exits 2. Both are questions rather than
assertions: they exit 0 whether or not a run exists, and print `nexus ui:
not running` when there is none.

`nexus ui --open` is the idempotent "show me the Web UI", and it is the
answer to a lost URL. Where the recorded run answers, it opens your browser
at that run and starts nothing; where no run is recorded, or the recorded one
does not answer, it removes any stale Run File, starts a Detached Run, and
opens your browser at the new one. Either way it prints the same handshake
line and exits 0, so a shortcut or a script needs no branch and reads no exit
code for meaning it does not carry. It never starts a second run while one is
live. `--open` is a whole mode too: combining it with `--port`, `--no-open`,
`--foreground`, `--status`, or `--stop` exits 2. Its exit codes are a start's:
0 on success, 1 when `python3` is missing, when `~/.nexus/web` is absent, or
when the port cannot be bound.

Both confirm the run over the loopback and never by pid. A recorded pid can
be reused by an unrelated process, but a port that answers the recorded Run
Token cannot be anything but the Nexus server, so `--status` probes the
recorded URL and `--stop` sends the same `POST api/shutdown` the page sends.
Where the probe fails the run is gone: Nexus removes the stale Run File and
reports `not running`. No Nexus command signals a pid it has not confirmed,
so there is no stale-pid hazard to reason about.

The first line on standard output is the handshake line, exactly:

```
nexus ui: http://127.0.0.1:PORT/t/TOKEN/
```

`TOKEN` is the Run Token: 32 hex characters from a cryptographic source,
new on every run, valid only while that run lives. After the handshake line
the server tries to open the browser with `$BROWSER`, then `xdg-open`,
`wslview`, and `explorer.exe`, in that order; every failure is silent, so
the printed URL is always the fallback. `--no-open` skips the attempt.

### Loopback guard

The listener binds `127.0.0.1` only. Every request passes four checks, in
this order, and the first failure answers 403 with one reason word as the
body (`peer`, `host`, `origin`, `token`) before any CLI child runs:

1. The peer address is loopback.
2. `Host` is exactly `127.0.0.1:PORT` or `localhost:PORT`.
3. When `Origin` is present, it equals `http://` plus that `Host`.
4. The path starts with `/t/TOKEN/`.

The `Host` check stops DNS rebinding, the `Origin` check stops a page on
another site from calling the endpoints, and the Run Token makes a guessed
port useless on its own. Mutating requests also need a JSON content type,
and the server answers no CORS preflight.

### Static files

The page is served from the `web` directory in the Nexus home, from an
allowlist of four files: `index.html`, `app.css`, `app.js`, and
`vendor/marked.min.js`. Any other path is 404, with no directory listing.
Every response carries `Cache-Control: no-store`; static files also carry
`Content-Security-Policy: default-src 'self'`, so no script, style, or
fetch leaves the page origin. The page is one HTML file, one CSS file, and
one JavaScript file with no build step and no framework.

### Endpoints and envelope

Every endpoint lives under `/t/TOKEN/api/` and is one CLI command:

| Endpoint | Command |
| --- | --- |
| `GET api/list` | `nexus list --json` |
| `GET api/global` | `nexus global show --json` |
| `PUT api/global` with `{content, ifMatch}` | `nexus global edit --if-match <ifMatch>`, `content` on standard input |
| `POST api/update` with `{name}` | `nexus update <name>` |
| `POST api/remove` with `{name}` | `nexus remove <name>` |
| `GET api/run` | none: it reports the run |
| `POST api/shutdown` | none: it stops the run |

Every answer is HTTP 200 with one JSON object: `command` (the argv the
server ran), `exit`, `stdout`, and `stderr`, plus `json` with the parsed
standard output when `exit` is 0 and the output parses. A CLI refusal is
`exit` 1 in the body with the CLI's own message, not an HTTP error, so the
page shows exactly what the command line shows. HTTP errors exist only for
the loopback guard (403), an unknown path or method (404), a mutating
request without `Content-Type: application/json` (415), a body that is not
a JSON object (400), and a second mutating request while one runs (409).

`POST api/shutdown` is the one endpoint with no CLI command behind it: it
stops the run. Because no command ran, it answers no envelope — there is no
`command` to report and no exit code to show, and inventing one would break
the one promise the envelope makes. It answers `200 {"stopping": true}`,
written and flushed before the listener closes, so the caller reads a result
rather than a dropped connection, and the page never shows it in Last
command. It passes the same loopback guard in the same order and, being a
mutating request, needs `Content-Type: application/json`. It does not take
the mutation lock, because a stop must work while a slow CLI child runs; the
stop then follows the path SIGTERM already takes and kills that child.
`GET api/shutdown` is 404, as any other unknown method-and-path pair is.

`GET api/run` is the read counterpart and the only other endpoint with no CLI
command behind it. It answers the run's pid, port, and mode — the same fields
the Run File records — and so answers no envelope either, and the page does
not show it in Last command.

### The run in the header

The header carries the run this page is served from: a badge with its state,
its mode, and its pid, next to a `Stop server` button. The badge is green
while the run is alive (`running · detached · pid 48213`, or
`running · this terminal · pid 48213` for a foreground run), and red when the
run cannot be reached. It reads `GET api/run`.

`Stop server` asks first. The dialog names what stopping costs — the Run Token
dies with the run, so this URL stops answering, and unsaved editor text is
lost — and says plainly that it runs no CLI command and changes nothing on
disk. Cancel changes nothing. Confirm sends `POST api/shutdown`, and on 200
the page becomes a calm stopped state: a grey `stopped` badge, one sentence
saying you stopped it, and `nexus ui` as the way back. The sub-nav and the
`Stop server` button go inert, because the run they act on is gone.

The badge keeps checking. It reads `GET api/run` again every five seconds, so
a tab left open in the background says whether the run is still alive: green
while the port answers, red as soon as it does not. One failed check is not
final, so a transient failure corrects itself. The check runs no CLI child and
never shows in Last command, and it stops for good once you stop the run from
the page, because a Run Token dies with its run.

The tab title carries the same state, because a narrow tab shows the title and
not the header: `Nexus` while the run is alive, `Nexus — not running` when it
is unreachable, and `Nexus — stopped` after you stop it. The page also carries
a favicon of the Nexus mark, inline in the HTML as a `data:` URI, so no file
joins the static allowlist. This is how you watch a background run without
typing `nexus ui --status`.

A run that ends without being asked to still shows the red `Connection lost.`
banner. That distinction is the point: one state for a choice, one for a
surprise.

### Pages and routes

Skills and Global Instructions are two pages, not two anchors in one
scrolling document. The route is the URL hash: `#/skills` and `#/global`.
Each renders one section, and the sub-nav marks the current route and
carries `aria-current="page"`, so a reload lands on the page you were on and
Back and Forward move between the two. An absent, empty, or unknown hash
resolves to `#/skills`.

The route is a hash and not a path, so no server change is needed: a path
route would force the server to serve `index.html` for paths outside the
four-file static allowlist. Nothing is destroyed on a route change, because
both sections stay in the page and are only toggled, so the Skills filter
text, the editor content, the banners, and the "Your unsaved version" panel
all survive it. Leaving `#/global` with unsaved edits asks first; refusing
leaves the route unchanged. The Last command panel sits outside both routes
and shows on both: it belongs to the run, not to a page.

### Skills table and Last command

The Skills table is `nexus list --json` as rows, grouped by kind: installed
first, then custom, then control. Each group is headed by the kind pill and
the count of the rows shown under it, and a kind with no rows is not drawn,
so an absent lock shows only the custom and control groups. Kind is the
group rather than a column, because it decides what a row can do. Inside a
group the rows keep CLI order, and each row is name, source, the
eight-character hash prefix with the full hash on hover, the update date as
a local date with the ISO timestamp on hover, and actions.

Two filters sit above the table and compose, so you can ask for one name
inside one kind. The kind filter picks `All kinds`, `Installed`, `Custom`,
or `Control`; the filter box narrows by name. The hint reads `N skills` when
neither filter narrows the table and `M of N skills` when either does, and
the table says `No skill matches these filters.` when nothing is left. An
installed skill row has Update and Remove buttons. A custom skill row says `Custom Skill: git
pull in ~/.custom-skills, then link`, and a control skill row says
`Control Skill: never updated or removed`; neither has a button. When the
lock is absent, an info banner above the table shows the CLI's own line
and points at `/nexus-setup`, and only custom and control skills are
listed.

The Last command panel at the bottom of the page shows the exact command
of the last call, an exit pill, a local timestamp, and standard output
followed by standard error in red, as preformatted text. It persists until
the next command. When a call cannot reach the server at all, a red banner
says `Connection lost. Rerun nexus ui, then nexus list to check.` and the
page does not retry on its own.

### Editor

The Global Instructions section reads `nexus global show --json` through
`GET api/global`. The header shows the owner path and one badge per
instruction path with its state word: `linked` (green), `foreign` (amber),
`absent` and `no home` (grey). A `foreign` badge adds one line under the
header with the exact fix, `mv <path> ~/.custom-skills/GLOBAL.md`, then
link; the entry is preserved until you move it.

The editor is modeled on the GitHub file editor. It is a `textarea` with a
line-number gutter that scrolls with the text, a line count, and Edit and
Preview tabs. Tab inserts two spaces at the caret, so focus stays in the
editor. The soft wrap toggle is remembered in the browser (`localStorage`)
and is on by default. The footer says that Save replaces the whole file and
that Nexus never runs Git, and has Cancel and "Save changes" buttons. The
word is Save; the page never says Commit or Publish.

When `GLOBAL.md` is absent the editor opens empty, a warning notice says
that the first save creates the file and runs link, and the badges show the
real states of both instruction paths. The page keeps the `sha256` it read
at open (the sha256 of the empty string when the file is absent), so a
later save can pass it as `--if-match`.

The Preview tab renders the text as Markdown with `marked`, vendored as one
minified file at `web/vendor/marked.min.js` with its license at
`web/vendor/LICENSE` (MIT). The pinned version is `marked` 15.0.12, named
in the header comment of the file; it is the last release that ships an
official minified single file. The page makes no network fetch, and the
content security policy blocks one. To update the renderer by hand:

1. Download the release file from the `marked` package (for a release
   after 15.0.12 that is `lib/marked.umd.js`) and its `LICENSE`.
2. Replace `web/vendor/marked.min.js` and `web/vendor/LICENSE`, keeping
   the file name, so the static allowlist and the page stay unchanged.
3. Update the version in this section and check the header comment of the
   new file names the same version.
4. Run `bash tests/run.sh`; the renderer test reads the version from the
   served file.

### Save and conflicts

"Save changes" and Ctrl+S send the whole editor content to `PUT api/global`
with the sha256 the page read at open, and the server runs `nexus global
edit --if-match <sha256>` with the content on standard input. When the file
was absent, the page sends the sha256 of the empty string, so the first
save creates the file and runs link; the link output, including any
foreign entry notice, shows in the Last command panel. On exit 0 a toast
says `Saved. Commit in ~/.custom-skills.`, the page reads the file again,
and the kept sha256 is updated. Nexus never runs Git; you commit the
change yourself.

A conflict is an exit 1 whose message names the expected and the actual
sha256: the file changed on disk since the page opened it. The page then
shows a red banner with both hashes, reloads the current file into the
editor, and moves your text to a read-only "Your unsaved version" panel
with a Copy button. Nothing is overwritten and nothing is lost, and there
is no overwrite button: copy what you need, edit again, and save. Any other
exit 1 shows the CLI message in a banner and keeps your text in the editor.

The page warns before the tab closes with unsaved edits, and Cancel asks
before it discards them. A request without `Content-Type: application/json`
is refused with 415 before any CLI child runs, and a body that is not one
JSON object with `content` and `ifMatch` strings is refused with 400.

### Update and remove

Update and Remove on an installed skill row run `nexus update <name>` and
`nexus remove <name>` through `POST api/update` and `POST api/remove`
with the body `{"name": "<name>"}`. The name is one argv element and never
goes through a shell; the CLI's own name checks are the only validation,
so a refused name comes back as the CLI's exit code and message in the
envelope. Custom and control rows have no button.

Update runs at once. The row shows a spinner and every other mutation
button is disabled until the response; the Last command panel shows the
result; then the page refetches `list` and `global`. Remove first opens a
dialog that names the command, explains that upstream deletes the skill
under the canonical root and that Nexus then publishes the lock and links,
and asks you to type the skill name. The Remove button in the dialog is
enabled only when the typed text equals the name byte for byte; Esc or
Cancel closes the dialog without running anything.

The server runs one mutating command at a time. A second mutating request
while one runs is answered 409, and the page says another command is
still running. Reads are not locked. A CLI child that runs longer than 300
seconds is killed together with its process group; the envelope then
carries exit 124 and a standard error line that names the timeout. The
environment variable `NEXUS_UI_TIMEOUT` (seconds) overrides the limit,
which the tests use with a short value.

## The Tray

The Tray is an icon in the Windows notification area that says whether a Web
UI run is live and holds the controls for one: Open, Copy URL, Start, Stop,
Open log, and Start at logon. It is the desktop door onto the Web UI, so the
URL you did not write down is never lost and starting or stopping a run costs
neither a terminal nor an agent session.

It is a client of the CLI and nothing more. It owns no state, it never reads
the Run File and never touches `GLOBAL.md`, the Nexus lock, or a skill root,
and every action it takes is one `nexus ui` call through `wsl.exe`. It opens
no listener: ADR 0005 is unchanged, and the one loopback connection the Tray
causes is your browser's. The decision and the boundary are in
`docs/adr/0007-the-tray-is-a-windows-client-of-the-nexus-cli.md`.

It exists on Windows because WSLg hosts no notification area, so it is the
one part of Nexus that is host-specific. Everything of it lives in `windows/`.

### Install and uninstall

Run this once, from Windows, in PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  \\wsl.localhost\<Distro>\<home>\.nexus\windows\install-tray.ps1
```

It works out the distribution and the Nexus home from the path it runs from,
so nothing is hardcoded and no configuration file is written; the values
reach the Tray as the arguments of the shortcut that starts it. It writes
exactly two places outside the Nexus home:

- the **Tray Home**, `%LOCALAPPDATA%\Nexus\Tray`, which holds a copy of the
  Tray, the opener behind the Start Menu shortcut, and the one shim that
  starts either of them with no window;
- your own shortcut folders, which get a Startup shortcut that starts the
  Tray at logon, and a Start Menu shortcut, `Nexus Web UI`, that opens the
  Web UI through `nexus ui --open` with no Tray in the picture at all.

The Tray runs from the Tray Home rather than from the Nexus home over
`\\wsl.localhost\`, because a Tray that lived in the Nexus home would boot
the distribution at every logon merely to read its own source.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  \\wsl.localhost\<Distro>\<home>\.nexus\windows\uninstall-tray.ps1
```

The uninstaller removes exactly those three paths, names each one it removed
or did not find, and stops a running Tray. It never reaches into the Nexus
home, `~/.custom-skills`, or an agent home, and it leaves a live run running.

On Windows 11 a new notification-area icon starts hidden. Click the chevron
(`^`) beside the clock and drag the Nexus icon onto the taskbar to keep it
there. There is no reliable scripted way to promote an icon, so this is
written down rather than automated.

### What it shows

The Tray asks `nexus ui --status` every five seconds - never `--open`, so
watching the state can never start a run - and shows the answer:

| `nexus ui --status` | Icon | Tooltip |
| --- | --- | --- |
| `nexus ui: <url>` | green | `Nexus - running (port N)` |
| `nexus ui: not running` | grey | `Nexus - stopped` |
| the call fails | amber | `Nexus - WSL not available` |

Amber is its own state because "cannot ask" and "not running" are different
answers. Before each poll the Tray asks Windows whether the distribution is
already running, and asks Nexus nothing while it is not: it shows the state,
it does not create it.

A balloon appears only when a run ends without being asked to. A stop you
asked for is your own choice and is never reported back to you as an event.

### The menu

- **Open Nexus UI** (also a double-click) runs `nexus ui --open` and hands
  the URL it prints to your default browser. It opens the live run when there
  is one and starts one when there is not, so one gesture always ends with
  the page in front of you. The Tray hands the URL over itself because the
  opener inside the distribution has no Windows desktop to open a page on;
  the Start Menu shortcut does the same, which is why it goes through
  `nexus-open.ps1` rather than straight at `wsl.exe`.
- **Copy URL** puts the live run's URL, Run Token and all, on the clipboard.
  That is the one place the token reaches on the Windows side; it is written
  to no file there.
- **Start** runs `nexus ui --no-open`. It is offered when no run is live, and
  starting from the amber state boots the distribution first.
- **Stop** runs `nexus ui --stop`, the same request the page's `Stop server`
  button sends, so the three doors cannot disagree about what stopping means.
  It is offered only when a run is live.
- **Open log** opens `~/.nexus/ui.log`, where a detached run's diagnostics go.
- **Start at logon** writes or removes the Startup shortcut.
- **Quit** removes the icon at once and leaves a live run alive: closing the
  control surface never closes the Web UI behind your back.

The Tray starts nothing at logon. It shows the state, so logging in costs no
distribution boot, no listener, and no memory. A second launch adds no second
icon, and no console window appears at logon or on any action.

### What is not tested

The Tray has no automated coverage. It is Windows PowerShell and the suite is
bash in the distribution, so `tests/run.sh` asserts only that the Windows files
ship. `windows/CHECKLIST.md` is the manual walk-through that stands in for
it: install, every state, every menu item, the balloon, one instance, logon,
the Start Menu shortcut, and uninstall. Walk it on the host after any change
under `windows/`. The one part of this that the suite does cover is
`nexus ui --open`.

## Troubleshooting

- **Already initialized:** setup is intentionally disabled; use `/nexus-link`,
  `$nexus-link`, or the CLI link command.
- **Missing, conflicting, or invalid lock:** provide one valid version-3 lock
  in the supported `~/.agents`/`~/.skills` locations, remove ambiguity, and
  retry. Nexus does not guess between conflicting candidates.
- **Changed agent homes or bounded backup retries:** close Claude and Codex,
  inspect the retained backup/recovery paths, then retry setup.
- **Collision:** preserve the foreign entry, resolve it manually,
  and rerun link or bootstrap as appropriate.
- **Foreign entry at an instruction path:** your instruction file has not been
  migrated. Move it to `~/.custom-skills/GLOBAL.md` and rerun link; nothing
  was lost.
- **Global instructions must be a regular file:** `~/.custom-skills/GLOBAL.md`
  is a symlink or a directory. Replace it with a regular file and rerun link.
- **NVM/npx:** ensure direct `npx` works, or install/select a default NVM Node
  version. Nexus only loads NVM as the fallback when `npx` is unavailable.
- **Upstream failure:** inspect the `npx skills` error and any reported
  untracked directories; the prior Nexus lock is preserved.
- **Retained temporary/residue paths:** read the command's exact path and
  recovery message first. Keep a copy until the situation is understood, then
  correct the cause before rerunning.
- **`nexus ui` exits 1 at start:** the port from `--port N` is in use, or
  `python3` is missing, or `~/.nexus/web` is absent. Pick another port or
  omit `--port` for an ephemeral one.
- **The page says "Connection lost":** the server stopped or the terminal
  that ran it closed. Rerun `nexus ui`, open the new URL (the Run Token
  changed), and run `nexus list` to check the state.
- **403 with `token`, `host`, or `origin`:** the URL lacks the current Run
  Token, or the request did not come from the page itself. Use the exact
  URL from the handshake line; a bookmark from an earlier run is stale.
- **The browser did not open:** the printed URL is the fallback. Copy it
  from the handshake line; set `$BROWSER` to change the opener.
- **The tray icon is amber:** the distribution is not running, so Nexus
  cannot be asked anything. `Start` boots it and starts a run; nothing else
  in the menu speaks for a distribution that is down.
- **No tray icon after the install:** on Windows 11 a new notification-area
  icon starts hidden. Click the chevron (`^`) beside the clock and drag the
  Nexus icon onto the taskbar.
- **"Not saved. GLOBAL.md changed on disk":** the file changed after the
  editor read it. Your text is kept in the "Your unsaved version" panel;
  copy it, apply it to the reloaded file, and save again.
- **Another command is still running (409):** one upstream command at a
  time. Wait for the Last command panel to show its result, then retry.

## Adding another agent

To add another agent, update the code mappings for its native skill root and
link target, add bootstrap links and any invocation adapter, include it in
managed ownership and link, and decide how its backup and setup
preflight should work. Add isolated tests for bootstrap, collisions, link, setup backup/recovery, and install behavior; update this
README with its invocation forms and recovery semantics. Keep the Nexus lock
authoritative and keep the agent's foreign entries untouched. The
phrase “another agent” here is intentional: adding one is a coordinated
ownership change, not merely another symlink.

## Safety contract

Bootstrap only exposes Nexus control entries. Setup is explicit and is **not**
run by bootstrap. Setup backs up before link changes, never silently
overwrites backups, and reports recovery paths. Install requires explicit
source and skill names and does not `eval` arguments.
