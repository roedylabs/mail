import { JmapClient, type Id } from '@roedy/jmap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Conversation,
  htmlOf,
  inlineCids,
  jmapMessageApi,
  MAX_BODY_BYTES,
  Messages,
  paragraphsOf,
  partText,
  truncationOf,
  type MessageApi,
  type MessageEmail,
  type MessagePart,
  listEmail,
  PREFETCH_EMAILS,
  PREFETCH_THREADS,
} from './message.svelte.ts';
import { NetworkError } from '#lib/api.ts';
import type { ListThread } from '#lib/mail-list.ts';
import { threadKey, type SavedThread } from '#lib/mail-store.ts';
import { edits } from './edits.svelte.ts';
import type { EmailChange } from './live.svelte.ts';
import { ui } from './ui.svelte.ts';

const MAIL = 'https://mail.example.com';
const CORE = 'urn:ietf:params:jmap:core';
const MAIL_CAP = 'urn:ietf:params:jmap:mail';
const SESSION = {
  capabilities: {
    [CORE]: {
      maxSizeUpload: 1000,
      maxConcurrentUpload: 2,
      maxSizeRequest: 100_000,
      maxConcurrentRequests: 4,
      maxCallsInRequest: 16,
      maxObjectsInGet: 100,
      maxObjectsInSet: 100,
      collationAlgorithms: [],
    },
    [MAIL_CAP]: {},
  },
  accounts: { j1: { name: 'a1@example.com', isPersonal: true, isReadOnly: false, accountCapabilities: {} } },
  primaryAccounts: { [MAIL_CAP]: 'j1' },
  username: 'a1@example.com',
  apiUrl: `${MAIL}/jmap/`,
  downloadUrl: `${MAIL}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
  uploadUrl: `${MAIL}/jmap/upload/{accountId}/`,
  eventSourceUrl: `${MAIL}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
  state: 's1',
};

type Invocation = [string, Record<string, unknown>, string];

/** Fake mail server: answers every call via `answer`, downloads with `blob`. */
function server(answer: (call: Invocation) => [string, unknown], blob = 'Content') {
  const seen: Invocation[] = [];
  const urls: string[] = [];
  const fetch = (url: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const href = url instanceof Request ? url.url : url.toString();
    urls.push(href);
    if (href.includes('/download/')) return Promise.resolve(new Response(blob));
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Invocation[] };
    const methodResponses = methodCalls.map((call) => {
      seen.push(call);
      const [name, args] = answer(call);
      return [name, args, call[2]];
    });
    return Promise.resolve(
      new Response(JSON.stringify({ methodResponses, sessionState: 's1' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  const client = new JmapClient({ url: MAIL, tokens: { token: () => Promise.resolve('t1') }, session: SESSION, fetch });
  return { client, seen, urls };
}

const part = (patch: Partial<MessagePart> = {}): MessagePart => ({
  partId: '1',
  blobId: 'b1',
  size: 10,
  name: null,
  type: 'text/plain',
  charset: 'utf-8',
  disposition: null,
  cid: null,
  ...patch,
});

const raw = (id: string, receivedAt: string) => ({
  id,
  blobId: `blob-${id}`,
  threadId: 't1',
  mailboxIds: { in: true },
  keywords: { $seen: true },
  receivedAt,
  from: [{ name: 'Anna', email: 'anna@example.com' }],
  to: [{ name: null, email: 'a1@example.com' }],
  cc: null,
  replyTo: null,
  subject: 'Hello',
  preview: 'Preview',
  hasAttachment: false,
  textBody: [part()],
  htmlBody: [part()],
  attachments: [],
  bodyValues: { '1': { value: `Text ${id}`, isEncodingProblem: false, isTruncated: false } },
});

function email(patch: Partial<MessageEmail> = {}): MessageEmail {
  return {
    id: 'e1',
    blobId: 'blob-e1',
    threadId: 't1',
    mailboxIds: ['in'],
    keywords: {},
    receivedAt: 0,
    from: [],
    to: [],
    cc: [],
    replyTo: [],
    messageId: [],
    inReplyTo: [],
    references: [],
    subject: '',
    preview: '',
    hasAttachment: false,
    textBody: [],
    htmlBody: [],
    attachments: [],
    bodyValues: {},
    ...patch,
  };
}

describe('jmapMessageApi', () => {
  it('fetches thread and emails with text and HTML parts in one request, oldest first', async () => {
    const { client, seen } = server(([name]) => {
      if (name === 'Thread/get')
        return [name, { accountId: 'j1', state: 's', list: [{ id: 't1', emailIds: ['e2', 'e1'] }], notFound: [] }];
      return [
        name,
        {
          accountId: 'j1',
          state: 's',
          list: [raw('e2', '2026-10-28T10:00:00Z'), raw('e1', '2026-10-27T10:00:00Z')],
          notFound: [],
        },
      ];
    });
    const emails = await jmapMessageApi(() => Promise.resolve(client)).thread('k1', 't1');
    expect(seen.map(([n]) => n)).toEqual(['Thread/get', 'Email/get']);
    expect(seen[0]![1]).toEqual({ accountId: 'j1', ids: ['t1'] });
    expect(seen[1]![1]).toMatchObject({
      '#ids': { resultOf: seen[0]![2], name: 'Thread/get', path: '/list/*/emailIds' },
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
      maxBodyValueBytes: MAX_BODY_BYTES,
    });
    expect(seen[1]![1]['properties']).toEqual(
      expect.arrayContaining(['textBody', 'htmlBody', 'attachments', 'bodyValues']),
    );
    expect(emails?.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(emails?.[0]).toMatchObject({
      mailboxIds: ['in'],
      receivedAt: Date.parse('2026-10-27T10:00:00Z'),
      cc: [],
      replyTo: [],
    });
  });

  it('leaves out emails from notFound like deleted ones (thread merge, Stalwart v1)', async () => {
    const answer =
      (found: string[]) =>
      ([name]: Invocation): [string, unknown] =>
        name === 'Thread/get'
          ? [name, { accountId: 'j1', state: 's', list: [{ id: 't1', emailIds: ['e1', 'e2'] }], notFound: [] }]
          : [
              name,
              {
                accountId: 'j1',
                state: 's',
                list: found.map((id) => raw(id, '2026-10-27T10:00:00Z')),
                notFound: ['e1', 'e2'].filter((id) => !found.includes(id)),
              },
            ];
    const some = server(answer(['e1']));
    expect((await jmapMessageApi(() => Promise.resolve(some.client)).thread('k1', 't1'))?.map((e) => e.id)).toEqual([
      'e1',
    ]);
    // None left: like a deleted thread.
    const none = server(answer([]));
    expect(await jmapMessageApi(() => Promise.resolve(none.client)).thread('k1', 't1')).toBeNull();
  });

  it('reports an unknown thread as `null`', async () => {
    const { client } = server(([name]) =>
      name === 'Thread/get'
        ? [name, { accountId: 'j1', state: 's', list: [], notFound: ['t9'] }]
        : [name, { accountId: 'j1', state: 's', list: [], notFound: [] }],
    );
    expect(await jmapMessageApi(() => Promise.resolve(client)).thread('k1', 't9')).toBeNull();
  });

  it('loads the parts of an email without limit ("Load full message")', async () => {
    const full = { '1': { value: 'Full text', isEncodingProblem: false, isTruncated: false } };
    const { client, seen } = server(([name]) => [
      name,
      { accountId: 'j1', state: 's', list: [{ id: 'e1', bodyValues: full }], notFound: [] },
    ]);
    const api = jmapMessageApi(() => Promise.resolve(client));
    expect(await api.fullBody('k1', 'e1', 'text')).toEqual(full);
    expect(seen.map(([n]) => n)).toEqual(['Email/get']);
    expect(seen[0]![1]).toEqual({
      accountId: 'j1',
      ids: ['e1'],
      properties: ['bodyValues'],
      fetchTextBodyValues: true,
    });
    // For HTML only the parts from `htmlBody`, not the plain-text alternative.
    await api.fullBody('k1', 'e1', 'html');
    expect(seen[1]![1]).toEqual({
      accountId: 'j1',
      ids: ['e1'],
      properties: ['bodyValues'],
      fetchHTMLBodyValues: true,
    });

    const { client: empty } = server(([name]) => [name, { accountId: 'j1', state: 's', list: [], notFound: ['e1'] }]);
    expect(await jmapMessageApi(() => Promise.resolve(empty)).fullBody('k1', 'e1', 'text')).toBeNull();
  });

  it("loads an attachment via the session's download URL", async () => {
    const { client, urls } = server(() => ['x', {}], 'PDF');
    const blob = await jmapMessageApi(() => Promise.resolve(client)).download(
      'k1',
      part({ blobId: 'b7', name: 'Plan.pdf', type: 'application/pdf' }),
    );
    expect(await blob.text()).toBe('PDF');
    expect(urls.at(-1)).toBe(`${MAIL}/jmap/download/j1/b7/Plan.pdf?accept=application%2Fpdf`);
    await expect(
      jmapMessageApi(() => Promise.resolve(client)).download('k1', part({ blobId: null })),
    ).rejects.toThrow();
  });
});

describe('Paragraphs', () => {
  it('splits plain text at blank lines and keeps line breaks within a paragraph', () => {
    const e = email({
      textBody: [part()],
      bodyValues: {
        '1': {
          value: 'Hello Anna,\r\n\r\nLine 1\nLine 2\n\n\n\nBest regards\nBen\n',
          isEncodingProblem: false,
          isTruncated: false,
        },
      },
    });
    expect(paragraphsOf(e)).toEqual(['Hello Anna,', 'Line 1\nLine 2', 'Best regards\nBen']);
  });

  it('takes only the text from HTML without a plain-text alternative, without scripts and styles', () => {
    const html = part({ type: 'text/html' });
    const values = {
      '1': {
        value:
          '<style>p{color:red}</style><p>First&nbsp;paragraph</p><div>Line<br>two</div><script>alert(1)</script><img src="https://x/y.png"><table><tr><td>Base price</td><td>9,90 €</td></tr></table>',
        isEncodingProblem: false,
        isTruncated: false,
      },
    };
    expect(partText(html, values)).not.toContain('alert');
    expect(paragraphsOf(email({ textBody: [html], bodyValues: values }))).toEqual([
      'First paragraph',
      'Line\ntwo',
      'Base price 9,90 €',
    ]);
  });

  it('collapses whitespace of the HTML source, except in `pre`', () => {
    const html = part({ type: 'text/html' });
    const value = '<table><tr><td>\n   Hello\n   world</td></tr></table><p>One\n\n   sentence</p><pre>a  b\nc</pre>';
    expect(
      paragraphsOf(
        email({ textBody: [html], bodyValues: { '1': { value, isEncodingProblem: false, isTruncated: false } } }),
      ),
    ).toEqual(['Hello world', 'One sentence', 'a  b\nc']);
  });

  it('splits every email only once', () => {
    const e = email({
      textBody: [part()],
      bodyValues: { '1': { value: 'A\n\nB', isEncodingProblem: false, isTruncated: false } },
    });
    expect(paragraphsOf(e)).toBe(paragraphsOf(e));
  });

  it('skips parts without a value and other types', () => {
    expect(paragraphsOf(email({ textBody: [part({ partId: '9' }), part({ type: 'image/png' })] }))).toEqual([]);
  });
});

/** API with controllable responses. */
function fakeApi() {
  const calls: string[] = [];
  let next: () => Promise<MessageEmail[] | null> = () => Promise.resolve([email()]);
  const api: MessageApi = {
    thread: (account, threadId) => {
      calls.push(`${account}/${threadId}`);
      return next();
    },
    threads: () => Promise.resolve(new Map()),
    locate: () => Promise.resolve(null),
    fullBody: () => Promise.resolve(null),
    download: () => Promise.resolve(new Blob(['x'])),
  };
  return { api, calls, answer: (f: () => Promise<MessageEmail[] | null>) => (next = f) };
}

/** In-memory storage for conversations. */
function fakeStore(saved: SavedThread[] = []) {
  const map = new Map(saved.map((t) => [t.key, t]));
  const used: string[] = [];
  const dropped: Id[][] = [];
  const store = {
    thread: (key: string) => Promise.resolve(map.get(key) ?? null),
    saveThread: (t: SavedThread) => void map.set(t.key, t),
    useThread: (key: string) => void used.push(key),
    dropThread: (key: string) => void map.delete(key),
    dropEmails: (_: string, ids: Iterable<Id>) => void dropped.push([...ids]),
    heads: () => Promise.resolve([...map.values()].map((t) => ({ threadId: t.threadId, mails: t.emails })) as never),
  };
  return { store, map, used, dropped };
}

const savedThread = (emails: MessageEmail[], threadId = 't1', account = 'k1'): SavedThread => ({
  key: threadKey(account, threadId),
  account,
  threadId,
  emails,
});

const offline = () => Promise.reject(new NetworkError('gone'));

describe('Conversation', () => {
  afterEach(() => {
    // Do not carry anything pending into other tests (it would otherwise go to the real server).
    ui.toasts.undo();
    ui.reset();
    edits.reset();
  });

  it('loads on creation and knows ready, missing and error', async () => {
    const { api, answer } = fakeApi();
    const c = new Conversation(api, 'k1', 't1');
    expect(c.status).toBe('loading');
    await c.ready;
    expect(c.status).toBe('ready');
    expect(c.emails).toHaveLength(1);

    answer(() => Promise.resolve(null));
    const gone = new Conversation(api, 'k1', 't2');
    await gone.ready;
    expect(gone.status).toBe('missing');

    const failure = new Error('offline');
    answer(() => Promise.reject(failure));
    const broken = new Conversation(api, 'k1', 't3');
    await expect(broken.ready).rejects.toBe(failure);
    expect(broken.status).toBe('error');
    expect(broken.error).toBe(failure);

    answer(() => Promise.resolve([email({ id: 'e5' })]));
    await broken.refresh();
    expect(broken.status).toBe('ready');
    expect(broken.error).toBeNull();
  });

  it('shows own changes over the emails until "undo" reverts them', async () => {
    const { api, answer } = fakeApi();
    answer(() => Promise.resolve([email({ id: 'e1' }), email({ id: 'e2' })]));
    const c = new Conversation(api, 'k1', 't1');
    await c.ready;
    edits.run({
      account: 'k1',
      edits: new Map([
        ['e1', { keywords: { $seen: true }, mailboxIds: { in: false, trash: true } }],
        ['e2', { destroyed: true }],
      ]),
      text: 'Moved to Trash',
    });
    expect(c.emails.map((e) => [e.id, e.mailboxIds, e.keywords])).toEqual([['e1', ['trash'], { $seen: true }]]);
    ui.toasts.undo();
    expect(c.emails.map((e) => [e.id, e.mailboxIds, e.keywords])).toEqual([
      ['e1', ['in'], {}],
      ['e2', ['in'], {}],
    ]);
  });

  it('keeps the state on reload if the server fails', async () => {
    const { api, answer } = fakeApi();
    const c = new Conversation(api, 'k1', 't1');
    await c.ready;
    answer(() => Promise.reject(new Error('x')));
    await expect(c.refresh()).rejects.toThrow();
    expect(c.status).toBe('ready');
    expect(c.emails).toHaveLength(1);
  });
});

describe('HTML and embedded images', () => {
  const value = (v: string) => ({ value: v, isEncodingProblem: false, isTruncated: false });
  const mixed = () =>
    email({
      htmlBody: [
        part({ partId: '1', type: 'text/html' }),
        part({ partId: '2', type: 'text/plain' }),
        part({ partId: '3', type: 'image/png', blobId: 'b3' }),
        part({ partId: '4', type: 'text/html' }),
      ],
      bodyValues: {
        '1': value('<p>First <img src="cid:Logo%40example.com"></p>'),
        '2': value('Text <in between>'),
        '4': value('<p style="background:url(cid:bg)">Second</p>'),
      },
      attachments: [
        part({ partId: '5', blobId: 'b5', type: 'image/png', cid: 'logo@example.com' }),
        part({ partId: '6', blobId: 'b6', type: 'image/png', cid: 'bg' }),
        part({ partId: '7', blobId: 'b7', type: 'image/png', cid: 'unused' }),
      ],
    });
  const svg = () =>
    email({
      htmlBody: [part({ partId: '1', type: 'text/html' })],
      bodyValues: { '1': value('<img src="cid:s"><a href="cid:pdf">PDF</a>') },
      attachments: [
        part({ partId: '2', blobId: 's', type: 'image/svg+xml', cid: 's' }),
        part({ partId: '3', blobId: 'pdf', type: 'application/pdf', cid: 'pdf' }),
      ],
    });

  it('assembles HTML from `htmlBody`, plain text escaped, images in between via their key', () => {
    const e = mixed();
    expect(htmlOf(e)).toBe(
      '<p>First <img src="cid:Logo%40example.com"></p><div style="white-space:pre-wrap">Text &#60;in between&#62;</div>' +
        '<div><img src="cid:rm-part-3" alt=""></div><p style="background:url(cid:bg)">Second</p>',
    );
    expect([...inlineCids(e)]).toEqual(['logo@example.com', 'rm-part-3', 'bg']);
    // Without an HTML part (`htmlBody` like `textBody`) the page shows paragraphs.
    expect(htmlOf(email({ htmlBody: [part({ partId: '1', type: 'text/plain' })] }))).toBeNull();
  });

  it('loads the images of an email as blob URLs, retries failed ones and releases them with `dispose()`', async () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const create = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      created.push(`blob:x/${created.length}`);
      return created.at(-1)!;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
    const blobs: string[] = [];
    let offline = true;
    const api: MessageApi = {
      threads: () => Promise.resolve(new Map()),
      locate: () => Promise.resolve(null),
      thread: () => Promise.resolve([mixed()]),
      fullBody: () => Promise.resolve(null),
      download: (_account, ref) => {
        blobs.push(ref.blobId!);
        return ref.blobId === 'b6' && offline
          ? Promise.reject(new Error('gone'))
          : Promise.resolve(new Blob(['<html>'], { type: 'text/html' }));
      },
    };
    const c = new Conversation(api, 'k1', 't1');
    await c.ready;
    c.loadImages('e1');
    c.loadImages('e1');
    await vi.waitFor(() => expect(c.images['e1']).toBeDefined());
    expect(blobs).toEqual(['b5', 'b6', 'b3']);
    // Failed ones are missing; the blob has the type of the part, not that of the response.
    expect([...c.images['e1']!]).toEqual([
      ['logo@example.com', 'blob:x/0'],
      ['rm-part-3', 'blob:x/1'],
    ]);
    expect(create.mock.calls.map(([b]) => (b as Blob).type)).toEqual(['image/png', 'image/png']);
    // A repeated failure changes nothing (otherwise the page would run into the next attempt immediately).
    const first = c.images;
    c.loadImages('e1');
    await vi.waitFor(() => expect(blobs).toHaveLength(4));
    await new Promise((r) => setTimeout(r, 0));
    expect(c.images).toBe(first);
    // Online again: only the missing image.
    offline = false;
    c.loadImages('e1');
    await vi.waitFor(() => expect(c.images['e1']?.size).toBe(3));
    expect(blobs.slice(3)).toEqual(['b6', 'b6']);
    c.loadImages('e1');
    expect(blobs).toHaveLength(5);
    c.dispose();
    expect(revoked).toEqual(['blob:x/0', 'blob:x/1', 'blob:x/2']);
    vi.restoreAllMocks();
  });

  it('loads only raster images, no SVG and no other parts with a content ID', async () => {
    const blobs: string[] = [];
    const api: MessageApi = {
      threads: () => Promise.resolve(new Map()),
      locate: () => Promise.resolve(null),
      thread: () => Promise.resolve([svg()]),
      fullBody: () => Promise.resolve(null),
      download: (_account, ref) => {
        blobs.push(ref.blobId!);
        return Promise.resolve(new Blob(['x']));
      },
    };
    const c = new Conversation(api, 'k1', 't1');
    await c.ready;
    c.loadImages('e1');
    await vi.waitFor(() => expect(c.images['e1']).toBeDefined());
    expect(blobs).toEqual([]);
  });

  it('remembers "Load once" per email', () => {
    const c = new Conversation(fakeApi().api, 'k1', 't1');
    c.allowOnce('e1');
    const first = c.once;
    c.allowOnce('e1');
    expect(c.once).toBe(first);
    expect([...c.once]).toEqual(['e1']);
  });
});

describe('Truncated parts', () => {
  const value = (v: string, isTruncated: boolean) => ({ value: v, isEncodingProblem: false, isTruncated });
  const cut = () =>
    email({
      textBody: [part({ partId: '1', size: 2_000_000 })],
      htmlBody: [part({ partId: '1', size: 2_000_000 })],
      bodyValues: { '1': value('Startup', true) },
    });
  const FULL = { '1': value('Start and end', false) };

  it('detects the truncated part of the rendering', () => {
    expect(truncationOf(cut())).toEqual({ part: 'text', size: 2_000_000 });
    expect(truncationOf(email())).toBeNull();
    const html = email({
      textBody: [part({ partId: '1', size: 1_500_000 })],
      htmlBody: [part({ partId: '2', type: 'text/html', size: 3_000_000 })],
      bodyValues: { '1': value('Text', true), '2': value('<p>HTML', true) },
    });
    expect(truncationOf(html)).toEqual({ part: 'html', size: 3_000_000 });
  });

  function setup(fullBody: MessageApi['fullBody']) {
    const { api, answer } = fakeApi();
    answer(() => Promise.resolve([cut()]));
    return { c: new Conversation({ ...api, fullBody }, 'k1', 't1'), answer };
  }

  it('loads the parts without limit, shows the loading and keeps them on reload', async () => {
    let resolve!: (v: typeof FULL) => void;
    const fullBody = vi.fn<MessageApi['fullBody']>(() => new Promise((r) => (resolve = r)));
    const { c } = setup(fullBody);
    await c.ready;
    const loading = c.loadFull('e1');
    expect(c.loadingFull.has('e1')).toBe(true);
    // A second click during loading does not ask again.
    await c.loadFull('e1');
    expect(fullBody).toHaveBeenCalledTimes(1);
    expect(fullBody).toHaveBeenCalledWith('k1', 'e1', 'text', expect.any(AbortSignal));
    resolve(FULL);
    await loading;
    expect(c.loadingFull.size).toBe(0);
    expect(c.emails[0]!.bodyValues).toEqual(FULL);
    expect(paragraphsOf(c.emails[0]!)).toEqual(['Start and end']);
    expect(truncationOf(c.emails[0]!)).toBeNull();
    // Reloaded, the part comes truncated again: the full one stays.
    await c.refresh();
    expect(c.emails[0]!.bodyValues).toEqual(FULL);
    await c.loadFull('e1');
    expect(fullBody).toHaveBeenCalledTimes(1);
  });

  it('keeps parts the response does not name', async () => {
    const two = email({
      textBody: [part({ partId: '1', size: 2_000_000 })],
      htmlBody: [part({ partId: '2', type: 'text/html', size: 3_000_000 })],
      bodyValues: { '1': value('Plain text', true), '2': value('<p>HTML', true) },
    });
    const { api, answer } = fakeApi();
    answer(() => Promise.resolve([two]));
    const fullBody = vi.fn<MessageApi['fullBody']>(() => Promise.resolve({ '2': value('<p>HTML full</p>', false) }));
    const c = new Conversation({ ...api, fullBody }, 'k1', 't1');
    await c.ready;
    await c.loadFull('e1');
    expect(fullBody).toHaveBeenCalledWith('k1', 'e1', 'html', expect.any(AbortSignal));
    expect(c.emails[0]!.bodyValues).toEqual({ '1': value('Plain text', true), '2': value('<p>HTML full</p>', false) });
    expect(truncationOf(c.emails[0]!)).toBeNull();
  });

  it('fails if the server truncates even without a limit, and does not ask for full ones', async () => {
    const fullBody = vi.fn<MessageApi['fullBody']>(() => Promise.resolve({ '1': value('Start and more', true) }));
    const { c } = setup(fullBody);
    await c.ready;
    await expect(c.loadFull('e1')).rejects.toThrow();
    expect(paragraphsOf(c.emails[0]!)).toEqual(['Start and more']);
    // A repeated click asks again instead of silently doing nothing.
    await expect(c.loadFull('e1')).rejects.toThrow();
    expect(fullBody).toHaveBeenCalledTimes(2);

    const { api } = fakeApi();
    const none = vi.fn<MessageApi['fullBody']>(() => Promise.resolve(null));
    const plain = new Conversation({ ...api, fullBody: none }, 'k1', 't1');
    await plain.ready;
    await plain.loadFull('e1');
    expect(none).not.toHaveBeenCalled();
  });

  it('loads new images of the complete HTML even while the first pass is still running', async () => {
    vi.spyOn(URL, 'createObjectURL').mockImplementation((b) => `blob:${(b as Blob).size}-${Math.random()}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const img = (n: string) => part({ partId: n, blobId: `img${n}`, type: 'image/png', cid: `${n}@x` });
    const cutHtml = email({
      htmlBody: [part({ partId: '1', type: 'text/html', size: 2_000_000 })],
      attachments: [img('a'), img('b')],
      bodyValues: { '1': value('<img src="cid:a@x"><p>Start', true) },
    });
    const downloads: Record<string, () => void> = {};
    const { api, answer } = fakeApi();
    answer(() => Promise.resolve([cutHtml]));
    const c = new Conversation(
      {
        ...api,
        fullBody: () => Promise.resolve({ '1': value('<img src="cid:a@x"><img src="cid:b@x"><p>End</p>', false) }),
        download: (_account, ref) =>
          new Promise((resolve) => (downloads[ref.blobId!] = () => resolve(new Blob(['x'])))),
      },
      'k1',
      't1',
    );
    await c.ready;
    c.loadImages('e1');
    expect(Object.keys(downloads)).toEqual(['imga']);
    await c.loadFull('e1');
    // The page calls again on new values; the running pass waits.
    c.loadImages('e1');
    expect(Object.keys(downloads)).toEqual(['imga']);
    downloads['imga']!();
    await vi.waitFor(() => expect(Object.keys(downloads)).toEqual(['imga', 'imgb']));
    downloads['imgb']!();
    await vi.waitFor(() => expect([...(c.images['e1']?.keys() ?? [])].sort()).toEqual(['a@x', 'b@x']));
  });

  it("fails with the server's error, the truncated state stays", async () => {
    const failure = new Error('offline');
    const { c } = setup(() => Promise.reject(failure));
    await c.ready;
    await expect(c.loadFull('e1')).rejects.toBe(failure);
    expect(c.loadingFull.size).toBe(0);
    expect(truncationOf(c.emails[0]!)).not.toBeNull();
    const gone = setup(() => Promise.resolve(null)).c;
    await gone.ready;
    await expect(gone.loadFull('e1')).rejects.toThrow();
  });

  it('reports nothing after `dispose()`', async () => {
    let reject!: (e: unknown) => void;
    const { c } = setup((_a, _id, _part, signal) => {
      signal?.addEventListener('abort', () => reject(signal.reason));
      return new Promise((_r, j) => (reject = j));
    });
    await c.ready;
    const loading = c.loadFull('e1');
    c.dispose();
    await expect(loading).resolves.toBeUndefined();
    expect(truncationOf(c.emails[0]!)).not.toBeNull();
  });
});

describe('Conversation, overlapping loads', () => {
  it('takes over only the response of the latest run', async () => {
    const answers: ((v: MessageEmail[]) => void)[] = [];
    const api: MessageApi = {
      threads: () => Promise.resolve(new Map()),
      locate: () => Promise.resolve(null),
      thread: () => new Promise((resolve) => answers.push(resolve)),
      fullBody: () => Promise.resolve(null),
      download: () => Promise.resolve(new Blob()),
    };
    const c = new Conversation(api, 'k1', 't1');
    const second = c.refresh();
    answers[1]!([email({ id: 'new' })]);
    await second;
    answers[0]!([email({ id: 'old' })]);
    await c.ready;
    expect(c.emails.map((e) => e.id)).toEqual(['new']);
  });
});

describe('Messages', () => {
  it('keeps opened threads in memory and reloads failed ones', async () => {
    const { api, calls, answer } = fakeApi();
    const messages = new Messages(api);
    const first = messages.open('k1', 't1');
    expect(first.cached).toBe(false);
    await first.conversation.ready;
    const again = messages.open('k1', 't1');
    expect(again).toEqual({ conversation: first.conversation, cached: true });
    expect(calls).toEqual(['k1/t1']);

    answer(() => Promise.reject(new Error('x')));
    const broken = messages.open('k1', 't2');
    await broken.conversation.ready.catch(() => {});
    answer(() => Promise.resolve([email()]));
    expect(messages.open('k1', 't2').cached).toBe(false);
  });

  it('evicts the oldest thread beyond 20 and discards removed accounts', () => {
    const { api } = fakeApi();
    const messages = new Messages(api);
    const oldest = messages.open('k1', 't0').conversation;
    for (let i = 1; i <= 20; i++) messages.open('k1', `t${i}`);
    expect(messages.open('k1', 't0').conversation).not.toBe(oldest);

    const other = messages.open('k2', 'x').conversation;
    messages.retain(['k1']);
    expect(messages.open('k2', 'x').conversation).not.toBe(other);
    const kept = messages.open('k1', 't20').conversation;
    messages.reset();
    expect(messages.open('k1', 't20').conversation).not.toBe(kept);
  });

  it('reloads displayed conversations the live sync affects', async () => {
    const { api, calls } = fakeApi();
    const messages = new Messages(api);
    const shown = messages.open('k1', 't1').conversation;
    const hidden = messages.open('k1', 't2').conversation;
    await Promise.all([shown.ready, hidden.ready]);
    const hide = messages.show(shown);
    messages.show(hidden)();
    const change = (patch: Partial<EmailChange>): EmailChange => ({
      account: 'k1',
      reset: false,
      threads: new Set(),
      destroyed: new Set(),
      ...patch,
    });
    calls.length = 0;
    await messages.touch(change({ threads: new Set(['t9']) }));
    await messages.touch(change({ account: 'k2', reset: true }));
    expect(calls).toEqual([]);
    await messages.touch(change({ threads: new Set(['t1', 't2']) }));
    // Email `e1` from `email()` deleted – even if an own change already hides it –, reload after `reset`.
    edits.run({ account: 'k1', edits: new Map([['e1', { destroyed: true }]]), text: 'Message deleted' });
    expect(shown.emails).toEqual([]);
    await messages.touch(change({ destroyed: new Set(['e1']) }));
    ui.toasts.undo();
    await messages.touch(change({ reset: true }));
    expect(calls).toEqual(['k1/t1', 'k1/t1', 'k1/t1']);
    hide();
    await messages.touch(change({ reset: true }));
    expect(calls).toHaveLength(3);
  });

  it('reloads a displayed conversation only after its first load', async () => {
    const { api, calls, answer } = fakeApi();
    let release!: (emails: MessageEmail[]) => void;
    answer(() => new Promise((r) => (release = r)));
    const messages = new Messages(api);
    const c = messages.open('k1', 't1').conversation;
    messages.show(c);
    const touched = messages.touch({ account: 'k1', reset: false, threads: new Set(['t1']), destroyed: new Set() });
    expect(calls).toEqual(['k1/t1']);
    answer(() => Promise.resolve([email()]));
    release([email()]);
    await c.ready;
    expect(c.status).toBe('ready');
    await touched;
    expect(calls).toEqual(['k1/t1', 'k1/t1']);
  });

  it('passes downloads on to the API', async () => {
    const { api } = fakeApi();
    const spy = vi.spyOn(api, 'download');
    const p = part({ blobId: 'b2' });
    await new Messages(api).download('k1', p);
    expect(spy).toHaveBeenCalledWith('k1', p);
  });
});

describe('MessageSource', () => {
  const RAW = 'From: Anna <anna@example.com>\r\nSubject: Greetings\r\n\r\nHello\r\n';

  it("loads the source via the email's blobId as message/rfc822", async () => {
    const download = vi.fn<MessageApi['download']>(() => Promise.resolve(new Blob([RAW])));
    const source = new Messages({ ...fakeApi().api, download }).source(
      'k1',
      { id: 'e1', blobId: 'm1' },
      'Greetings.eml',
    );
    expect(download).toHaveBeenCalledWith(
      'k1',
      { blobId: 'm1', name: 'Greetings.eml', type: 'message/rfc822' },
      expect.any(AbortSignal),
    );
    expect(source).toMatchObject({ emailId: 'e1', fileName: 'Greetings.eml', parts: null, disposed: false });
    expect(await source.text).toBe(RAW);
    expect(await (await source.blob).text()).toBe(RAW);
    await vi.waitFor(() => expect(source.parts).not.toBeNull());
    expect(source.parts).toEqual({
      head: [
        { k: 'From', v: 'Anna <anna@example.com>' },
        { k: 'Subject', v: 'Greetings' },
      ],
      body: 'Hello\n',
    });
  });

  it('fails with the download error and stays without content', async () => {
    const error = new TypeError('Failed to fetch');
    const source = new Messages({ ...fakeApi().api, download: () => Promise.reject(error) }).source(
      'k1',
      { id: 'e1', blobId: 'm1' },
      'Message.eml',
    );
    await expect(source.text).rejects.toBe(error);
    await expect(source.blob).rejects.toBe(error);
    expect(source.parts).toBeNull();
  });

  it('aborts the download on closing and shows nothing afterwards', async () => {
    let signal: AbortSignal | undefined;
    let finish: (blob: Blob) => void = () => {};
    const download: MessageApi['download'] = (_account, _ref, s) => {
      signal = s;
      return new Promise((resolve) => (finish = resolve));
    };
    const source = new Messages({ ...fakeApi().api, download }).source('k1', { id: 'e1', blobId: 'm1' }, 'x.eml');
    source.dispose();
    expect(source.disposed).toBe(true);
    expect(signal?.aborted).toBe(true);
    // A server that does not notice the abort still delivers: `text` fails, `parts` stays empty.
    finish(new Blob([RAW]));
    await expect(source.text).rejects.toThrow();
    expect(source.parts).toBeNull();
  });

  it('uses the download URL with file name and content type', async () => {
    const { client, urls } = server(() => ['x', {}], RAW);
    const blob = await jmapMessageApi(() => Promise.resolve(client)).download('k1', {
      blobId: 'm1',
      name: 'Gr\u00fc\u00dfe.eml',
      type: 'message/rfc822',
    });
    expect(await blob.text()).toBe(RAW);
    expect(urls.at(-1)).toBe(`${MAIL}/jmap/download/j1/m1/Gr%C3%BC%C3%9Fe.eml?accept=message%2Frfc822`);
  });
});

describe('Storage of the reading view', () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    edits.reset();
  });

  it('comes from storage immediately; the server replaces the state and writes it back', async () => {
    const { store, map, used } = fakeStore([savedThread([email({ subject: 'Old' })])]);
    const { api, answer } = fakeApi();
    let answerNow: (emails: MessageEmail[]) => void = () => {};
    answer(() => new Promise((resolve) => (answerNow = resolve)));
    const c = new Conversation(api, 'k1', 't1', { store: () => store });
    await c.ready;
    expect(c.status).toBe('ready');
    expect(c.unconfirmed).toBe(true);
    expect(c.emails[0]?.subject).toBe('Old');
    expect(used).toEqual([threadKey('k1', 't1')]);
    answerNow([email({ subject: 'New' })]);
    await tick();
    expect(c.unconfirmed).toBe(false);
    expect(c.emails[0]?.subject).toBe('New');
    expect(map.get(threadKey('k1', 't1'))?.emails[0]?.subject).toBe('New');
  });

  it('stays with the stored state without connection', async () => {
    const { store } = fakeStore([savedThread([email()])]);
    const { api, answer } = fakeApi();
    answer(offline);
    const c = new Conversation(api, 'k1', 't1', { store: () => store });
    await c.ready;
    await tick();
    expect(c.status).toBe('ready');
    expect(c.unconfirmed).toBe(true);
  });

  it('reports `unreachable` without connection and without storage; retry keeps the card', async () => {
    const { store } = fakeStore();
    const { api, answer } = fakeApi();
    answer(offline);
    const c = new Conversation(api, 'k1', 't1', { store: () => store });
    await expect(c.ready).rejects.toBeInstanceOf(NetworkError);
    expect(c.unreachable).toBe(true);
    await expect(c.retry()).rejects.toBeInstanceOf(NetworkError);
    expect(c.status).toBe('error');
    answer(() => Promise.resolve([email()]));
    await c.retry();
    expect(c.status).toBe('ready');
    expect(c.unreachable).toBe(false);
  });

  it('never asks the server for an account without access', async () => {
    const { api, calls } = fakeApi();
    const saved = new Conversation(api, 'k1', 't1', {
      store: () => fakeStore([savedThread([email()])]).store,
      frozen: true,
    });
    await saved.ready;
    expect(saved.status).toBe('ready');
    await saved.refresh();
    saved.loadImages('e1');
    const cut = {
      textBody: [part({ partId: '1' })],
      bodyValues: { 1: { value: 'short', isTruncated: true, isEncodingProblem: false } },
    };
    const short = new Conversation(api, 'k1', 't1', {
      store: () => fakeStore([savedThread([email({ id: 'cut', ...cut })])]).store,
      frozen: true,
    });
    await short.ready;
    await expect(short.loadFull('cut')).rejects.toBeInstanceOf(NetworkError);
    const empty = new Conversation(api, 'k1', 't2', { store: () => fakeStore().store, frozen: true });
    await empty.ready;
    expect(empty.unreachable).toBe(true);
    await expect(empty.retry()).rejects.toBeInstanceOf(NetworkError);
    expect(calls).toEqual([]);
  });

  it('also writes the whole text after "Load full message"', async () => {
    const { store, map } = fakeStore();
    const { api, answer } = fakeApi();
    const cut = email({
      textBody: [part({ partId: '1' })],
      bodyValues: { 1: { value: 'short', isTruncated: true, isEncodingProblem: false } },
    });
    answer(() => Promise.resolve([cut]));
    const full = { 1: { value: 'long', isTruncated: false, isEncodingProblem: false } };
    const c = new Conversation({ ...api, fullBody: () => Promise.resolve(full) }, 'k1', 't1', { store: () => store });
    await c.ready;
    await c.loadFull(cut.id);
    expect(map.get(threadKey('k1', 't1'))?.emails[0]?.bodyValues[1]?.value).toBe('long');
  });

  it('finds a merged conversation via the Message-ID and discards the old one', async () => {
    const { store, map } = fakeStore([savedThread([email({ messageId: ['old@x'] }), email({ messageId: ['new@x'] })])]);
    const { api, answer } = fakeApi();
    answer(() => Promise.resolve(null));
    const locate = vi.fn(() => Promise.resolve('t9'));
    const c = new Conversation({ ...api, locate }, 'k1', 't1', { store: () => store });
    await c.ready;
    await tick();
    expect(locate).toHaveBeenCalledWith('k1', expect.objectContaining({ messageId: ['new@x'] }));
    expect(c.status).toBe('missing');
    expect(c.movedTo).toBe('t9');
    expect(map.size).toBe(0);
  });

  it('counts as deleted if the search finds nothing or the same thread or fails', async () => {
    for (const locate of [
      () => Promise.resolve(null),
      () => Promise.resolve('t1'),
      () => Promise.reject(new Error('x')),
    ]) {
      const { store } = fakeStore([savedThread([email({ messageId: ['a@x'] })])]);
      const { api, answer } = fakeApi();
      answer(() => Promise.resolve(null));
      const c = new Conversation({ ...api, locate }, 'k1', 't1', { store: () => store });
      await c.ready;
      await tick();
      expect(c.status).toBe('missing');
      expect(c.movedTo).toBeNull();
    }
  });

  it("creates a conversation anew when the account's access changes", () => {
    const { api } = fakeApi();
    const messages = new Messages(api, () => fakeStore().store);
    const first = messages.open('k1', 't1').conversation;
    const frozen = messages.open('k1', 't1', true);
    expect(frozen.cached).toBe(false);
    expect(frozen.conversation).not.toBe(first);
    expect(messages.open('k1', 't1', true).cached).toBe(true);
    messages.reset();
  });

  it('discards deleted emails in storage too', async () => {
    const { store, dropped } = fakeStore();
    const messages = new Messages(fakeApi().api, () => store);
    await messages.touch({
      account: 'k1',
      reset: false,
      threads: new Set(),
      destroyed: new Set(['e1']),
    } as unknown as EmailChange);
    expect(dropped).toEqual([['e1']]);
  });

  it('catches up on displayed states from storage when the account answers again', async () => {
    const { store } = fakeStore();
    const { api, answer, calls } = fakeApi();
    answer(offline);
    const messages = new Messages(api, () => store);
    const { conversation } = messages.open('k1', 't1');
    await conversation.ready.catch(() => {});
    const leave = messages.show(conversation);
    answer(() => Promise.resolve([email()]));
    await messages.resume('k2');
    expect(conversation.status).toBe('error');
    await messages.resume('k1');
    expect(conversation.status).toBe('ready');
    const before = calls.length;
    await messages.resume('k1');
    expect(calls).toHaveLength(before);
    leave();
    messages.reset();
  });

  it('fetches the top conversations that are missing or have new emails, per account in one request', async () => {
    const { store, map } = fakeStore([
      savedThread([email({ id: 'e1' })], 't1'),
      savedThread([email({ id: 'e2' })], 't2'),
    ]);
    const threads = vi.fn((_: string, ids: readonly Id[]) =>
      Promise.resolve(new Map(ids.map((id) => [id, [email({ id: `new-${id}`, threadId: id })]]))),
    );
    const messages = new Messages({ ...fakeApi().api, threads }, () => store);
    const row = (account: string, threadId: string, ...members: string[]) => ({
      account,
      threadId,
      members: members.map((id) => ({ id, mailboxIds: [], keywords: {}, from: '' })),
    });
    await messages.prefetch([
      row('k1', 't1', 'e1'),
      row('k1', 't2', 'e2', 'e3'),
      row('k1', 't3', 'e4'),
      row('k2', 't4', 'e5'),
    ]);
    expect(threads.mock.calls.map((c) => c.slice(0, 2))).toEqual([
      ['k1', ['t2', 't3']],
      ['k2', ['t4']],
    ]);
    expect(map.get(threadKey('k1', 't3'))?.emails[0]?.id).toBe('new-t3');
    expect(map.get(threadKey('k2', 't4'))).toBeDefined();
  });

  it('limits prefetching and stays silent on errors', async () => {
    const threads = vi.fn<MessageApi['threads']>(() => offline());
    const messages = new Messages({ ...fakeApi().api, threads }, () => fakeStore().store);
    const rows = Array.from({ length: PREFETCH_THREADS + 5 }, (_, i) => ({
      account: 'k1',
      threadId: `t${i}`,
      members: Array.from({ length: i === 0 ? PREFETCH_EMAILS + 1 : 1 }, (__, j) => ({
        id: `e${i}-${j}`,
        mailboxIds: [],
        keywords: {},
        from: '',
      })),
    }));
    await messages.prefetch(rows);
    const asked = threads.mock.calls[0]?.[1];
    expect(asked).toHaveLength(PREFETCH_THREADS - 1);
    expect(asked).not.toContain('t0');
  });

  it('turns a list row into an email without text', () => {
    const made = listEmail({
      id: 'e2',
      threadId: 't1',
      receivedAt: 5,
      from: [{ name: 'A', email: 'a@x' }],
      to: [],
      subject: 'Subject',
      preview: 'Preview',
      mailboxIds: ['m1', 'm2'],
      members: [{ id: 'e2', mailboxIds: ['m2'], keywords: { $seen: true }, from: 'a@x' }],
    } as unknown as ListThread);
    expect(made).toMatchObject({ id: 'e2', miss: true, mailboxIds: ['m2'], keywords: { $seen: true }, bodyValues: {} });
  });
});
