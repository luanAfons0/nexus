/**
 * The rules of a Skill Name, and the one order every list of them is in.
 *
 * A Skill Name is a path segment Nexus joins under an Owner and a Native
 * Skill Root, so it must never climb out of either: one letter or digit, then
 * letters, digits, `.`, `_` or `-`, and never `.` or `..`. The rule is the
 * Bash CLI's `safe_skill_name`; the lock's rule is the same (ADR 0001).
 *
 * Windows adds two rules of its file system. A name that is a device (`CON`,
 * `NUL`, `COM1`, in any case and with any extension) or that ends in `.`
 * does not name a directory there, so it is not safe. And Windows ignores
 * case, so two names that differ only in case are one Skill Name there.
 */

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The device names of Windows: a file name before its first `.` may not be one. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

const WINDOWS = process.platform === 'win32';

/** True when `name` is a safe Skill Name. */
export function isSafeSkillName(name: string): boolean {
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') return false;
  return !WINDOWS || (!WINDOWS_DEVICE.test(name) && !name.endsWith('.'));
}

/**
 * The form of a Skill Name that two names share when the file system takes
 * them for one: on Windows its lower case, elsewhere the name itself.
 */
export function skillNameKey(name: string): string {
  return WINDOWS ? name.toLowerCase() : name;
}

/**
 * Compare two strings by their UTF-8 bytes, as `LC_ALL=C sort` does. Every
 * list Nexus prints or links in is in this order, whatever the locale.
 */
export function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
