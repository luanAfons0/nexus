# 0011. Nexus ships a Plugin Release

## Status

Accepted

Follows FirstMate ADR-0033 (`docs/adr/0033-a-git-url-is-fetched-as-a-plugin-release.md`
in `luanAfons0/FirstMate`). Everything in ADR 0008 stands.

## Decision

`firstmate install nexus` fetches a Plugin Release, so a tag `vMAJOR.MINOR.PATCH`
of this repository runs FirstMate's `plugin-release.yml`, which tests it and
then runs `npm run release`. The repository has no build step and runs from
source; only the Plugin Release is built. `scripts/build-release.ts` bundles
`mcp.ts` into `mcp.js` and the CLI into `src/nexus.js` with `tsdown`, not
minified, and copies `web/`, `skills/` and the `mcp` launcher as they are, with
a `package.json` that says ESM. The Plugin Release holds no TypeScript,
because the Host starts `mcp.ts` before `mcp.js` (FirstMate ADR-0028), and
each tool call then starts bundled JavaScript that Node does not have to strip.
The CLI keeps the path every Control Skill names, because an installed Nexus
is the Owner of the Control Skills it shipped. No file Nexus keeps its data in
(the Nexus Lock, the Check Result, the Managed Copy record) is a Release File,
so `firstmate update` replaces the Release Files and keeps them.
