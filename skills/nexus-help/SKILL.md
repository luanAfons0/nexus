---
name: nexus-help
description: Show installed skills with their versions or describe every Nexus command; also trigger when explicitly invoked as $nexus-help.
---

# Nexus help

This skill is read-only. It never runs a mutating command.

First, ask the user one choice question with exactly two options:

1. List installed skills and their versions.
2. Describe every Nexus command.

Then run exactly one of these commands, based on the answer:

```bash
/home/luanh/.nexus/scripts/nexus list
```

```bash
/home/luanh/.nexus/scripts/nexus help
```

Report the output as a table (for `list`) or a list (for `help`). Do not run both commands, and do not run anything else.

The last line of `list` is not a skill row. It reports the Global Instructions: the Owner file `~/.custom-skills/GLOBAL.md` and the state of each Instruction Path (`~/.claude/CLAUDE.md` for Claude, `~/.codex/AGENTS.md` for Codex). Report it under the table. `linked` means the path is a Managed Link to the Owner file; `foreign` means something else sits there, usually an instruction file that has not been moved into the Custom Root yet; `absent` means nothing is at the path; `no home` means that agent is not installed. When the Owner is reported as `absent`, tell the user that creating `~/.custom-skills/GLOBAL.md` and running `/nexus-link` gives both agents one shared instruction file.

When you report `list` output, explain that "version" here means the upstream folder hash and the `updatedAt` time; Nexus has no semver. Custom and control skills show a dash for source, hash, and time because they are not upstream installs.

If the user wants to change something instead of only viewing it, point them to the matching action skill: `/nexus-update` to refresh a skill, `/nexus-remove` to uninstall one, `/nexus-install` to add one, `/nexus-link` to reconcile links, `/nexus-new` to reserve a custom skill directory, or `/nexus-setup` to initialize Nexus. `/nexus` (`$nexus` in Codex) opens the Web UI: a local page that lists skills, updates or removes one installed skill, and edits the Global Instructions in a real editor. Do not run any of those from here.
