---
name: nexus
description: Open the Nexus page to manage the Agent Context of Claude and Codex: list skills, update or remove one Installed Skill, or edit the Global Instructions in a real editor; also trigger when explicitly invoked as /nexus or $nexus.
---

# Nexus launcher

This skill prints the address of the Nexus page. It starts nothing and it never runs install, setup, link, update, remove, or global itself. The page does those through the same CLI.

Nexus is a FirstMate Plugin: the FirstMate Host serves its page and runs its Plugin Server, so there is no run for this session to own and nothing to wait for.

Run one command and read its output:

```bash
python3 -c "import json;r=json.load(open('/home/luanh/.firstmate/runtime.json'));print('http://127.0.0.1:%d/p/nexus/?token=%s' % (r['port'], r['token']))"
```

It prints one line, in this exact form:

```
http://127.0.0.1:PORT/p/nexus/?token=TOKEN
```

Print that URL to the user and end the skill. The printed URL is the contract: nothing here opens a browser, because from an agent sandbox that usually fails. The user opens it by hand, or opens FirstMate's Tray, from whose Index Page every Plugin is one click away. Do not poll anything.

If the command fails, the FirstMate Host is not running. Report that and give the user this one command; never retry with a different one:

```bash
systemctl --user start firstmate
```

The token is on the address once. The Host answers the first navigation with a cookie and sends the browser to `http://127.0.0.1:PORT/p/nexus/`, which is what makes that plain address worth bookmarking. A bookmark that carries a token is stale at the next Host start.

What the page does: it lists every skill of all three kinds, updates or removes one Installed Skill with the exact CLI output shown, and edits the Global Instructions with Edit and Preview tabs, line numbers, and "Save changes". Every action is a `nexus` CLI call; Nexus never runs Git in `~/.custom-skills`, so the user commits a saved change there.
