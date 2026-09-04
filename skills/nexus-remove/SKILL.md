---
name: nexus-remove
description: Uninstall one installed skill through Nexus and relink Claude and Codex; also trigger when explicitly invoked as $nexus-remove.
---

# Nexus skill removal

Only run this mutating command when the user asks you to remove an installed skill. For informational or diagnostic questions about Nexus removal, explain the operation without executing anything.

Removal is irreversible for the installed copy: upstream deletes the skill content, and Nexus does not keep a copy. Before you run anything, confirm with the user and name the skill you are about to remove. Wait for a clear yes.

Require exactly one skill name. If the name is missing, ask for it instead of guessing. With the confirmed name, run the command exactly once:

```bash
/home/luanh/.nexus/scripts/nexus remove "skill-name"
```

Replace the example value with the concrete user-provided skill name, passed as a separate argument. Report the command output clearly. Do not use `eval`.

Nexus refuses a control skill name and a name that is not in the Nexus lock. Removing the last installed skill leaves an empty lock; the control skills and custom skills stay linked. A failed upstream command, or an upstream lock that still contains the name, leaves the Nexus lock unchanged.

Custom skills are not removed by this command. To remove one, delete its directory under `~/.custom-skills` and then run `/nexus-link`.
