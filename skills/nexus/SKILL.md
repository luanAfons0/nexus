---
name: nexus
description: Open the Nexus Web UI to manage the Agent Context of Claude and Codex: list skills, update or remove one Installed Skill, or edit the Global Instructions in a real editor; also trigger when explicitly invoked as /nexus or $nexus.
---

# Nexus launcher

This skill starts the Nexus Web UI and prints its URL. It runs exactly one command and never runs install, setup, link, update, remove, or global itself. The page does those through the same CLI.

Run the server in the background of the chat's shell so the skill can end while the page stays up:

```bash
log="$(mktemp -t nexus-ui.XXXXXX)"
nohup /home/luanh/.nexus/scripts/nexus ui >"$log" 2>&1 &
disown
sleep 1
head -n 1 "$log"
```

The first line of the log is the handshake line, in this exact form:

```
nexus ui: http://127.0.0.1:PORT/t/TOKEN/
```

Print that URL to the user and end the skill. The printed URL is the contract: the server tries to open a browser on its own, but from an agent sandbox it often cannot, so the user opens the URL by hand. Do not wait for the browser, do not poll the server, and do not read the log again.

If the first line is not a handshake line, or the log is empty after one more second, report the log content as it is and stop. Common causes: `python3` is missing, the port is in use (`--port N` was given), or the Nexus home has no `web` directory. Never retry with a different command.

The server binds `127.0.0.1` only and runs in the foreground of that background job until it is stopped. To stop it, the user presses Ctrl-C in a terminal that runs it, or kills the process; there is no stop subcommand. The Run Token in the URL is valid only for that run.

What the page does: it lists every skill of all three kinds, updates or removes one Installed Skill with the exact CLI output shown, and edits the Global Instructions with Edit and Preview tabs, line numbers, and "Save changes". Every action is a `nexus` CLI call; Nexus never runs Git in `~/.custom-skills`, so the user commits a saved change there.
