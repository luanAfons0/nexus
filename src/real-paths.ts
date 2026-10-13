/**
 * Paths as GNU `realpath` reads them, which is how the Bash CLI decides what
 * a link reaches and whether it lies inside an Owner root.
 *
 * Node's `fs.realpath` refuses a path that does not exist, but a Stale Link
 * or a Managed Link through a moved root points at nothing, and Link must
 * still tell whose it is. `realpathMissing` is `realpath -m`: it follows
 * every link it meets, even a dangling one, and takes each missing component
 * as written. `path.resolve` is `realpath -m -s`, the lexical form.
 */
import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, sep } from 'node:path';

/** How many links one path may pass through before it counts as a loop. */
const MAX_LINKS = 40;

/**
 * The physical form of `path`, as `realpath -m` gives it: each link followed,
 * each missing component kept as written, and `..` taken after the link
 * before it is followed. Throws on a loop of links.
 */
export function realpathMissing(path: string): string {
  const absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`;
  const root = parse(absolute).root;
  let resolved = root;
  let rest = components(absolute.slice(root.length));
  let links = 0;
  while (rest.length > 0) {
    const [part = '', ...tail] = rest;
    rest = tail;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      resolved = dirname(resolved);
      continue;
    }
    const next = join(resolved, part);
    if (!isSymlink(next)) {
      resolved = next;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) throw new Error(`too many levels of symbolic links: ${path}`);
    const text = readlinkSync(next);
    if (isAbsolute(text)) {
      const linkRoot = parse(text).root;
      resolved = linkRoot;
      rest = [...components(text.slice(linkRoot.length)), ...rest];
    } else {
      rest = [...components(text), ...rest];
    }
  }
  return resolved;
}

/**
 * What the link at `link` reaches, as `resolved_link_target` gives it: its
 * text taken from the link's directory, then `realpathMissing`. Undefined
 * when `link` is no link or its links loop.
 */
export function resolvedLinkTarget(link: string): string | undefined {
  try {
    const text = readlinkSync(link);
    return realpathMissing(isAbsolute(text) ? text : `${dirname(link)}${sep}${text}`);
  } catch {
    return undefined;
  }
}

/** True when `candidate` is `root` or lies under it, compared as text. */
export function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

/** The components of a path without its root; Windows takes both slashes. */
function components(path: string): string[] {
  return path.split(sep === '\\' ? /[\\/]/ : '/');
}

/** True when `path` is a symlink (or a junction), without following it. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
