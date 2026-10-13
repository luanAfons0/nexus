/**
 * The Nexus CLI entry: `node <Nexus home>/src/nexus.js <command>`.
 *
 * This one file is JavaScript, not TypeScript, so that a Node too old to run
 * TypeScript still reads it and can say which version Nexus needs, rather
 * than fail on a `.ts` extension or a type it cannot strip. Its syntax stays
 * old for the same reason. Everything after the check is TypeScript, which
 * Node 24 runs directly with no build step.
 *
 * The exit code is set, never forced with `process.exit`, so that output
 * still on its way to a pipe (asynchronous on Windows) is not cut short.
 */

/** The oldest major version of Node that Nexus runs on. */
const NEEDED_MAJOR = 24;

const version = process.versions.node;
if (Number(version.split('.')[0]) < NEEDED_MAJOR) {
  process.stderr.write(
    'nexus: error: Nexus needs Node ' + NEEDED_MAJOR + ' or newer; this is Node ' + version + '.\n',
  );
  process.exitCode = 1;
} else {
  import('./cli.ts')
    .then(function (cli) {
      return cli.main(process.argv.slice(2));
    })
    .then(function (code) {
      process.exitCode = code;
    });
}
