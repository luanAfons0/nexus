/**
 * A fake program on PATH, such as `gh` or `npx`: it records its arguments,
 * then runs the behaviour script the test chose, with the same arguments.
 *
 * The launchers that `installFake` writes run it as
 * `node fake.ts <calls file> <behaviour script> <arguments>...`. A call is one
 * JSON line, so an argument with a space or a newline is kept exactly.
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [calls, behaviour, ...args] = process.argv.slice(2);
if (calls === undefined || behaviour === undefined) {
  throw new Error('fake.ts needs a calls file and a behaviour script before the arguments.');
}
appendFileSync(calls, `${JSON.stringify(args)}\n`);
process.argv = [process.execPath, behaviour, ...args];
await import(pathToFileURL(behaviour).href);
