import { JmapClient, JmapError, type EventsOptions, type Session } from '@roedy/jmap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAILURE_WINDOW,
  LiveSync,
  PILL_MIN,
  POLL_INTERVAL,
  PUSH_RETRY,
  type EmailChange,
  type EmailChanges,
  type LiveApi,
  jmapLiveApi,
} from './live.svelte.ts';

/** Fake server: streams stay open until they abort; responses are configurable. */
function fake() {
  const streams: { account: string; options: EventsOptions }[] = [];
  let fail: Error | null = null;
  const state = { email: 'e1' };
  const answers: EmailChanges[] = [];
  const api = {
    events: vi.fn((account: string, options: EventsOptions) => {
      if (fail) return Promise.reject(fail);
      streams.push({ account, options });
      return new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve()));
    }),
    accountId: vi.fn((account: string) => Promise.resolve(`j-${account}`)),
    emailState: vi.fn(() => Promise.resolve(state.email)),
    emailChanges: vi.fn((): Promise<EmailChanges> =>
      Promise.resolve(
        answers.shift() ?? { reset: false, state: state.email, threads: new Set(), destroyed: new Set() },
      ),
    ),
  } satisfies LiveApi;
  const targets = {
    mailboxes: vi.fn<(account: string) => Promise<void>>(() => Promise.resolve()),
    emails: vi.fn<(change: EmailChange) => Promise<void>>(() => Promise.resolve()),
  };
  return {
    api,
    targets,
    streams,
    state,
    answers,
    failWith: (error: Error | null) => (fail = error),
    live: new LiveSync(api, targets),
    /** Last open stream of an account. */
    stream: (account = 'a1') => streams.filter((s) => s.account === account && !s.options.signal.aborted).at(-1)!,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

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
      maxCallsInRequest: 8,
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
} satisfies Session;

type Invocation = [string, Record<string, unknown>, string];

/** Fake mail server: answers every call with `answer`. */
function server(answer: (call: Invocation) => [string, unknown]) {
  const seen: Invocation[] = [];
  const fetch = (_url: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Invocation[] };
    const methodResponses = methodCalls.map((call) => {
      seen.push(call);
      const [name, args] = answer(call);
      return [name, args, call[2]];
    });
    return Promise.resolve(Response.json({ methodResponses, sessionState: 's1' }));
  };
  const client = new JmapClient({ url: MAIL, tokens: { token: () => Promise.resolve('t1') }, session: SESSION, fetch });
  return { api: jmapLiveApi(() => Promise.resolve(client)), seen };
}

const SIGNAL = new AbortController().signal;

describe('jmapLiveApi', () => {
  it('reads the email state without emails', async () => {
    const { api, seen } = server(() => ['Email/get', { accountId: 'j1', state: 'e4', list: [], notFound: [] }]);
    expect(await api.emailState('a1', SIGNAL)).toBe('e4');
    expect(await api.accountId('a1', SIGNAL)).toBe('j1');
    expect(seen[0]).toEqual(['Email/get', { accountId: 'j1', ids: [], properties: ['id'] }, expect.any(String)]);
  });

  it('returns the threads of new and changed emails and the deleted ones', async () => {
    const { api, seen } = server(([name, args]) => {
      if (name === 'Email/changes')
        return [
          name,
          {
            accountId: 'j1',
            oldState: 'e1',
            newState: 'e2',
            hasMoreChanges: false,
            created: ['m1'],
            updated: ['m2'],
            destroyed: ['m3'],
          },
        ];
      const ids = args['#ids'] as { path: string };
      const list = ids.path === '/created' ? [{ id: 'm1', threadId: 't1' }] : [{ id: 'm2', threadId: 't2' }];
      return [name, { accountId: 'j1', state: 'e2', list, notFound: [] }];
    });
    expect(await api.emailChanges('a1', 'e1', SIGNAL)).toEqual({
      reset: false,
      state: 'e2',
      threads: new Set(['t1', 't2']),
      destroyed: new Set(['m3']),
    });
    expect(seen[1]![1]).toMatchObject({ properties: ['threadId'] });
  });

  it('reports `cannotCalculateChanges` as `reset`', async () => {
    const { api } = server(([name]) =>
      name === 'Email/changes'
        ? ['error', { type: 'cannotCalculateChanges' }]
        : ['error', { type: 'invalidResultReference' }],
    );
    expect(await api.emailChanges('a1', 'e1', SIGNAL)).toEqual({ reset: true });
  });
});

describe('Push', () => {
  it('syncs at the start and after every setup and remembers the email state', async () => {
    const f = fake();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.events).toHaveBeenCalledTimes(1);
    expect(f.stream().options.types).toEqual(['Mailbox', 'Email']);
    // The first sync does not wait for the stream.
    expect(f.targets.mailboxes).toHaveBeenCalledWith('a1');
    expect(f.api.emailState).toHaveBeenCalledTimes(1);
    expect(f.api.emailChanges).not.toHaveBeenCalled();
    f.stream().options.onOpen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.targets.mailboxes).toHaveBeenCalledTimes(2);
    expect(f.api.emailChanges).toHaveBeenCalledWith('a1', 'e1', expect.any(AbortSignal));
    expect(f.live.mode('a1')).toBe('push');
  });

  it('syncs only the named account when the service worker asks', async () => {
    const f = fake();
    f.live.retain(['a1', 'a2']);
    await vi.advanceTimersByTimeAsync(0);
    f.targets.mailboxes.mockClear();
    f.live.refresh('a2');
    f.live.refresh('unknown');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.targets.mailboxes.mock.calls).toEqual([['a2']]);
  });

  it('reports the new state and that the account has answered', async () => {
    const reached = vi.fn(() => Promise.resolve());
    const f = fake();
    const live = new LiveSync(f.api, { ...f.targets, reached });
    f.answers.push({ reset: false, state: 'e2', threads: new Set(['t']), destroyed: new Set() });
    live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(reached).toHaveBeenCalledTimes(1);
    live.retain([]);
    live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.targets.emails).toHaveBeenCalledWith(expect.objectContaining({ account: 'a1', state: 'e2' }));
    expect(reached).toHaveBeenCalledTimes(2);
    f.api.emailChanges.mockRejectedValueOnce(new Error('offline'));
    live.retain([]);
    live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(reached).toHaveBeenCalledTimes(2);
    live.reset();
  });

  it('keeps the email state across stop and restart, until sign-out', async () => {
    const f = fake();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    // "Sign-in required", then "sign in again": the sync reports what happened in between.
    f.live.retain([]);
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.emailState).toHaveBeenCalledTimes(1);
    expect(f.api.emailChanges).toHaveBeenCalledWith('a1', 'e1', expect.any(AbortSignal));
    f.live.reset();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.emailState).toHaveBeenCalledTimes(2);
  });

  it('reports new and changed threads and deleted emails of its account', async () => {
    const f = fake();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    f.answers.push({ reset: false, state: 'e2', threads: new Set(['t1']), destroyed: new Set(['m9']) });
    f.stream().options.onState({ '@type': 'StateChange', changed: { 'j-a1': { Email: 'e2' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.emailChanges).toHaveBeenCalledWith('a1', 'e1', expect.any(AbortSignal));
    expect(f.targets.emails).toHaveBeenCalledWith({
      account: 'a1',
      reset: false,
      threads: new Set(['t1']),
      destroyed: new Set(['m9']),
      state: 'e2',
    });
    // Only the mailboxes: no email request; another JMAP account does not count.
    f.targets.mailboxes.mockClear();
    f.stream().options.onState({ '@type': 'StateChange', changed: { 'j-a1': { Mailbox: 'm2' } } });
    f.stream().options.onState({ '@type': 'StateChange', changed: { other: { Email: 'x', Mailbox: 'y' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.targets.mailboxes).toHaveBeenCalledTimes(1);
    expect(f.api.emailChanges).toHaveBeenCalledTimes(1);
    // The same email state again: nothing to do.
    f.stream().options.onState({ '@type': 'StateChange', changed: { 'j-a1': { Email: 'e2' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.emailChanges).toHaveBeenCalledTimes(1);
  });

  it('reports nothing without changes and reloads after cannotCalculateChanges', async () => {
    const f = fake();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    f.stream().options.onOpen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.emailChanges).toHaveBeenCalledTimes(1);
    expect(f.targets.emails).not.toHaveBeenCalled();
    f.answers.push({ reset: true });
    f.state.email = 'e7';
    f.stream().options.onState({ '@type': 'StateChange', changed: { 'j-a1': { Email: 'e5' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.targets.emails).toHaveBeenCalledWith({
      account: 'a1',
      reset: true,
      threads: new Set(),
      destroyed: new Set(),
    });
    f.stream().options.onState({ '@type': 'StateChange', changed: { 'j-a1': { Email: 'e8' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.emailChanges).toHaveBeenLastCalledWith('a1', 'e7', expect.any(AbortSignal));
  });

  it('merges triggers during a running sync into one more', async () => {
    const f = fake();
    let release!: () => void;
    f.targets.mailboxes.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    f.stream().options.onOpen?.();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++)
      f.stream().options.onState({ '@type': 'StateChange', changed: { 'j-a1': { Mailbox: `m${i}` } } });
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.targets.mailboxes).toHaveBeenCalledTimes(2);
  });

  it('survives a failed sync and tries again on the next trigger', async () => {
    const f = fake();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    f.api.emailChanges.mockRejectedValueOnce(new JmapError('unreachable'));
    f.stream().options.onState({ '@type': 'StateChange', changed: { 'j-a1': { Email: 'e2' } } });
    await vi.advanceTimersByTimeAsync(0);
    f.stream().options.onState({ '@type': 'StateChange', changed: { 'j-a1': { Email: 'e3' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.emailChanges).toHaveBeenCalledTimes(2);
    expect(f.api.emailChanges).toHaveBeenLastCalledWith('a1', 'e1', expect.any(AbortSignal));
  });
});

describe('Polling', () => {
  it('polls at an interval without push at the server and does not retry push', async () => {
    const f = fake();
    f.failWith(new JmapError('unsupported'));
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.live.mode('a1')).toBe('poll');
    // First sync at the start and the first poll right after it.
    expect(f.targets.mailboxes).toHaveBeenCalledTimes(2);
    expect(f.api.emailState).toHaveBeenCalledTimes(1);
    expect(f.api.emailChanges).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL);
    expect(f.targets.mailboxes).toHaveBeenCalledTimes(3);
    expect(f.api.emailChanges).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(PUSH_RETRY);
    expect(f.api.events).toHaveBeenCalledTimes(1);
    expect(f.live.mode('a1')).toBe('poll');
  });

  it('switches to polling after persistent errors and tries push again later', async () => {
    const f = fake();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    const first = f.stream();
    for (let i = 0; i < 2; i++) first.options.onError?.(new JmapError('invalidResponse'), 1000);
    expect(f.live.mode('a1')).toBe('push');
    first.options.onError?.(new JmapError('invalidResponse'), 4000);
    expect(first.options.signal.aborted).toBe(true);
    expect(f.live.mode('a1')).toBe('poll');
    await vi.advanceTimersByTimeAsync(PUSH_RETRY);
    expect(f.api.events).toHaveBeenCalledTimes(2);
    expect(f.live.mode('a1')).toBe('push');
  });

  it('stays with push on occasional errors', async () => {
    const f = fake();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) {
      f.stream().options.onError?.(new JmapError('invalidResponse'), 1000);
      await vi.advanceTimersByTimeAsync(FAILURE_WINDOW + 1);
    }
    expect(f.live.mode('a1')).toBe('push');
    // A state in between resets the count.
    f.stream().options.onError?.(new JmapError('invalidResponse'), 1000);
    f.stream().options.onError?.(new JmapError('invalidResponse'), 1000);
    f.stream().options.onState({ '@type': 'StateChange', changed: {} });
    f.stream().options.onError?.(new JmapError('invalidResponse'), 1000);
    expect(f.live.mode('a1')).toBe('push');
  });

  it('switches to polling when the token already fails', async () => {
    const f = fake();
    f.api.accountId.mockRejectedValueOnce(new Error('offline'));
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.live.mode('a1')).toBe('poll');
    await vi.advanceTimersByTimeAsync(PUSH_RETRY);
    expect(f.live.mode('a1')).toBe('push');
    expect(f.api.events).toHaveBeenCalledTimes(1);
  });
});

describe('Connection back', () => {
  /** Incoming mail: the next sync reports it. */
  const NEWS: EmailChanges = { reset: false, state: 'e2', threads: new Set(['t1']), destroyed: new Set() };

  it('syncs immediately while polling and rebuilds the stream without waiting for PUSH_RETRY', async () => {
    const f = fake();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) f.stream().options.onError?.(new Error('Netz'), 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.live.mode('a1')).toBe('poll');
    const streams = f.api.events.mock.calls.length;
    const synced = f.targets.mailboxes.mock.calls.length;
    f.answers.push(NEWS);

    f.live.reconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(f.live.mode('a1')).toBe('push');
    expect(f.api.events).toHaveBeenCalledTimes(streams + 1);
    expect(f.targets.mailboxes.mock.calls.length).toBeGreaterThan(synced);
    expect(f.targets.emails).toHaveBeenCalledWith({
      account: 'a1',
      reset: false,
      threads: NEWS.threads,
      destroyed: NEWS.destroyed,
      state: 'e2',
    });
  });

  it('ends polling: afterwards no poll runs alongside', async () => {
    const f = fake();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 3; i++) f.stream().options.onError?.(new Error('Netz'), 1000);
    await vi.advanceTimersByTimeAsync(0);
    f.live.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    const asked = f.api.emailChanges.mock.calls.length;

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 2);

    expect(f.api.emailChanges).toHaveBeenCalledTimes(asked);
    expect(f.live.mode('a1')).toBe('push');
  });

  it('also replaces a stream that still counts as open, and syncs right away', async () => {
    const f = fake();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    const old = f.stream();
    f.answers.push(NEWS);

    f.live.reconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(old.options.signal.aborted).toBe(true);
    expect(f.stream()).not.toBe(old);
    expect(f.targets.emails).toHaveBeenCalledTimes(1);
  });

  it('also syncs when the new stream does not come about', async () => {
    const f = fake();
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    f.failWith(new Error('Netz'));
    f.answers.push(NEWS);

    f.live.reconnect();
    await vi.advanceTimersByTimeAsync(0);

    expect(f.targets.emails).toHaveBeenCalledTimes(1);
    expect(f.live.mode('a1')).toBe('poll');
  });

  it('polls immediately without push at the server and keeps the rhythm', async () => {
    const f = fake();
    f.failWith(new JmapError('unsupported'));
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL / 2);
    const calls = f.api.events.mock.calls.length;
    const asked = f.api.emailChanges.mock.calls.length;

    f.live.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.emailChanges).toHaveBeenCalledTimes(asked + 1);
    expect(f.api.events).toHaveBeenCalledTimes(calls);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL);
    expect(f.api.emailChanges).toHaveBeenCalledTimes(asked + 2);
  });
});

describe('Accounts', () => {
  it('ends accounts that are no longer included and reports nothing afterwards', async () => {
    const f = fake();
    f.live.retain(['a1', 'a2']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.events).toHaveBeenCalledTimes(2);
    const a1 = f.stream('a1');
    f.live.retain(['a2']);
    expect(a1.options.signal.aborted).toBe(true);
    expect(f.live.mode('a1')).toBeUndefined();
    f.targets.mailboxes.mockClear();
    a1.options.onOpen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.targets.mailboxes).not.toHaveBeenCalled();
    f.live.reset();
    expect(f.stream('a2')).toBeUndefined();
  });

  it('also ends polling', async () => {
    const f = fake();
    f.failWith(new JmapError('unsupported'));
    f.live.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    f.live.retain([]);
    f.targets.mailboxes.mockClear();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 3);
    expect(f.targets.mailboxes).not.toHaveBeenCalled();
  });
});

describe('Sync pill', () => {
  it('stays at least PILL_MIN, even if the first sync is faster', async () => {
    const f = fake();
    f.live.retain(['a1', 'a2']);
    expect(f.live.syncing).toBe(true);
    await vi.advanceTimersByTimeAsync(PILL_MIN - 1);
    expect(f.live.syncing).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.live.syncing).toBe(false);
    // Later syncs do not show it.
    f.stream('a1').options.onState({ '@type': 'StateChange', changed: { 'j-a1': { Email: 'e2' } } });
    expect(f.live.syncing).toBe(false);
  });

  it('stays until the first sync of all accounts is done', async () => {
    const f = fake();
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    f.api.emailState.mockImplementation((account?: string) =>
      account === 'a2' ? hold.then(() => 'e1') : Promise.resolve('e1'),
    );
    f.live.retain(['a1', 'a2']);
    await vi.advanceTimersByTimeAsync(PILL_MIN * 2);
    expect(f.live.syncing).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.live.syncing).toBe(false);
  });

  it('goes off immediately on sign-out', () => {
    const f = fake();
    f.live.retain(['a1']);
    f.live.reset();
    expect(f.live.syncing).toBe(false);
  });
});
