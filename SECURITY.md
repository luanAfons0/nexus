# Security

## What is at stake

Nexus runs as you, on your machine, and writes inside your home directory. It
creates and removes Managed Links in `~/.claude/skills`, `~/.codex/skills`,
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, publishes the Nexus Lock in
`~/.nexus`, writes `GLOBAL.md` in the Custom Root, and copies whole Agent
Homes into `~/.claude-backup` and `~/.codex-backup` during Setup.

It also decides which Skills your agents load. A skill is instructions an
agent follows, so anything that can add or redirect a Skill can change what
Claude and Codex do on your behalf. That is the interesting part of this
project's attack surface, more than the file handling.

Bugs worth reporting privately:

- A path that escapes its Owner: a Managed Link, an install source, or a
  Skill Name that reaches outside the Canonical Root, the Custom Root or the
  Nexus home.
- A Foreign Entry that Nexus claims, overwrites or deletes.
- Anything that lets a Skill Name, an install source, a lock field or a file
  name be evaluated as shell code.
- A Backup that is silently overwritten, or a Setup failure that leaves an
  Agent Home worse than it found it.
- A Nexus Lock that is published without passing validation, or validation
  that can be made to pass on a lock Nexus should refuse.
- Anything that lets the Plugin Page or the Plugin Server reach a file outside
  what the CLI already exposes.

## Supported versions

`main` only. Nexus is installed by cloning, so the fix for any problem is the
next commit on `main`.

## How to report

Use GitHub's private vulnerability reporting: open the
[Security tab](https://github.com/luanAfons0/nexus/security/advisories) of
`luanAfons0/nexus` and choose **Report a vulnerability**. That opens a private
advisory that only the maintainers can read.

Do not open a public issue for a security problem.

Please include the exact commands, the file layout they ran against, and what
an attacker gets out of it. A patch is welcome but not expected. This is a
one-maintainer project with no service behind it and no bounty: you get an
answer as soon as the maintainer reads the advisory, and a fix on `main` once
the report is confirmed.

## Out of scope

- A skill you installed doing something you did not want. Nexus links skills;
  it does not review their content, and it is not a sandbox.
- Anything that needs an attacker who can already run commands as you. At that
  point your Agent Context is theirs anyway.
- Upstream `npx skills`, which Nexus calls for install and update. Report
  those to that project.
