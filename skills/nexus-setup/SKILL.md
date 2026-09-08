---
name: nexus-setup
description: Set up, initialize, migrate, or bootstrap Nexus, the context manager for Claude and Codex; also trigger when explicitly invoked as $nexus-setup.
---

# Nexus setup

Only run this mutating command when the user asks you to perform setup. For informational or diagnostic questions about how Nexus setup works, explain it without executing anything.

Run the Nexus setup command exactly once:

```bash
/home/luanh/.nexus/scripts/nexus setup
```

Report the command output clearly. Explain that complete copies of `~/.claude-backup` and `~/.codex-backup` must be created before any skill-link changes are made. Never bypass safety failures, validation failures, or collision checks; report them and stop.
