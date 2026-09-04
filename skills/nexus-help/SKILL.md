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

When you report `list` output, explain that "version" here means the upstream folder hash and the `updatedAt` time; Nexus has no semver. Custom and control skills show a dash for source, hash, and time because they are not upstream installs.

If the user wants to change something instead of only viewing it, point them to the matching action skill: `/nexus-update` to refresh a skill, `/nexus-remove` to uninstall one, `/nexus-install` to add one, `/nexus-link` to reconcile links, `/nexus-new` to reserve a custom skill directory, or `/nexus-setup` to initialize Nexus. Do not run any of those from here.
