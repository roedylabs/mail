import { describe, expect, it } from 'vitest';
import { decodeSource, sourceChunk, sourceFileName, sourceParts } from './mail-source.ts';

describe('decodeSource', () => {
  it('reads UTF-8', () => {
    expect(decodeSource(new TextEncoder().encode('Subject: Café'))).toBe('Subject: Café');
  });

  it('reads invalid UTF-8 as Windows-1252', () => {
    // "Café" in Latin-1, plus the euro sign of Windows-1252
    expect(decodeSource(new Uint8Array([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80]))).toBe('Café €');
  });

  it('reads only the invalid lines as Windows-1252', () => {
    const utf8 = new TextEncoder().encode('Subject: Café\r\n\r\n');
    const latin = new Uint8Array([0x43, 0x72, 0xe8, 0x6d, 0x65, 0x0a]); // "Crème" in Latin-1
    const tail = new TextEncoder().encode('Brûlée');
    expect(decodeSource(new Uint8Array([...utf8, ...latin, ...tail]).buffer)).toBe(
      'Subject: Café\r\n\r\nCrème\nBrûlée',
    );
  });
});

describe('sourceParts', () => {
  it('splits header and body at the first empty line and keeps continuation lines', () => {
    const raw = [
      'Received: from mail.example.com',
      '\tby mx.example.com; Mon, 26 Oct 2026 09:14:00 +0100',
      'Subject:No space',
      'X-Empty:',
      'Content-Type: text/plain;',
      '  charset="UTF-8"',
      '',
      'First line',
      '',
      'Second paragraph',
    ].join('\r\n');
    expect(sourceParts(raw)).toEqual({
      head: [
        { k: 'Received', v: 'from mail.example.com\n\tby mx.example.com; Mon, 26 Oct 2026 09:14:00 +0100' },
        { k: 'Subject', v: 'No space' },
        { k: 'X-Empty', v: '' },
        { k: 'Content-Type', v: 'text/plain;\n  charset="UTF-8"' },
      ],
      body: 'First line\n\nSecond paragraph',
    });
  });

  it('knows messages without a body and keeps a single CR in the value', () => {
    expect(sourceParts('Subject: Only\rheader\r\nX-A: 1\r\n')).toEqual({
      head: [
        { k: 'Subject', v: 'Only\rheader' },
        { k: 'X-A', v: '1' },
      ],
      body: '',
    });
  });

  it('reads the obsolete form with whitespace before the colon and attaches foreign lines', () => {
    expect(sourceParts('Subject : Hello\nno field\nTo:\tanna@example.com\n\nText')).toEqual({
      head: [
        { k: 'Subject', v: 'Hello\nno field' },
        { k: 'To', v: 'anna@example.com' },
      ],
      body: 'Text',
    });
  });

  it('shows everything as body if the text does not start with header fields', () => {
    const mbox = 'From anna@example.com Mon Oct 26 09:14:00 2026\nSubject: Hello\n\nText';
    expect(sourceParts(mbox)).toEqual({ head: [], body: mbox });
    expect(sourceParts('\nText')).toEqual({ head: [], body: '\nText' });
    expect(sourceParts(' Continuation without field\n\nText').head).toEqual([]);
    expect(sourceParts('')).toEqual({ head: [], body: '' });
  });
});

describe('sourceFileName', () => {
  it('takes the subject without invalid characters, at most 60 characters', () => {
    expect(sourceFileName('Re: Offer 2026/Q4 "final"?', 'Message')).toBe('Re Offer 2026Q4 final.eml');
    expect(sourceFileName('é'.repeat(70), 'Message')).toBe(`${'é'.repeat(60)}.eml`);
    expect(sourceFileName('Line\r\nBreak\t', 'Message')).toBe('LineBreak.eml');
    expect(sourceFileName('Invoice\u202Efdp.exe\u007f\u0085\u2066', 'Message')).toBe('Invoicefdp.exe.eml');
  });

  it('names the file after `fallback` without a subject', () => {
    expect(sourceFileName('', 'Message')).toBe('Message.eml');
    expect(sourceFileName(' :?* ', 'Message')).toBe('Message.eml');
  });
});

describe('sourceChunk', () => {
  it('shows short bodies completely', () => {
    expect(sourceChunk('short', 10)).toBe('short');
  });

  it('cuts at the last line ending in the second half', () => {
    expect(sourceChunk('aaaa\nbbbb\ncccc', 12)).toBe('aaaa\nbbbb\n');
  });

  it('cuts at `limit` without a line ending there, without splitting a surrogate pair', () => {
    expect(sourceChunk('a\nbbbbbbbbbb', 8)).toBe('a\nbbbbbb');
    expect(sourceChunk('abc😀def', 4)).toBe('abc');
  });
});
