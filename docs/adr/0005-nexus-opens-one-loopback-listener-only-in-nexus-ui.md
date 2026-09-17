# 0005. Nexus opens one loopback listener, only in `nexus ui`

## Status

Accepted, then superseded

Superseded by ADR 0008. Nexus opens no listener: the FirstMate Host binds
the loopback address and serves the page.

Superseded in part by ADR 0006.

## Context

Every Nexus command so far is a short process that reads or writes local
files and exits. The user wants a real editor for the Global Instructions
and one page for the skills of both agents. A chat menu cannot show line
numbers, a preview, or the exact CLI output, and every change is a round trip
through the agent. A local web page can. A web page needs a process that
serves it and that runs the CLI for it, so Nexus must listen on a socket.

Three questions were open:

1. Where the listener binds and how long it lives.
2. Whether the server may read or write files itself.
3. What stops another page in the same browser, or another machine, from
   calling the endpoints.

## Decision

Nexus opens exactly one network listener, only in `nexus ui`, bound to
`127.0.0.1`. It never listens on any other address, never opens a listener
in any other command, and runs in the foreground until Ctrl-C or SIGTERM
stops it. There is no detached mode, no pid file, and no `stop` command.

The server never touches `GLOBAL.md`, the Nexus Lock, or any skill root.
Every read and every mutation is a subprocess call to the Nexus CLI:
`list --json`, `global show --json`, `global edit --if-match`, `update`, and
`remove`. The page shows the exact command, exit code, and output of each
call. ADR 0004 stays accepted and unchanged: the CLI is still the one writer
of `GLOBAL.md`, and the same preflight rules apply on the command line, in
the chat, and on the page.

Every request passes a loopback guard, in this order: the peer address must
be loopback; the `Host` header must name the bound address and port; a
present `Origin` header must match the Host origin; and the path must start
with `/t/<Run Token>/`. The Run Token is 32 hex characters from a
cryptographic source, generated per run, and printed once in the handshake
line. Mutating requests must carry a JSON content type, and the server
answers no CORS preflight, so a cross-site form cannot reach them. One
mutating command runs at a time, and a CLI child that runs too long is
killed and reported.

## Consequences

- The network surface of Nexus is one line: a loopback listener that exists
  only while `nexus ui` runs in a terminal the user can see.
- The page cannot do anything the CLI refuses. A refusal is exit 1 in the
  response body, with the CLI's own message, not an HTTP error.
- The `Host`, `Origin`, and content-type checks are enough on their own; the
  Run Token is kept as a second, independent barrier, so a guessed port is
  not a usable endpoint.
- Python 3 is already a Nexus requirement, and its standard library holds
  the HTTP server, so no runtime dependency is added. The Markdown renderer
  for the preview is a vendored browser file with its license; the page
  makes no network fetch.
- A long upstream command can still block the page for up to the timeout;
  a job queue or progress stream is out of scope until it is needed.
