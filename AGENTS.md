# Nexus

Nexus is the context manager for Claude and Codex. It gives both agents one
owner for their Agent Context: the skills of all three kinds and the Global
Instructions (`~/.custom-skills/GLOBAL.md`), which it links into each agent's
Instruction Path. See `README.md` for behavior, safety contract, and recovery. Run `bash tests/run.sh` before a
commit.

Try a change with `scripts/dev-home <nexus arguments>`, which runs the CLI
against a sandbox home under `.scratch/`. Never drive a half-finished change
against the real Agent Context. `CONTRIBUTING.md` holds the rest: where a new
test goes, how the code is written, Conventional Commits with the subject in
the project's own words, and the safety properties a change may not weaken.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `luanAfons0/nexus` via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at repo root. See `docs/agents/domain.md`.
