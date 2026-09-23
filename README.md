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

To change Nexus rather than use it, read [`CONTRIBUTING.md`](CONTRIBUTING.md)
and the "Develop" section below.

## Requirements and first use

Project scripts use Bash 5, GNU coreutils, `jq`, and Python 3 (`python3`). Git
is needed for Git-based sources and normal development; npm/npx is an upstream
prerequisite for installation. Setup preflight checks `jq`, `python3`, and the
required core utilities; it does not check Git, npm, npx, or NVM. Install first
uses a directly available `npx`; if it is unavailable, NVM is the fallback.

Nexus is installed by cloning it into its home directory:

```bash
git clone https://github.com/luanAfons0/nexus.git ~/.nexus
```

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
| Open the page: list, update, remove, edit global instructions | `/nexus` | `$nexus` |

The equivalent CLI is `~/.nexus/scripts/nexus {setup,link,install,update,remove,new,list,check,global,help}`.

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
`NEXUS_HOME`; never use real agent roots for tests. `skill-lock.json` and
`skill-check.json` are gitignored and should not be committed.

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
the page. `skills` is an array sorted by name; each row has
`name`, `kind`, `source`, `hash` (the full `skillFolderHash`, not the
eight-character prefix), and `updatedAt`, with null for the last three on
custom and control rows. `globalInstructions` has the same shape as `global
show --json` without `content`. When the lock is absent the info line goes
to standard error, so standard output stays valid JSON. The table output
without the flag is unchanged.

`nexus help` (also `-h` and `--help`) prints the usage line and one line per
subcommand: `bootstrap`, `setup`, `link`, `install`, `update`, `remove`,
`new`, `list`, `check`, `global`, and `help`.

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

## Checking which skills are behind

`nexus check` asks GitHub which installed skills upstream has moved on from,
and changes nothing:

```bash
~/.nexus/scripts/nexus check
~/.nexus/scripts/nexus check --json
```

A skill is **behind** when the folder it came from has a commit newer than the
moment that skill was installed or last updated. For each installed skill in
the Nexus lock, check asks `gh` for the last commit that touched that skill's
folder in its repository and compares that commit's date with `updatedAt`.
The lock's `skillFolderHash` cannot answer this: it is upstream's own hash,
the algorithm is not Nexus's, and the lock records no commit, tag or version.

Every skill comes back as one of three words. `current` is a folder upstream
has not touched since; `behind` is one it has; `unknown` is a repository that
could not be reached, a lock row with no date, and never good news. The table
prints name, state, source, `updatedAt` and the upstream commit date, then one
line per unknown skill saying why, then the counts and the moment the check
ran. `--json` prints the same document.

Check applies nothing: no skill, no link, and no line of the Nexus lock
changes. Applying stays `nexus update <name>`, which you run yourself.

The result is written to `~/.nexus/skill-check.json`, beside the lock and
never inside it, with `checkedAt`, `counts`, and one row per skill carrying
`state`, `source`, `folder`, `updatedAt`, `committedAt` and, for an unknown
skill, `reason`. It is gitignored, because the lock is authoritative and
versioned while a check result goes stale by itself.

Check needs `gh` on the path and logged in. A missing `gh`, a `gh` that is not
logged in, an absent lock and an invalid lock are each one sentence and exit 1;
a repository that cannot be reached is not a failure of the check, it is one
`unknown` row with the reason `gh` gave.

### Reading the last result

```bash
~/.nexus/scripts/nexus check --last
~/.nexus/scripts/nexus check --last --json
```

`--last` prints `~/.nexus/skill-check.json` as it stands and asks GitHub
nothing, so it needs neither `gh` nor the lock. It is the road for a reader
rather than an asker: the page marks its rows from it every time somebody
opens it, and a page that reached GitHub on each load would be a check nobody
asked for. The table and the `--json` document are the same ones `nexus
check` prints.

A result that is not there and a result that is not readable are each one
sentence and exit 1: `no check has run yet: run nexus check to write
<path>`, and `the check result is unreadable: run nexus check to write <path>
again`. Neither says that anything is current.

## The nexus launcher skill

`/nexus` in Claude and `$nexus` in Codex print the address of the page and
end. The skill starts nothing: the FirstMate Host serves the page and runs
the Nexus Plugin Server, so there is no run for an agent session to own and
no handshake line to wait for. It reads the port and the token out of
`~/.firstmate/runtime.json` and prints one URL. Where the Host is not
running, it says so and names the command that starts it.

The printed URL is the contract. Nothing here opens a browser: from an agent
sandbox that usually fails, so open the URL by hand or use FirstMate's Tray.
The skill never runs install, setup, link, update, remove, or global itself;
the page does those through the same CLI, so the same refusals apply.

## The page

Nexus ships a page in `web/` and an executable `mcp` beside it, and the
FirstMate Host does the rest: it runs `mcp` as the Nexus Plugin Server, serves
`web/` byte for byte at `http://127.0.0.1:4747/p/nexus/`, and admits the
browser with a cookie it sets on the first navigation. Nexus opens no
listener, mints no token, and records no run.

The page shows every skill of all three kinds in one table and edits the
global instructions in a GitHub-style editor with Edit and Preview tabs, line
numbers, soft wrap, and Cancel and "Save changes" buttons ("Save", not
"Commit", so the word is not confused with publish or Git). The preview
renderer is vendored in `~/.nexus`; the page makes no network fetch.

The contract is recorded in
`docs/adr/0008-nexus-is-a-firstmate-plugin.md`:

- Nexus is a directory holding a `web/` folder and an executable `mcp`, and
  asks nothing else of anyone.
- The Plugin Server never touches `GLOBAL.md`, the Nexus Lock, or any skill
  root. Every tool is a subprocess call to the CLI: `list --json`, `check
  --json`, `check --last --json`, `global show --json`, `global edit
  --if-match`, `update`, and `remove`. ADR 0004 is unchanged: the CLI is still
  the one writer of `GLOBAL.md`.
- The Host defends the address. It binds `127.0.0.1` only, checks the `Host`
  header and the `Origin` and `Sec-Fetch-Site` of every request, requires the
  token it minted at its own startup, and lets a Plugin Page reach only its
  own Plugin.

ADR 0008 supersedes
`docs/adr/0005-nexus-opens-one-loopback-listener-only-in-nexus-ui.md`,
`docs/adr/0006-a-web-ui-run-is-recorded-in-a-run-file-and-can-be-stopped.md`
and `docs/adr/0007-the-tray-is-a-windows-client-of-the-nexus-cli.md`. All
three are kept as a record of why Nexus once owned a listener, a Run File and
a Tray, and each one names what replaced it.

### Open it

`/nexus` (`$nexus` in Codex) prints the address. So does FirstMate's own Tray,
which opens its Index Page, from which every Plugin is one click away.

The Host has to be running:

```sh
systemctl --user status firstmate
```

The address never changes, so it can be bookmarked. The token is in
`~/.firstmate/runtime.json`, readable by you alone, and it reaches the browser
once: the Host answers the first navigation with a cookie and sends the
browser to the clean address, which is why the page's relative paths are
undisturbed.

### Tools and envelope

The page reaches its own tools with one relative `POST` to `rpc`, whose body
is an MCP JSON-RPC request. Seven tools stand where the HTTP API stood, and
each one is a CLI command:

| Tool | Command |
| --- | --- |
| `list_skills` | `nexus list --json` |
| `check_skills` | `nexus check --json` |
| `show_check_result` | `nexus check --last --json` |
| `show_global_instructions` | `nexus global show --json` |
| `update_skill` with `{name}` | `nexus update <name>` |
| `remove_skill` with `{name}` | `nexus remove <name>` |
| `edit_global_instructions` with `{content, ifMatch}` | `nexus global edit --if-match <ifMatch>`, `content` on standard input |

Every answer carries one JSON object: `command` (the argv the server ran),
`exit`, `stdout`, and `stderr`, plus `json` with the parsed standard output
when `exit` is 0 and the output parses. A CLI refusal is `exit` 1 in the
envelope with the CLI's own message, not an error, so the page shows exactly
what the command line shows.

That object is the structured half of every answer, `check_skills` included,
and the text half repeats it — except for `check_skills`, whose text half is
one plain sentence:

```
37 Installed Skills: 28 current, 9 Behind, 0 unknown. Checked 2026-09-23T01:42:19Z.
```

A caller on the Tool Bus shows one sentence of what a tool answered, and how
many installed skills are behind is the whole question the check exists to
answer. The document is untouched: the page and every other caller read it
from the structured half as before.

A call the Plugin Server will not run answers a JSON-RPC error instead of an
envelope: `-32602` for a tool that is not there or an argument that is not a
string, and `-32000` for a second change while one runs. `check_skills` is the
one tool that also answers `-32603` for a run that failed, carrying the
sentence the CLI ended with: it is there for a caller on the Tool Bus that has
to decide an outcome, and an outcome cannot be read out of a successful result
(ADR 0009). One change runs at a
time; reads are never locked, so a slow update cannot stop the page from
listing skills.

The Host answers its own refusals with a status and no envelope: 403 for a
request that is not this page's, 404 for an unknown Plugin, and 503 when the
Plugin Server is Stopped.

Any of it can be driven from a terminal:

```sh
token=$(python3 -c "import json;print(json.load(open('$HOME/.firstmate/runtime.json'))['token'])")
curl -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_skills","arguments":{}}}' \
  "http://127.0.0.1:4747/p/nexus/rpc?token=$token"
```

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
leaves the route unchanged. The Last command button floats outside both
routes and shows on both: it belongs to the run, not to a page.

### Skills table and Last command

The Skills table is `nexus list --json` as rows, grouped by kind: installed
first, then custom, then control. Each group is headed by the kind pill and
the count of the rows shown under it, and a kind with no rows is not drawn,
so an absent lock shows only the custom and control groups. Kind is the
group rather than a column, because it decides what a row can do. Inside a
group the rows keep CLI order, and each row is name, source, the
eight-character hash prefix with the full hash on hover, the update date as
a local date with the ISO timestamp on hover, the upstream mark, and actions.

### Behind rows

The Upstream column is the last check as the page read it, through
`show_check_result`. An installed row reads `Behind`, `current`, or
`unknown`; a custom or control row, and an installed row the check does not
cover, read `–`. The mark is the word, never the colour alone: `Behind` is
the one in amber and bold, `unknown` keeps its own word and a broken edge so
it is never read as `current`, and hovering a mark says when upstream moved,
or why the check could not say. The column survives every narrow screen,
because it is what says whether Update is worth pressing.

Next to the skill count, the header says when the check last ran, as a local
moment with the ISO timestamp on hover, and adds `· N Behind, N unknown`
when there is anything to add. Before any check has run it says `No check has
run yet, so no row is marked: run nexus check.`, and a result that cannot be
read says `No row is marked.` and then the CLI's own sentence. In both cases
the list works and no row is marked; an unmarked list is a list nobody has
checked, not a list that is all current.

The page reads the check's result and never runs a check: nothing on it
reaches GitHub, and Update stays the button a person presses. When an update
or a remove succeeds, that skill's mark and its share of the header count go
at once, because the result on disk was written before the command ran. The
next check writes what is true then.

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

The Last command button floats at the bottom right of the page. Its dot is
empty until a command runs, then green for exit 0 and red for any other
exit. Pressing it opens a dialog with the exact command of the last call,
an exit pill, a local timestamp, and standard output followed by standard
error in red, as preformatted text. Escape, Close or a click outside the
dialog closes it. It persists until the next command, and a banner that
points at the output links straight to it. When a call cannot reach the server at all, a red banner
says `Connection lost. The FirstMate Host is not answering. Check it with
systemctl --user status firstmate.` and the page does not retry on its own.

### Editor

The Global Instructions section reads `nexus global show --json` through
`show_global_instructions`. The header shows the owner path and one badge per
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

"Save changes" and Ctrl+S send the whole editor content to
`edit_global_instructions` with the sha256 the page read at open, and the
Plugin Server runs `nexus global edit --if-match <sha256>` with the content
on standard input. When the file
was absent, the page sends the sha256 of the empty string, so the first
save creates the file and runs link; the link output, including any
foreign entry notice, shows in the Last command dialog. On exit 0 a toast
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
`nexus remove <name>` through `update_skill` and `remove_skill` with the
argument `{"name": "<name>"}`. The name is one argv element and never
goes through a shell; the CLI's own name checks are the only validation,
so a refused name comes back as the CLI's exit code and message in the
envelope. Custom and control rows have no button.

Update runs at once. The row shows a spinner and every other mutation
button is disabled until the response; the Last command dialog holds the
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
- **Check says `unknown` for every skill:** `gh` cannot reach GitHub. Run `gh
  auth status`, then `gh auth login`. Nothing was changed; the rows carry the
  reason `gh` gave.
- **The page does not open:** the Host is not running. Check it with
  `systemctl --user status firstmate`, and read it with `journalctl --user -u
  firstmate`. The Plugin Server's own output is in the same journal.
- **The Index Page shows nexus as Stopped:** the Host could not run `mcp`, or
  it exited. `journalctl --user -u firstmate` names the reason. Check that
  `~/.nexus/mcp` is executable and that `python3` is there.
- **The page says "Connection lost":** the Host stopped. Start it with
  `systemctl --user start firstmate` and reload; the address does not change.
- **403 with `token`, `host`, or `origin`:** the request did not carry the
  Host's token or did not come from the page itself. Open the address from
  `/nexus` or from the Tray; the token changes at every Host start, so a
  bookmark that carries one is stale. A bookmark of the plain address is not.

## Develop

Nexus is installed by cloning, but a clone you work in does not have to live
at `~/.nexus`: the CLI finds its own files from the path of `scripts/nexus`,
and the home directory it manages comes from `$HOME`.

```bash
git clone https://github.com/luanAfons0/nexus.git
cd nexus
bash tests/run.sh
```

`bash tests/run.sh` is the whole suite and its only entry point. Every test
builds its own home directory under a temporary root and drives the CLI over
its command line. The `Check` workflow runs that one command on
`ubuntu-latest` for every pull request.

To try a change by hand, never point it at your own agent context. Use the
sandbox home:

```bash
scripts/dev-home bootstrap     # link the control skills, in the sandbox
scripts/dev-home list          # what the sandbox home holds
scripts/dev-home setup         # the real setup, against throwaway files
scripts/dev-home --reset list  # start the sandbox home again from empty
```

`scripts/dev-home` runs `scripts/nexus` with `$HOME` pointed at
`.scratch/home` inside the repository, which Git ignores, so the canonical
root, the custom root, both native skill roots and both instruction paths all
land there. It refuses to run if the sandbox would hold your real home, and it
deletes only a directory it marked as its own. `NEXUS_DEV_HOME` moves the
sandbox elsewhere.

Changes to `web/` or `mcp` need a running FirstMate Host, which serves the
page and runs the Plugin Server (ADR 0008). Register your clone as a Plugin
from the FirstMate repository with
`node src/cli.ts add nexus /absolute/path/to/your/clone`, then open
`http://127.0.0.1:4747/p/nexus/`.

[`CONTRIBUTING.md`](CONTRIBUTING.md) has the rest: where a new test goes, how
the code is written, the commit and pull request conventions, and the safety
properties a change may not weaken.

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
source and skill names and does not `eval` arguments. Check is read-only: it
asks GitHub, writes only `~/.nexus/skill-check.json`, and applies nothing.
