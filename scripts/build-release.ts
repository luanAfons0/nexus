/**
 * The release build: write the files of one Plugin Release into `release/`
 * (FirstMate ADR-0033, ADR 0011).
 *
 *   npm run release              # into release/
 *   node scripts/build-release.ts <out>
 *
 * The repository has no build step and runs from source. Only a Plugin
 * Release is built, because the Host starts `mcp.ts` before `mcp.js`
 * (FirstMate ADR-0028): an archive that held the source would run it, and
 * Node strips TypeScript's types only outside `node_modules` and only on a
 * Node new enough. So `release/` holds no TypeScript at all.
 *
 * The output is not minified, so that a stack trace stays readable. Nexus has
 * no runtime dependency, so a bundle holds Nexus alone and imports only
 * `node:` modules.
 */
import { chmodSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type InlineConfig } from 'tsdown';

/** The repository this script sits in. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What every bundle shares: ESM for Node, one readable file per entry. */
const BUNDLE: InlineConfig = {
  config: false,
  cwd: REPO_ROOT,
  format: 'esm',
  platform: 'node',
  // The shipped package.json says "type": "module", so .js is already ESM.
  fixedExtension: false,
  clean: false,
  dts: false,
  minify: false,
  sourcemap: false,
  logLevel: 'warn',
};

/** Write one Plugin Release into `out`, which is emptied first. */
async function buildRelease(out: string): Promise<void> {
  rmSync(out, { recursive: true, force: true });

  // The Plugin Server, as one file the Host starts with its own Node.
  await build({ ...BUNDLE, entry: { mcp: join(REPO_ROOT, 'mcp.ts') }, outDir: out });

  // The CLI, at the path every Control Skill, `nexus help` and the README
  // name, `src/nexus.js`, which is also the path `mcp.js` starts for each
  // tool call. So a tool call starts bundled JavaScript, not TypeScript that
  // Node has to strip first. The entry keeps its own small file, and the CLI
  // it imports once the Node version is checked is a chunk beside it, so a
  // Node too old still reads the entry and says which version Nexus needs.
  await build({
    ...BUNDLE,
    entry: { nexus: join(REPO_ROOT, 'src', 'nexus.js') },
    outDir: join(out, 'src'),
    outputOptions: { chunkFileNames: '[name].js' },
  });

  // `mcp.js` takes its module kind from the Plugin's own package.json
  // (FirstMate ADR-0028), so the Plugin Release ships one that says ESM,
  // whatever a directory above the Shelf says.
  writeFileSync(join(out, 'package.json'), '{\n  "type": "module"\n}\n');

  // The Plugin Page, which the Host serves byte for byte, and the Control
  // Skills, whose Owner is the Nexus home an installed Plugin Release is.
  // Both ship as they are. Nothing Nexus keeps its data in sits under them,
  // so `firstmate update` never meets data in a Release File's way.
  for (const folder of ['web', 'skills']) {
    cpSync(join(REPO_ROOT, folder), join(out, folder), { recursive: true });
  }

  // The `sh` launcher a `wsl` Place starts as ./mcp. It runs mcp.ts when
  // there is one and mcp.js when not, as the Host does, so the one file
  // serves the repository and the Plugin Release.
  cpSync(join(REPO_ROOT, 'mcp'), join(out, 'mcp'));
  chmodSync(join(out, 'mcp'), 0o755);
}

await buildRelease(resolve(REPO_ROOT, process.argv[2] ?? 'release'));
