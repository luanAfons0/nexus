---
name: nexus-install
description: Install selected skills through Nexus for Claude and Codex; also trigger when explicitly invoked as $nexus-install.
---

# Nexus skill installation

Require a source and at least one skill name before running anything. With explicit arguments, run the install command once, passing the source and each selected skill name as separate arguments:

```bash
/home/luanh/.nexus/scripts/nexus install "$source" "${skills[@]}"
```

Report the command output clearly. Do not use `eval`. If the source or skill names are missing, ask for them instead of running the command.
