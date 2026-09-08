# Nexus

Nexus is the context manager for Claude and Codex. It gives both agents one
owner for their Agent Context: the skills of all three kinds and the Global
Instructions (`~/.custom-skills/GLOBAL.md`), which it links into each agent's
Instruction Path. See `README.md` for behavior, safety contract, and recovery. Run `bash tests/run.sh` before a
commit.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `luanAfons0/nexus` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at repo root. See `docs/agents/domain.md`.
