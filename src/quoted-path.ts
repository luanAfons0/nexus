/**
 * A path and an OS error in the text the Bash CLI's Backup manifest and skill
 * tree checks printed: a path quoted and escaped the way Python's `repr`
 * writes it, and an error as `[Errno 13] Permission denied: '<path>'`. The
 * port keeps those bytes, so a person who knows the old sentence still reads
 * the same one.
 */
import { constants } from 'node:os';
import { getSystemErrorMessage } from 'node:util';

/**
 * A path as Python's `repr` writes it: in single quotes (double quotes when
 * it holds a single quote and no double quote), with escapes for control
 * characters and for each byte that is not UTF-8 (`\udcff`, as Python's
 * `surrogateescape` reads a file name).
 */
export function quotedPath(path: Buffer | string): string {
  const bytes = typeof path === 'string' ? Buffer.from(path) : path;
  const chars = decodeEscaped(bytes);
  const hasSingle = chars.some((char) => char === "'");
  const hasDouble = chars.some((char) => char === '"');
  const quote = hasSingle && !hasDouble ? '"' : "'";
  let body = '';
  for (const char of chars) body += escapeChar(char, quote);
  return `${quote}${body}${quote}`;
}

/**
 * An OS error as Python's `str(OSError)` writes it:
 * `[Errno 13] Permission denied: '<path>'`.
 */
export function errnoText(failure: unknown, path: Buffer | string): string {
  const code = errorCode(failure);
  const errno = errorNumber(failure, code);
  const message = systemMessage(failure);
  return `[Errno ${errno}] ${message}: ${quotedPath(path)}`;
}

/** The characters of `bytes`, each byte that is not UTF-8 kept as a lone surrogate. */
function decodeEscaped(bytes: Buffer): string[] {
  const chars: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const size = utf8Length(bytes, i);
    if (size === 0) {
      chars.push(String.fromCharCode(0xdc00 + (bytes[i] ?? 0)));
      i += 1;
    } else {
      chars.push(bytes.subarray(i, i + size).toString('utf8'));
      i += size;
    }
  }
  return chars;
}

/** The length of the valid UTF-8 sequence at `i`, or 0 when there is none. */
function utf8Length(bytes: Buffer, i: number): number {
  const lead = bytes[i] ?? 0;
  if (lead < 0x80) return 1;
  let size: number;
  let low = 0x80;
  let high = 0xbf;
  if (lead >= 0xc2 && lead <= 0xdf) size = 2;
  else if (lead >= 0xe0 && lead <= 0xef) {
    size = 3;
    if (lead === 0xe0) low = 0xa0;
    if (lead === 0xed) high = 0x9f;
  } else if (lead >= 0xf0 && lead <= 0xf4) {
    size = 4;
    if (lead === 0xf0) low = 0x90;
    if (lead === 0xf4) high = 0x8f;
  } else return 0;
  for (let k = 1; k < size; k += 1) {
    const byte = bytes[i + k];
    if (byte === undefined) return 0;
    if (k === 1 ? byte < low || byte > high : byte < 0x80 || byte > 0xbf) return 0;
  }
  return size;
}

/** One character as `repr` writes it inside `quote`. */
function escapeChar(char: string, quote: string): string {
  if (char === '\\') return '\\\\';
  if (char === quote) return `\\${quote}`;
  if (char === '\n') return '\\n';
  if (char === '\r') return '\\r';
  if (char === '\t') return '\\t';
  const code = char.codePointAt(0) ?? 0;
  if (code >= 0xd800 && code <= 0xdfff) return `\\u${hex(code, 4)}`;
  if (char !== ' ' && /^[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u.test(char)) {
    if (code < 0x100) return `\\x${hex(code, 2)}`;
    if (code < 0x10000) return `\\u${hex(code, 4)}`;
    return `\\U${hex(code, 8)}`;
  }
  return char;
}

function hex(code: number, width: number): string {
  return code.toString(16).padStart(width, '0');
}

function errorCode(failure: unknown): string | undefined {
  const code = (failure as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** The positive errno, as C and Python number it. */
function errorNumber(failure: unknown, code: string | undefined): number {
  const known = code === undefined ? undefined : (constants.errno as Record<string, number>)[code];
  if (known !== undefined) return known;
  const errno = (failure as { errno?: unknown } | null)?.errno;
  return typeof errno === 'number' ? Math.abs(errno) : 0;
}

/** The system's sentence for the error, with a capital first letter as C's `strerror` has. */
function systemMessage(failure: unknown): string {
  const errno = (failure as { errno?: unknown } | null)?.errno;
  let message: string;
  try {
    message = typeof errno === 'number' ? getSystemErrorMessage(errno) : String(failure);
  } catch {
    message = String(failure);
  }
  return message.charAt(0).toUpperCase() + message.slice(1);
}
