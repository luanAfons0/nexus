/**
 * The behaviour of a fake program that never ends, such as an `npx` stuck on
 * the network. It writes its process ID as one line of `hung.pids` in the
 * home it runs in, so a test can wait until it runs and then prove that the
 * Plugin Server's timeout ended it, and then it waits for ten minutes.
 */
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

appendFileSync(join(homedir(), 'hung.pids'), `${process.pid}\n`);
setTimeout(() => {}, 600_000);
