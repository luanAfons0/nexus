---
name: nexus
description: Open the Nexus Web UI to manage the Agent Context of Claude and Codex: list skills, update or remove one Installed Skill, or edit the Global Instructions in a real editor; also trigger when explicitly invoked as /nexus or $nexus.
---

# Nexus launcher

This skill starts the Nexus Web UI and prints its URL. It runs exactly one command and never runs install, setup, link, update, remove, or global itself. The page does those through the same CLI.

Run one command and read its output:

```bash
/home/luanh/.nexus/scripts/nexus ui
```

The run detaches itself and the command returns, so the run outlives this session and this skill does not have to hold it. The first line of standard output is the handshake line, in this exact form:

```
nexus ui: http://127.0.0.1:PORT/t/TOKEN/
```

Print that URL to the user and end the skill. The printed URL is the contract: the server tries to open a browser on its own, but from an agent sandbox it often cannot, so the user opens the URL by hand. Do not wait for the browser and do not poll the server.

If the command exits non-zero, report its output as it is and stop. Common causes: a Web UI run is already live, and the message names that run's URL; `python3` is missing; the port is in use (`--port N` was given); or the Nexus home has no `web` directory. Never retry with a different command.

The server binds `127.0.0.1` only. To end the run, the user presses `Stop server` in the page header or runs `/home/luanh/.nexus/scripts/nexus ui --stop`; `/home/luanh/.nexus/scripts/nexus ui --status` prints the URL again after the handshake line has scrolled away. The Run Token in the URL is valid only for that run.

What the page does: it lists every skill of all three kinds, updates or removes one Installed Skill with the exact CLI output shown, and edits the Global Instructions with Edit and Preview tabs, line numbers, and "Save changes". Every action is a `nexus` CLI call; Nexus never runs Git in `~/.custom-skills`, so the user commits a saved change there.
