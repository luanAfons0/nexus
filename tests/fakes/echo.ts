/**
 * The behaviour of a fake program that answers on both streams: each argument
 * on its own line on stdout, a line on stderr, and the exit code in
 * `NEXUS_FAKE_EXIT` (0 when it is not set). The helper's own tests use it.
 */
for (const arg of process.argv.slice(2)) process.stdout.write(`${arg}\n`);
process.stderr.write('fake: done\n');
process.exitCode = Number(process.env.NEXUS_FAKE_EXIT ?? '0');
