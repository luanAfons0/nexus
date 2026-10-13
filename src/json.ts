/**
 * JSON in the bytes `jq` writes it, because the Bash CLI printed every JSON
 * document with `jq` and scripts and the Plugin Page read those bytes.
 *
 * `JSON.stringify` already writes what `jq` writes for the values a lock or a
 * result holds, with one exception: `jq` escapes DEL (U+007F) as `\u007f`.
 * DEL can only stand inside a string in JSON text, so replacing it is safe.
 */

/** True when `value` is a JSON object: not null, and not an array. */
export function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One value on one line, as `jq -c` writes it. */
export function compactJson(value: unknown): string {
  return jqEscapes(JSON.stringify(value));
}

/** One value indented by two spaces, as `jq` writes it with no flag. */
export function prettyJson(value: unknown): string {
  return jqEscapes(JSON.stringify(value, null, 2));
}

/**
 * One value on one line with every object's keys in code point order, as
 * `jq -S -c` writes it: two values are the same JSON when these are equal.
 */
export function sortedJson(value: unknown): string {
  return compactJson(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, each] of entries) sorted[key] = sortKeys(each);
  return sorted;
}

function jqEscapes(text: string): string {
  return text.replaceAll('\u007f', '\\u007f');
}
