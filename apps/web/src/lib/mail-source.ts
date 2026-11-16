/**
 * Source of an email: the message comes as a
 * blob via its `blobId` (RFC 8621, 4.1.1) and appears as it is – header
 * fields with continuation lines (RFC 5322, 2.2.3), then the body without
 * decoding base64 or quoted-printable.
 */

/** A header field; continuation lines stay in `v` with line break and indentation. */
export interface SourceHeader {
  k: string;
  v: string;
}

export interface SourceParts {
  head: SourceHeader[];
  body: string;
}

/**
 * Header field per RFC 5322, 3.6.8 (name of printable ASCII characters
 * except colon), also in the obsolete form with whitespace before the colon
 * (4.5.8).
 */
const FIELD = /^([!-9;-~]+)[ \t]*:[ \t]*/;

const LF = 0x0a;

/**
 * Text of the message: UTF-8 (RFC 6532 also allows it in the header). If it
 * is not entirely – such as an 8bit part in Latin-1 next to UTF-8 –, line by
 * line: valid lines as UTF-8, the others as Windows-1252, which maps every
 * byte.
 */
export function decodeSource(bytes: ArrayBuffer | Uint8Array): string {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  try {
    return utf8.decode(data);
  } catch {
    // Line by line below.
  }
  const latin = new TextDecoder('windows-1252');
  let text = '';
  for (let start = 0; start < data.length;) {
    const end = data.indexOf(LF, start);
    const line = data.subarray(start, end < 0 ? data.length : end + 1);
    try {
      text += utf8.decode(line);
    } catch {
      text += latin.decode(line);
    }
    start = end < 0 ? data.length : end + 1;
  }
  return text;
}

/**
 * Header up to the first empty line and body; CRLF line endings as `\n`, a
 * single CR stays in the text. If the text does not start with a header
 * field (such as with the `From ` line of an mbox), everything is in the
 * body; later lines that do not start a field attach to the field before
 * them like continuation lines.
 */
export function sourceParts(raw: string): SourceParts {
  const text = raw.replace(/\r\n/g, '\n');
  const cut = text.indexOf('\n\n');
  // Without an empty line (header only), a trailing line ending does not count as another line.
  const lines = (cut < 0 ? text.replace(/\n$/, '') : text.slice(0, cut)).split('\n');
  const head: SourceHeader[] = [];
  for (const line of lines) {
    const last = head[head.length - 1];
    const field = /^[ \t]/.test(line) ? null : FIELD.exec(line);
    if (field) head.push({ k: field[1]!, v: line.slice(field[0].length) });
    else if (last) last.v += `\n${line}`;
    else return { head: [], body: text };
  }
  return { head, body: cut < 0 ? '' : text.slice(cut + 2) };
}

/**
 * File name for "Download as .eml": subject without
 * characters file systems dislike and without control and format characters
 * (the sender chooses it; U+202E, for example, reverses the display of the
 * name), at most 60 characters, otherwise `fallback`.
 */
export function sourceFileName(subject: string, fallback: string): string {
  const name = [...subject.replace(/[\\/:*?"<>|\p{Cc}\p{Cf}]+/gu, '').trim()].slice(0, 60).join('').trim();
  return `${name || fallback}.eml`;
}

/**
 * Start of the body up to `limit` characters for display (large attachments
 * as base64 would otherwise stall the window): at the last line ending
 * before it if that lies in the second half, otherwise at `limit` – without
 * splitting a surrogate pair (UTF-16).
 */
export function sourceChunk(body: string, limit: number): string {
  if (body.length <= limit) return body;
  const line = body.lastIndexOf('\n', limit - 1);
  if (line >= limit / 2) return body.slice(0, line + 1);
  const code = body.charCodeAt(limit - 1);
  return body.slice(0, code >= 0xd800 && code <= 0xdbff ? limit - 1 : limit);
}
