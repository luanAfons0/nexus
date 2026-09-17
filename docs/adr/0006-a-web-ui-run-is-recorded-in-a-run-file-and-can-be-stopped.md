# 0006. A Web UI run is recorded in a Run File and can be stopped

## Status

Accepted, then superseded

Superseded by ADR 0008. There is no run to record: the Host owns the
lifetime, and the Run File is gone.

Revises ADR 0005 in part.

## Context

ADR 0005 says, in one clause: "There is no detached mode, no pid file, and
no `stop` command." That clause has three costs the user meets every day.

A Web UI run owns a terminal, so it owns the agent session that started it.
The `nexus` Control Skill works around this with `nohup … & disown` inside
the chat's shell, which ties the run to that session. The user cannot ask
whether a run exists, cannot get the URL back once the handshake line has
scrolled away, and cannot hand a run over to another session.

There is no way to end a run except to find the process and kill it. From
the page there is no way at all: the only feedback is the red `Connection
lost.` banner, which reads as a failure even when the user meant to stop.

The clause was written to keep the network surface one line the user can
see. That goal is met by a run that is recorded and stoppable just as well
as by a run that holds a terminal, as long as the record is owner-only and
dies with the run, and as long as no command ever signals a process it has
not confirmed.

## Decision

`nexus ui` records the one live run in a **Run File** in the Nexus home,
holding the run's pid, its port, its Run Token, and whether it is a
**Detached Run** or a **Foreground Run**. `nexus ui` detaches by default and
returns the prompt; `nexus ui --foreground` keeps the run in the terminal,
where Ctrl-C and SIGTERM stop it. The run removes the Run File when it ends.

Nexus grows two modes that read the Run File: `nexus ui --status` prints the
live URL of the recorded run, and `nexus ui --stop` ends it. Both are
questions, not assertions: they exit 0 whether or not a run exists.

Both confirm the run over the loopback, never by pid. A recorded pid can be
reused by an unrelated process; a port that answers the recorded Run Token
cannot be anything but the Nexus server. `--status` probes the recorded URL
and `--stop` sends `POST api/shutdown`, the same request the page sends.
Where the probe fails, the run is gone: Nexus removes the stale Run File and
reports `not running`. No command in Nexus signals a pid it has not
confirmed, so there is no stale-pid hazard.

One run at a time. `nexus ui` refuses to start while the Run File names a
run whose port still answers, prints that run's URL, and exits 1.

`POST api/shutdown` is the one mutating endpoint with no CLI command behind
it. It passes the same loopback guard in the same order and needs a JSON
content type, but it does not take the mutation lock, because a stop must
work while a slow CLI child runs, and it answers no `{command, exit, stdout,
stderr}` envelope, because no command ran. It answers `200 {"stopping":
true}`, written and flushed before the listener closes.

The Run File holds the Run Token, and that does not widen the network
surface:

- It is created at owner-only permissions, so no other account on the
  machine can read the Run Token from it.
- It lives in the Nexus home, beside the Nexus Lock, on the user's own
  filesystem, and is never served by the Web UI: the static allowlist is
  four files in the `web` directory.
- It dies with the run. The Run Token it holds is already worthless when the
  run ends, because the token is generated once per run.
- A reader who can open it already has the user's filesystem, and so already
  has everything the Web UI could give them.

Everything else in ADR 0005 stands, unchanged:

- Nexus opens exactly one network listener, only in `nexus ui`, bound to
  `127.0.0.1`.
- The server never touches `GLOBAL.md`, the Nexus Lock, or any skill root.
  Every read and every mutation except `POST api/shutdown` and `GET api/run`
  is a subprocess call to the Nexus CLI, and the CLI is still the one writer
  of every file (ADR 0004).
- The loopback guard keeps its four checks in their order: loopback peer,
  exact `Host`, matching `Origin` when present, Run Token in the path. A
  mutating request still needs a JSON content type, and the server still
  answers no CORS preflight.
- One mutating CLI command runs at a time, and a CLI child that runs too
  long is killed and reported.

## Consequences

- The network surface is still one line, and the user can now ask about it:
  `nexus ui --status` answers where the listener is, and `nexus ui --stop`
  closes it.
- The terminal is no longer the one place a run lives, so the `nexus`
  Control Skill runs one plain command that ends, and the run outlives the
  agent session that started it.
- A detached run has no terminal for its diagnostics, so they go to a log in
  the Nexus home, truncated at each start. The handshake line still reaches
  standard output, so the contract the Control Skill reads is unchanged.
- The Nexus home gains one file that is state rather than configuration. It
  is self-healing: any command that finds a Run File whose port does not
  answer removes it.
- `POST api/shutdown` and `GET api/run` are the two endpoints that answer no
  envelope. The page never shows them in `Last command`, because there is no
  command to show.
- Stopping from the page is a choice, so the page must not report it as a
  failure. The `Connection lost.` banner keeps its wording for a run that
  ended without being asked to.
