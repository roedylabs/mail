import { JmapClient, type Id, type PatchObject, type Session } from '@roedy/jmap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GONE_AFTER,
  LATE_STEPS,
  MAX_WAIT,
  RETRY,
  SLACK,
  ScheduledSync,
  jmapScheduledApi,
  nextWait,
  verdictOf,
  verdictPatch,
  type ScheduledApi,
  type ScheduledBoxes,
  type ScheduledSubmission,
} from './scheduled.svelte.ts';

const NOW = Date.parse('2026-11-02T10:00:00Z');
const BOXES: ScheduledBoxes = { scheduled: 'b-sched', sent: 'b-sent', drafts: 'b-drafts' };
/** Mailboxes of an email in "Scheduled". */
const IN = [BOXES.scheduled];
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sub = (emailId: Id, at: number, undoStatus: ScheduledSubmission['undoStatus'] = 'pending') => ({
  emailId,
  sendAt: iso(at),
  undoStatus,
});

describe('verdictOf', () => {
  it('follows the status of the submissions', () => {
    expect(verdictOf(['pending'])).toBe('pending');
    expect(verdictOf(['final'])).toBe('sent');
    expect(verdictOf(['canceled'])).toBe('draft');
    // Stalwart deletes submissions three days after `sendAt`: the email counts as sent.
    expect(verdictOf([])).toBe('sent');
  });

  it('lets a waiting one win over a sent one, and that over a withdrawn one', () => {
    // Cancelled and rescheduled.
    expect(verdictOf(['canceled', 'pending'])).toBe('pending');
    expect(verdictOf(['canceled', 'final'])).toBe('sent');
  });
});

describe('verdictPatch', () => {
  it('files to "Sent" or as a draft to "Drafts", each without `$scheduled`', () => {
    expect(verdictPatch('sent', BOXES)).toEqual({
      'mailboxIds/b-sched': null,
      'mailboxIds/b-sent': true,
      'keywords/$scheduled': null,
    });
    expect(verdictPatch('draft', BOXES)).toEqual({
      'mailboxIds/b-sched': null,
      'mailboxIds/b-drafts': true,
      'keywords/$scheduled': null,
      'keywords/$draft': true,
    });
  });

  it('leaves the email without a target mailbox in "Scheduled", only without `$scheduled`', () => {
    expect(verdictPatch('sent', { ...BOXES, sent: null })).toEqual({ 'keywords/$scheduled': null });
    expect(verdictPatch('draft', { ...BOXES, drafts: null })).toEqual({
      'keywords/$scheduled': null,
      'keywords/$draft': true,
    });
  });
});

describe('nextWait', () => {
  it('waits until the earliest `sendAt` plus buffer', () => {
    expect(nextWait([NOW + 60_000, NOW + 30_000], NOW, 0)).toEqual({ wait: 30_000 + SLACK, late: 0 });
  });

  it('does not wait without a waiting submission', () => {
    expect(nextWait([], NOW, 3)).toEqual({ wait: null, late: 0 });
  });

  it('asks at growing intervals after a past `sendAt`, the last step repeats', () => {
    const waits = [0, 1, 2, 3, 4, 5, 6].map((late) => nextWait([NOW - 1000], NOW, late));
    expect(waits.map((w) => w.wait)).toEqual([...LATE_STEPS, LATE_STEPS.at(-1), LATE_STEPS.at(-1)]);
    expect(waits.map((w) => w.late)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('takes the next `sendAt` if it comes before the step', () => {
    expect(nextWait([NOW - 1000, NOW + 5000], NOW, 4)).toEqual({ wait: 5000 + SLACK, late: 5 });
  });

  it('waits at most one day in one go', () => {
    expect(nextWait([NOW + 30 * MAX_WAIT], NOW, 0).wait).toBe(MAX_WAIT);
  });
});

/** Fake mail server for the sync. */
function fake() {
  const state = {
    boxes: BOXES as ScheduledBoxes | null,
    emails: [] as Id[],
    /** All submissions; `pending()` returns the waiting ones. */
    subs: [] as ScheduledSubmission[],
    /** `receivedAt` per email; without a value older than `GONE_AFTER`. */
    saved: {} as Record<Id, number>,
    fail: null as Error | null,
    failUpdate: false,
  };
  const updates: Record<Id, PatchObject>[] = [];
  const api = {
    boxes: vi.fn(() => Promise.resolve(state.boxes)),
    pending: vi.fn<ScheduledApi['pending']>(() =>
      state.fail
        ? Promise.reject(state.fail)
        : Promise.resolve({
            emails: state.emails.map((id) => ({ id, receivedAt: state.saved[id] ?? NOW - GONE_AFTER - 1 })),
            submissions: state.subs.filter((s) => s.undoStatus === 'pending'),
          }),
    ),
    submissions: vi.fn((_account: string, emails: readonly Id[]) =>
      Promise.resolve(state.subs.filter((s) => emails.includes(s.emailId))),
    ),
    update: vi.fn((_account: string, patches: Record<Id, PatchObject>) => {
      if (state.failUpdate) return Promise.reject(new Error('notUpdated'));
      updates.push(patches);
      // As at the server: filed emails leave "Scheduled".
      state.emails = state.emails.filter((id) => !(id in patches));
      return Promise.resolve();
    }),
  } satisfies ScheduledApi;
  return { api, state, updates, sync: new ScheduledSync(api) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ScheduledSync', () => {
  it('knows the send times at start and waits for the earliest', async () => {
    const f = fake();
    f.state.emails = ['e1', 'e2'];
    f.state.subs = [sub('e1', NOW + 60_000), sub('e2', NOW + 20_000), sub('e2', NOW + 90_000)];
    f.sync.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.pending).toHaveBeenCalledWith('a1', 'b-sched', expect.any(AbortSignal));
    expect(f.sync.sendAt('a1', 'e1', IN)).toBe(NOW + 60_000);
    // Several waiting submissions: the earliest.
    expect(f.sync.sendAt('a1', 'e2', IN)).toBe(NOW + 20_000);
    expect(f.api.submissions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000 + SLACK - 1);
    expect(f.api.pending).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.api.pending).toHaveBeenCalledTimes(2);
  });

  it('files sent ones to "Sent", withdrawn ones to "Drafts" and those without a submission to "Sent"', async () => {
    const f = fake();
    f.state.emails = ['e1', 'e2', 'e3', 'e4'];
    f.state.subs = [sub('e1', NOW - 5000, 'final'), sub('e2', NOW + 5000, 'canceled'), sub('e4', NOW + 9000)];
    f.sync.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.submissions).toHaveBeenCalledWith('a1', ['e1', 'e2', 'e3'], expect.any(AbortSignal));
    expect(f.updates).toEqual([
      {
        e1: verdictPatch('sent', BOXES),
        e2: verdictPatch('draft', BOXES),
        e3: verdictPatch('sent', BOXES),
      },
    ]);
    expect(f.sync.sendAt('a1', 'e1', IN)).toBeUndefined();
    expect(f.sync.sendAt('a1', 'e4', IN)).toBe(NOW + 9000);
  });

  it('leaves an email without a submission that is younger than three days in "Scheduled"', async () => {
    const f = fake();
    f.state.emails = ['e1'];
    f.state.saved = { e1: NOW - GONE_AFTER + 60_000 };
    f.sync.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.updates).toEqual([]);
    vi.setSystemTime(NOW + 60_000);
    f.sync.touch('a1');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.updates).toEqual([{ e1: verdictPatch('sent', BOXES) }]);
  });

  it('names the send time only while the email lies in "Scheduled"', async () => {
    const f = fake();
    f.state.emails = ['e1'];
    f.state.subs = [sub('e1', NOW + 5000)];
    f.sync.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sync.sendAt('a1', 'e1', ['b-other', BOXES.scheduled])).toBe(NOW + 5000);
    // E.g. after "undo" to Drafts, before the next sync knows.
    expect(f.sync.sendAt('a1', 'e1', [BOXES.drafts!])).toBeUndefined();
  });

  it('takes over a waiting submission that the first query did not return', async () => {
    const f = fake();
    f.state.emails = ['e1'];
    f.state.subs = [sub('e1', NOW + 5000)];
    f.api.pending.mockResolvedValueOnce({ emails: [{ id: 'e1', receivedAt: NOW }], submissions: [] });
    f.sync.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.updates).toEqual([]);
    expect(f.sync.sendAt('a1', 'e1', IN)).toBe(NOW + 5000);
  });

  it('asks at growing intervals after `sendAt` until the submission no longer waits', async () => {
    const f = fake();
    f.state.emails = ['e1'];
    f.state.subs = [sub('e1', NOW + 1000)];
    f.sync.retain(['a1']);
    await vi.advanceTimersByTimeAsync(1000 + SLACK);
    expect(f.api.pending).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(LATE_STEPS[0]);
    expect(f.api.pending).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(LATE_STEPS[1] - 1);
    expect(f.api.pending).toHaveBeenCalledTimes(3);
    f.state.subs = [sub('e1', NOW + 1000, 'final')];
    await vi.advanceTimersByTimeAsync(1);
    expect(f.updates).toEqual([{ e1: verdictPatch('sent', BOXES) }]);
    // Nothing scheduled any more: no timer.
    await vi.advanceTimersByTimeAsync(MAX_WAIT);
    expect(f.api.pending).toHaveBeenCalledTimes(4);
  });

  it('advances the step only with the timer, not on a new email state', async () => {
    const f = fake();
    f.state.emails = ['e1'];
    f.state.subs = [sub('e1', NOW - 1000)];
    f.sync.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i++) {
      f.sync.touch('a1');
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(f.api.pending).toHaveBeenCalledTimes(5);
    // Still the first step.
    await vi.advanceTimersByTimeAsync(LATE_STEPS[0]);
    expect(f.api.pending).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(LATE_STEPS[1]);
    expect(f.api.pending).toHaveBeenCalledTimes(7);
  });

  it('syncs on a new email state, during a run exactly once afterwards', async () => {
    const f = fake();
    f.sync.retain(['a1']);
    f.sync.touch('a1');
    f.sync.touch('a1');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.pending).toHaveBeenCalledTimes(2);
    f.sync.touch('a2');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.api.pending).toHaveBeenCalledTimes(2);
  });

  it('queries nothing without "Scheduled"', async () => {
    const f = fake();
    f.state.boxes = null;
    f.sync.retain(['a1']);
    await vi.advanceTimersByTimeAsync(MAX_WAIT);
    expect(f.api.boxes).toHaveBeenCalledTimes(1);
    expect(f.api.pending).not.toHaveBeenCalled();
  });

  it('tries again after `RETRY` after an error', async () => {
    const f = fake();
    f.state.fail = new Error('offline');
    f.sync.retain(['a1']);
    await vi.advanceTimersByTimeAsync(RETRY - 1);
    expect(f.api.pending).toHaveBeenCalledTimes(1);
    f.state.fail = null;
    await vi.advanceTimersByTimeAsync(1);
    expect(f.api.pending).toHaveBeenCalledTimes(2);
  });

  it('retries a failed filing at the latest after `RETRY`', async () => {
    const f = fake();
    f.state.emails = ['e1'];
    f.state.subs = [sub('e1', NOW - 1000, 'final')];
    f.state.failUpdate = true;
    f.sync.retain(['a1']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.updates).toEqual([]);
    f.state.failUpdate = false;
    await vi.advanceTimersByTimeAsync(RETRY);
    expect(f.updates).toEqual([{ e1: verdictPatch('sent', BOXES) }]);
  });

  it('ends removed accounts and forgets everything on sign-out', async () => {
    const f = fake();
    f.state.emails = ['e1'];
    f.state.subs = [sub('e1', NOW + 5000)];
    f.sync.retain(['a1', 'a2']);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sync.sendAt('a2', 'e1', IN)).toBe(NOW + 5000);
    f.sync.retain(['a1']);
    expect(f.sync.sendAt('a2', 'e1', IN)).toBeUndefined();
    f.sync.reset();
    expect(f.sync.sendAt('a1', 'e1', IN)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(MAX_WAIT);
    expect(f.api.pending).toHaveBeenCalledTimes(2);
  });

  it('sends nothing more after ending in the middle of a run', async () => {
    const f = fake();
    f.state.emails = ['e1'];
    f.state.subs = [sub('e1', NOW - 1000, 'final')];
    f.sync.retain(['a1']);
    f.sync.retain([]);
    await vi.advanceTimersByTimeAsync(MAX_WAIT);
    expect(f.api.update).not.toHaveBeenCalled();
    expect(f.sync.sendAt('a1', 'e1', IN)).toBeUndefined();
  });
});

const MAIL = 'https://mail.example.com';
const MAIL_CAP = 'urn:ietf:params:jmap:mail';
const SESSION = {
  capabilities: {
    'urn:ietf:params:jmap:core': {
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
    'urn:ietf:params:jmap:submission': {},
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
  return { api: jmapScheduledApi(() => Promise.resolve(client)), seen };
}

const SIGNAL = new AbortController().signal;
const LIST = [sub('e1', NOW + 5000)];

describe('jmapScheduledApi', () => {
  it('queries emails in "Scheduled" and waiting submissions in one request', async () => {
    const { api, seen } = server(([name]) =>
      name === 'Email/query'
        ? [name, { accountId: 'j1', queryState: 'q1', canCalculateChanges: false, position: 0, ids: ['e1'] }]
        : name === 'Email/get'
          ? [name, { accountId: 'j1', state: 'm1', list: [{ id: 'e1', receivedAt: iso(NOW) }], notFound: [] }]
          : name === 'EmailSubmission/query'
            ? [name, { accountId: 'j1', queryState: 'q2', canCalculateChanges: false, position: 0, ids: ['s1'] }]
            : [name, { accountId: 'j1', state: 'x1', list: LIST, notFound: [] }],
    );
    expect(await api.pending('a1', 'b-sched', SIGNAL)).toEqual({
      emails: [{ id: 'e1', receivedAt: NOW }],
      submissions: LIST,
    });
    expect(seen.map(([name, args]) => [name, args])).toEqual([
      ['Email/query', { accountId: 'j1', filter: { inMailbox: 'b-sched', hasKeyword: '$scheduled' } }],
      [
        'Email/get',
        {
          accountId: 'j1',
          '#ids': { resultOf: seen[0]![2], name: 'Email/query', path: '/ids' },
          properties: ['receivedAt'],
        },
      ],
      ['EmailSubmission/query', { accountId: 'j1', filter: { undoStatus: 'pending' } }],
      [
        'EmailSubmission/get',
        {
          accountId: 'j1',
          '#ids': { resultOf: seen[2]![2], name: 'EmailSubmission/query', path: '/ids' },
          properties: ['emailId', 'sendAt', 'undoStatus'],
        },
      ],
    ]);
  });

  it('reads only their roles without loaded mailboxes', async () => {
    const { api, seen } = server(([name]) => [
      name,
      {
        accountId: 'j1',
        state: 'b1',
        list: [
          { id: 'b1', role: 'inbox' },
          { id: 'b2', role: 'scheduled' },
          { id: 'b3', role: 'sent' },
        ],
        notFound: [],
      },
    ]);
    expect(await api.boxes('a1', SIGNAL)).toEqual({ scheduled: 'b2', sent: 'b3', drafts: null });
    expect(seen[0]).toEqual(['Mailbox/get', { accountId: 'j1', ids: null, properties: ['role'] }, expect.any(String)]);
    const none = server(([name]) => [
      name,
      { accountId: 'j1', state: 'b1', list: [{ id: 'b1', role: 'inbox' }], notFound: [] },
    ]);
    expect(await none.api.boxes('a1', SIGNAL)).toBeNull();
  });

  it('queries all submissions of certain emails', async () => {
    const { api, seen } = server(([name]) =>
      name === 'EmailSubmission/query'
        ? [name, { accountId: 'j1', queryState: 'q2', canCalculateChanges: false, position: 0, ids: ['s1'] }]
        : [name, { accountId: 'j1', state: 'x1', list: LIST, notFound: [] }],
    );
    expect(await api.submissions('a1', ['e1', 'e2'], SIGNAL)).toEqual(LIST);
    expect(seen[0]![1]).toEqual({ accountId: 'j1', filter: { emailIds: ['e1', 'e2'] } });
  });

  it('updates the emails and throws if a change fails', async () => {
    const patch = verdictPatch('sent', BOXES);
    const ok = server(([name]) => [name, { accountId: 'j1', newState: 'm2', updated: { e1: null } }]);
    await ok.api.update('a1', { e1: patch }, SIGNAL);
    expect(ok.seen[0]![1]).toEqual({ accountId: 'j1', update: { e1: patch } });
    const failed = server(([name]) => [
      name,
      { accountId: 'j1', newState: 'm2', notUpdated: { e1: { type: 'notFound' } } },
    ]);
    await expect(failed.api.update('a1', { e1: patch }, SIGNAL)).rejects.toThrow('e1');
  });
});
