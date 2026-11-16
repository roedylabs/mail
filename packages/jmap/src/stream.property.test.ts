/**
 * Property-based tests for the EventSource parser: whatever the server sends
 * and however the network splits it into chunks, the parser yields the same
 * events as a plain reference implementation of the format (HTML, "Server-sent events").
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EventStreamParser, type ServerEvent } from './stream.ts';

/** Reference: the whole stream at once, line by line as in the specification. */
function reference(stream: string): { events: ServerEvent[]; retry: number | undefined } {
  const text = stream.startsWith('﻿') ? stream.slice(1) : stream;
  const lines = text.split(/\r\n|\r|\n/);
  // The last line has no line end yet (possibly empty) and stays unprocessed.
  lines.pop();
  const events: ServerEvent[] = [];
  let retry: number | undefined;
  let event = '';
  let data: string[] = [];
  let id = '';
  for (const line of lines) {
    if (line === '') {
      if (data.length > 0) events.push({ event: event || 'message', data: data.join('\n'), id });
      event = '';
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'event') event = value;
    else if (name === 'data') data.push(value);
    else if (name === 'id' && !value.includes('\0')) id = value;
    else if (name === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }
  return { events, retry };
}

/** Building blocks of the format: line ends of all three kinds, field names, values and odd characters. */
const fragment = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom('\n', '\r', '\r\n') },
  {
    weight: 4,
    arbitrary: fc.constantFrom('data', 'data: x', 'event', 'id', 'retry', ':', ': ', ' ', 'state', 'ping', '42', '\0'),
  },
  { weight: 1, arbitrary: fc.constantFrom('\uFEFF', 'ä', '😀', '{"@type":"StateChange"}') },
  { weight: 2, arbitrary: fc.string({ maxLength: 8, unit: 'binary' }) },
);

/** A stream as the network delivers it: chunks of fragments, empty chunks included. */
const chunks = fc.array(
  fc.array(fragment, { maxLength: 6 }).map((parts) => parts.join('')),
  { maxLength: 16 },
);

function parse(chunks: string[]): { events: ServerEvent[]; retry: number | undefined } {
  const parser = new EventStreamParser();
  const events = chunks.flatMap((chunk) => parser.push(chunk));
  return { events, retry: parser.retry };
}

describe('EventStreamParser – properties', () => {
  it('matches the reference implementation for the whole stream at once', () => {
    fc.assert(
      fc.property(chunks, (parts) => {
        const text = parts.join('');
        expect(parse([text])).toEqual(reference(text));
      }),
    );
  });

  it('yields the same events however the stream is split into chunks', () => {
    fc.assert(
      fc.property(chunks, (parts) => {
        expect(parse(parts)).toEqual(reference(parts.join('')));
      }),
      // Cheap per run; more runs find rarer splits. The example is a `\r\n` across an empty chunk
      // (`TextDecoder` returns one for a chunk with only part of a character).
      { numRuns: 1000, examples: [[['data: x\r', '', '\n']]] },
    );
  });
});
