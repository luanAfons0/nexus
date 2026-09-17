# 0008. Nexus is a FirstMate Plugin

## Status

Accepted

Supersedes ADR 0005, ADR 0006 and ADR 0007. ADR 0004 stands unchanged: the
CLI is still the one writer of `GLOBAL.md`.

## Context

ADR 0005 gave Nexus one network listener so that it could have a page. ADR
0006 gave that run a Run File so that it could be found and stopped. ADR 0007
gave it a Tray so that it could be opened without a terminal. Each answered a
real problem, and none of them was about managing an Agent Context.

By the end of it Nexus owned an HTTP server, a static file allowlist, a
loopback guard, a per-run token, a detach-and-record protocol, a stale-run
probe, five PowerShell files and a written checklist for the part the suite
could not reach. Roughly a third of the tree, and thirty-four of its tests,
were there to serve one page.

The `daily` skill hand-built the same runtime a second time, separately.
FirstMate was built because of that duplication: it is a Host that gives any
Plugin a process, a page and an address, so that no tool has to build a
runtime of its own. Nexus is its first Plugin, and the whole point of the
exercise is that the second tool does not repeat this.

## Decision

**Nexus is a FirstMate Plugin.** It is a directory holding a `web/` folder
and an executable named `mcp`, and it asks nothing else of anyone.

**Nexus opens no listener.** The Host binds `127.0.0.1`, mints the token,
validates `Host`, `Origin` and `Sec-Fetch-Site`, and serves `web/` byte for
byte at `/p/nexus/`. The loopback guard, the Run Token, the Run File, the
detached run and the stale-run probe are gone, not moved: one of them exists
in the Host, and Nexus does not have a copy.

**The Plugin Server stands where the HTTP API stood.** `mcp` speaks MCP over
stdin and stdout and offers five tools — `list_skills`,
`show_global_instructions`, `update_skill`, `remove_skill` and
`edit_global_instructions`. Each is one subprocess run of the Nexus CLI, as
every endpoint was, and each answers the same `{command, exit, stdout,
stderr}` envelope. The page reaches them with one relative `POST` to `rpc`.

**Nexus ships no Tray.** FirstMate's Tray opens the Index Page, and every
Plugin is one click from there. Nexus keeps no Windows-specific part at all.

**A CLI refusal is still an answer.** `nexus remove` refusing a name comes
back as a result carrying `exit 1`, never as a transport error, so the page
shows exactly what the command line shows. One change runs at a time, which
was a 409 and is now a JSON-RPC code of its own.

## Consequences

- Nexus is reachable only while the Host runs. That is a dependency it did
  not have, and it is the price of not owning a runtime. `systemctl --user
  status firstmate` is the first question when the page will not open.
- `nexus ui` is gone, and with it `--status`, `--stop`, `--open`,
  `--foreground` and `--port`. The CLI is nine verbs of context management
  and nothing else.
- Thirty-four tests went with the server they drove: the suite is 95 tests
  where it was 129. What they protected — the loopback guard, the token, the
  path containment — is FirstMate's boundary now and is tested there, through
  its own HTTP surface.
- The suite is bash in the distribution and everything left in the tree is
  reachable from it. The `windows/` directory and the written checklist that
  stood in for the coverage it could not have are both gone.
- A second tool that wants a page now writes a `web/` folder and an `mcp`
  file. That is the whole reason this decision is worth its cost.
