---
name: nexus-update
description: Update one installed skill through Nexus and relink it for Claude and Codex; also trigger when explicitly invoked as $nexus-update.
---

# Nexus skill update

Only run this mutating command when the user asks you to update a skill. For informational or diagnostic questions about Nexus updates, explain the operation without executing anything.

Require the skill name before running anything. Never guess the name and never substitute a similar one. If the user did not give a name, ask for it and stop.

With an explicit name, run the update command exactly once, passing the name as a separate argument:

```bash
/home/luanh/.nexus/scripts/nexus update "skill-name"
```

Replace `skill-name` with the concrete user-provided name. Do not use `eval`. Update one skill per invocation; run the command again for another name.

Report the command output clearly, including the reported folder hash before and after. If the command reports an error, report it and stop; never retry with a different name and never bypass a refusal. Nexus refuses control skill names, custom skill names, and names that are not installed, and it leaves the Nexus lock unchanged when upstream or validation fails.

Custom skills are not updated here. Their content lives in `~/.custom-skills`, so update them with `git pull` in that repository and then run `/nexus-link`.
