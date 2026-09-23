<!--
Thank you. Keep this short: one whole, working change is easier to read than a
long description of a partial one. Delete any line that does not apply.
-->

## What this changes

<!-- One or two sentences, in the project's own words. See CONTEXT.md. -->

Closes #

## Why

<!-- The problem it solves, from the user's side. -->

## Decisions it touches

<!--
Name the ADR that covers the area you changed (docs/adr/). If this change
contradicts one, say so here and say why it is worth reopening. An ADR that
is quietly overridden is worse than one that is argued with.
-->

## Checks

- [ ] `bash tests/run.sh` passes locally, and the last line says so.
- [ ] New behaviour has a test, in `tests/cases/<subcommand>.sh` or next to
      its relatives in `tests/run.sh`.
- [ ] I tried it by hand with `scripts/dev-home`, not against my real Agent
      Context.
- [ ] `README.md` is updated, if a command, a path, an address or an
      environment variable changed.
- [ ] No new dependency, no new network listener, and no weakened safety
      property (a Foreign Entry is preserved, the Custom Root keeps its one
      written path, the Nexus Lock is published only after validation).
