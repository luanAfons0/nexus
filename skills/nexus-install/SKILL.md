---
name: nexus-install
description: Install selected skills through Nexus for Claude and Codex; also trigger when explicitly invoked as $nexus-install.
---

# Nexus skill installation

Only run this mutating command when the user asks you to install skills. For informational or diagnostic questions about Nexus installation, explain the operation without executing anything.

Require a source and at least one skill name before running anything. With explicit arguments, run the install command once, passing the source and each selected skill name as separate arguments:

```bash
/home/luanh/.nexus/scripts/nexus install "/path/to/source" "skill-a" "skill-b"
```

Replace the example values with the concrete user-provided source and skill names; pass each as its own argv entry. Report the command output clearly. Do not use `eval`. If the source or skill names are missing, ask for them instead of running the command.
