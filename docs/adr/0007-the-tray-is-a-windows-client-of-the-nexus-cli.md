# 0007. The Tray is a Windows client of the Nexus CLI

## Status

Accepted

ADR 0005 and ADR 0006 stand unchanged.

## Context

The Web UI is real, but it has no door on the desktop.

A run is reached at `http://127.0.0.1:<port>/t/<token>/`. The port is
ephemeral and the Run Token is generated once per run, so the URL is
different every time, cannot be bookmarked, and is printed once in the
handshake line. `nexus ui --status` prints it again, but only to someone who
already has a terminal open in the distribution. In practice the user opens an
agent session and asks the `nexus` Control Skill for the link again, which
is a heavy way to reopen a page.

There is also no way to start a run, stop it, or ask whether one exists
without first opening a terminal or an agent session, and a Detached Run is
invisible: nothing on the machine says that a listener is open, on which
port, or that it died when Windows last restarted.

Every other resident tool on the machine answers this with an icon in the
notification area. Nexus cannot answer it from inside the distribution: WSLg
presents individual windows over RDP and hosts no notification area, so a
client running beside the CLI would have nowhere to appear. The control
surface has to live on the Windows host, which makes it the first part of
Nexus that is not portable.

Three questions were open:

1. What a host-side client is allowed to know and to touch.
2. Where it reads the state of a run from.
3. Where it lives on disk, and what installing it writes.

## Decision

The **Tray** is a Windows notification-area client of the Nexus CLI, in
exactly the sense the Web UI page is already a client of it.

**The Tray owns no state.** It never reads the Run File, and never touches
`GLOBAL.md`, the Nexus Lock, or a Native Skill Root. It opens no listener.
Every action it takes is a `nexus ui` call through `wsl.exe`: `--status` to
watch, `--open`, `--no-open` and `--stop` to act. Its whole picture of the
world is the two lines `--status` already prints, plus the failure of the
call itself.

**It watches through the CLI rather than by reading the Run File**, because
that costs little enough to be uninteresting: `nexus ui --status` through
`wsl.exe` was measured at 220-245 ms warm, and the Tray asks every five
seconds. So the Run File keeps the single owner ADR 0006 gave it, and the
Web UI keeps one contract instead of two. Watching never uses `--open`, so
looking at the state can never start a run the user did not ask for.

**It runs from a Windows-side Tray Home**, `%LOCALAPPDATA%\Nexus\Tray`, and
not from the Nexus home over `\\wsl.localhost\`. A Tray launched from the
Nexus home would boot the distribution at every logon merely to read its
own source, and could never honestly report a state while the distribution
is down. For the same reason it asks Windows which distributions are running
before it asks Nexus anything, and asks nothing while the distribution is
stopped: the Tray shows the state, it does not create it. A stopped
distribution is reported as its own state, because "cannot ask" and "not
running" are different answers and must not be confused.

**Installing it copies Nexus content outside the Nexus home for the first
time.** That is why the install is explicit, run by the user from Windows,
and confined to exactly two places outside the Nexus home: the Tray Home,
and the user's own shortcut folders, which receive a Startup shortcut that
starts the Tray and a Start Menu shortcut on `nexus ui --open`. The
uninstaller removes exactly those and nothing else; it never reaches into
the Nexus home, the Custom Root, or an Agent Home. Install and uninstall are
PowerShell scripts, not a `nexus` subcommand, so the CLI does not grow a
mode the suite cannot reach.

**The Run Token is never written to a file on the Windows side.** It reaches
the Tray in the output of a `nexus ui` call, lives in memory for as long as
that run does, and leaves only when the user asks for it: Copy URL puts it
on the clipboard, and Open hands it to the default browser.

**ADR 0005 is unchanged.** Nexus still opens exactly one network listener,
only in `nexus ui`, bound to `127.0.0.1`. The Tray adds no network surface:
it opens no socket at all, and the one connection it causes is the browser's,
to the same loopback URL the handshake line already prints. It is a loopback
client exactly as the browser is.

## Consequences

- Nexus gains a part that is host-specific. It is confined to `windows/` in
  the repository, so a reader who works only on the POSIX side can see at a
  glance which part of the tree is not theirs.
- The Tray has no automated coverage. The suite is bash and runs in the
  distribution; the Tray is Windows PowerShell and runs on the host. The suite
  asserts that the Windows files ship and nothing more, and the Tray is
  verified against the written checklist in `windows/CHECKLIST.md`. The one
  part of this work the suite does cover is the new CLI verb.
- The CLI grows exactly one verb for all of this, `nexus ui --open`: the
  idempotent "show me the Web UI". A plain Windows shortcut on that verb is
  a working door even with no Tray running.
- The Tray reads state out of command output, so a change to the shape of
  the handshake line would leave it blind. That shape is already depended on
  by the `nexus` Control Skill and by the suite, so it is a line Nexus does
  not move quietly.
- A control surface that shows state and starts nothing costs a logon no
  distribution boot, no listener, and no memory.
