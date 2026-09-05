---
name: nexus
description: Open the Nexus menu to list skills, update or remove one Installed Skill, or edit the Global Instructions; also trigger when explicitly invoked as /nexus or $nexus.
---

# Nexus menu

This skill is a menu over the Nexus CLI. It runs only `list`, `update`, `remove`, and `global`. It never runs install, setup, or new, and it never uses `eval`. Pass every user value as a separate argument.

## Menu loop

Ask the user one choice question with exactly these options:

1. List skills.
2. Update one installed skill.
3. Remove one installed skill.
4. Edit the Global Instructions.
5. Quit.

After list, update, remove, or edit finishes, ask the menu question again. Quit ends the skill. When any command exits non-zero, show the exact command output, do not run anything else, and end the skill; the user must fix the reported state first.

## List

Run exactly:

```bash
/home/luanh/.nexus/scripts/nexus list
```

Report the output as a table. The last line is not a skill row. It reports the Global Instructions: the Owner file `~/.custom-skills/GLOBAL.md` and the state of each Instruction Path (`~/.claude/CLAUDE.md` for Claude, `~/.codex/AGENTS.md` for Codex). Report it under the table. `linked` means the path is a Managed Link to the Owner file; `foreign` means something else sits there, usually an instruction file that has not been moved into the Custom Root yet; `absent` means nothing is at the path; `no home` means that agent is not installed. Explain that "version" means the upstream folder hash and the `updatedAt` time; Nexus has no semver. Custom and control skills show a dash for source, hash, and time because they are not upstream installs.

## Update

Run exactly:

```bash
/home/luanh/.nexus/scripts/nexus list --json
```

Offer only the rows whose `kind` is `installed`, by name. Never offer a custom or control row. If there is no installed row, say so and return to the menu. When the user picks a name from the offered list, run the update command exactly once with that name as a separate argument:

```bash
/home/luanh/.nexus/scripts/nexus update "skill-name"
```

Report the output, including the folder hash before and after. If the user types a name that is a custom row, do not run anything: explain that a Custom Skill lives in `~/.custom-skills`, so it is updated with `git pull` in that repository followed by `/nexus-link`. If the user types a control row name, do not run anything: explain that Control Skills ship with Nexus and are never updated here. If the user types a name that is not in the list, do not run anything and return to the menu.

## Remove

Run `list --json` as in Update and offer only the `installed` rows. When the user picks one, say that removal deletes the installed copy and that Nexus keeps no copy. Then ask the user to type the skill name back. Run the remove command only when the typed value is byte-identical to the picked name:

```bash
/home/luanh/.nexus/scripts/nexus remove "skill-name"
```

If the typed value differs in any way, run nothing and return to the menu. If the user types a custom or control name at the selection step, do not run anything: a Custom Skill is removed by deleting its directory under `~/.custom-skills` followed by `/nexus-link`, and a Control Skill is never removed.

## Edit the Global Instructions

Run exactly:

```bash
/home/luanh/.nexus/scripts/nexus global show --json
```

If `present` is `false`, say that the Global Instructions are absent and ask for the first content. If `present` is `true`, show `content` and ask what to change. Then produce the full new content, show a unified diff between the current content and the new content, and ask for approval. Write nothing before the user approves.

On approval, pipe the full new content to the edit command, with `--if-match` set to the `sha256` from the show output. When the file was absent, use the sha256 of the empty string, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Use a quoted heredoc so the content is passed as bytes, not as shell code:

```bash
/home/luanh/.nexus/scripts/nexus global edit --if-match "sha256-from-show" <<'NEXUS_GLOBAL'
...full new content...
NEXUS_GLOBAL
```

Never write `~/.custom-skills/GLOBAL.md` with your own file tools. Report the command output. When the file was absent before, the command also runs link and forwards its output; show every link notice, in particular a foreign entry notice, because it means one agent still reads its old instruction file. On success, remind the user to commit the change in `~/.custom-skills`; Nexus never runs Git there. If the command refuses with a sha256 mismatch, the file changed since it was read: run `global show --json` again and start the edit over from the new content. Then return to the menu.
