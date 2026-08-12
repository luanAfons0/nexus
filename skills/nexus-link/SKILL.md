---
name: nexus-link
description: Reconcile, repair, or remove stale Nexus-managed links; also trigger when explicitly invoked as $nexus-link.
---

# Nexus link reconciliation

Only run this mutating command when the user asks you to reconcile or repair links. For informational or diagnostic questions about Nexus links, explain the operation without executing anything.

Run the Nexus link command exactly once:

```bash
/home/luanh/.nexus/scripts/nexus link
```

Report the command output clearly. Never bypass validation errors or collision errors; report them and stop.
