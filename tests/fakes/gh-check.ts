/**
 * The behaviour of the fake `gh` that `nexus check` asks, as `check_fake_gh`
 * of the Bash suite answered: `gh auth` succeeds unless
 * `NEXUS_FAKE_GH_MODE` is `logged_out`, and each repository a case set up
 * gives its last commit date, nothing, a date that is no date, or a 404.
 * Anything else is an error, so a case that asks for something no case set up
 * fails loudly.
 */
const args = process.argv.slice(2);

/** The commit date each repository answers with, or undefined for a 404. */
const REPOSITORIES: Readonly<Record<string, string | undefined>> = {
  'repos/owner/moved/commits': '2026-06-01T10:00:00Z',
  'repos/owner/quiet/commits': '2025-06-01T10:00:00Z',
  'repos/owner/gone/commits': undefined,
  'repos/owner/empty/commits': '',
  'repos/owner/odd/commits': 'not a moment',
};

function answer(): number {
  if (args[0] === 'auth') {
    if (process.env.NEXUS_FAKE_GH_MODE === 'logged_out') {
      process.stderr.write('You are not logged into any GitHub hosts.\n');
      return 1;
    }
    return 0;
  }
  for (const arg of args) {
    if (!Object.hasOwn(REPOSITORIES, arg)) continue;
    const date = REPOSITORIES[arg];
    if (date === undefined) {
      process.stderr.write('gh: Not Found (HTTP 404)\n');
      return 1;
    }
    if (date !== '') process.stdout.write(`${date}\n`);
    return 0;
  }
  process.stderr.write('gh: the fake was asked for something no case set up\n');
  return 1;
}

process.exitCode = answer();
