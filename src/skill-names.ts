/**
 * The rules of a Skill Name, and the one order every list of them is in.
 *
 * A Skill Name is a path segment Nexus joins under an Owner and a Native
 * Skill Root, so it must never climb out of either: one letter or digit, then
 * letters, digits, `.`, `_` or `-`, and never `.` or `..`. The rule is the
 * Bash CLI's `safe_skill_name`; the lock's rule is the same (ADR 0001).
 */

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `name` is a safe Skill Name. */
export function isSafeSkillName(name: string): boolean {
  return SAFE_NAME.test(name) && name !== '.' && name !== '..';
}

/**
 * Compare two strings by their UTF-8 bytes, as `LC_ALL=C sort` does. Every
 * list Nexus prints or links in is in this order, whatever the locale.
 */
export function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
