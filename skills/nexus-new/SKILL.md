---
name: nexus-new
description: Create a new custom skill in the Nexus custom root and link it into the Agent Context of Claude and Codex; also trigger when explicitly invoked as $nexus-new.
---

# Nexus custom skill creation

Only run these mutating commands when the user asks you to create a custom skill. For informational or diagnostic questions about custom skills, explain the operation without executing anything.

Require a skill name before running anything. If the name is missing, ask for it instead of guessing one.

## 1. Reserve the directory

```bash
/home/luanh/.nexus/scripts/nexus new "skill-name"
```

The command validates the name, refuses names that collide with an installed or control skill, creates one empty directory, and prints the created path and the workspace path. It writes no `SKILL.md`. Do not use `eval`. If the command fails, report the output and stop.

## 2. Write the skill

Hand the created path to the `skill-creator` skill, which conducts the interview and writes the skill contents.

Two instructions override `skill-creator` defaults:

- The skill directory is the path printed by step 1. Never create the skill anywhere else.
- Evaluation output goes in the workspace path printed by step 1, **not** in a `<skill-name>-workspace/` sibling directory. A sibling directory in the custom skill root has no `SKILL.md`, so Nexus reports it as an error.

## 3. Reconcile the links

```bash
/home/luanh/.nexus/scripts/nexus link
```

This links the new skill for Claude and for Codex. Report the command output clearly.

## Note on Git

The custom skill root is a Git repository, and Nexus does not use Git. Tell the user to commit the new skill themselves. After the user runs `git pull` for a change made elsewhere, the user runs this command to link the updated files:

```bash
/home/luanh/.nexus/scripts/nexus link
```
