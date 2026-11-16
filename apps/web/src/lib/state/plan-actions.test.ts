import { JmapClient } from '@roedy/jmap';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { NetworkError } from '#lib/api.ts';
import type { ActionEmail, ActionRoles } from '#lib/mail-actions.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { edits, stamp } from '#lib/state/edits.svelte.ts';
import { scheduled } from '#lib/state/scheduled.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  jmapPlanApi,
  lateText,
  lateVerdict,
  PlanActions,
  type CancelResult,
  type LateSubmission,
  type PlanApi,
} from './plan-actions.ts';
import { m } from '#lib/paraglide/messages.js';

const resend = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const unsent = vi.hoisted(() => vi.fn());
vi.mock('#lib/state/compose.svelte.ts', () => ({ compose: { resend, unsent } }));

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
};

type Invocation = [string, Record<string, unknown>, string];

/** Fake mail server: `answer` returns the responses per call (also implicit ones). */
function server(answer: (call: Invocation) => [string, unknown][]) {
  const requests: Invocation[][] = [];
  const fetch = (_url: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Invocation[] };
    requests.push(methodCalls);
    const methodResponses = methodCalls.flatMap((call) => answer(call).map(([name, args]) => [name, args, call[2]]));
    return Promise.resolve(
      new Response(JSON.stringify({ methodResponses, sessionState: 's1' }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  };
  const client = new JmapClient({ url: MAIL, tokens: { token: () => Promise.resolve('t1') }, session: SESSION, fetch });
  return { api: jmapPlanApi(() => Promise.resolve(client)), requests };
}

const ENV = {
  mailFrom: { email: 'a1@example.com', parameters: null },
  rcptTo: [{ email: 'b@x.example', parameters: null }],
};
const sub = (id: string, emailId: string, undoStatus: string, extra: object = {}) => ({
  id,
  emailId,
  identityId: 'i1',
  envelope: ENV,
  undoStatus,
  ...extra,
});
const TO_DRAFTS = {
  'mailboxIds/sch': null,
  'mailboxIds/dr': true,
  'keywords/$scheduled': null,
  'keywords/$draft': true,
};

describe('jmapPlanApi', () => {
  it('cancels the waiting submissions and queries the status of the late ones', async () => {
    const { api, requests } = server(([name, args]) => {
      if (name === 'EmailSubmission/query' && (args['filter'] as { undoStatus?: string }).undoStatus)
        return [[name, { ids: ['s1', 's2'] }]];
      if (name === 'EmailSubmission/query') return [[name, { ids: ['s2', 's0'] }]];
      if (name === 'EmailSubmission/get' && requests.length === 1)
        return [[name, { list: [sub('s1', 'e1', 'pending'), sub('s2', 'e2', 'pending')] }]];
      if (name === 'EmailSubmission/get')
        return [
          [
            name,
            {
              list: [
                sub('s2', 'e2', 'final', { deliveryStatus: { 'b@x.example': { delivered: 'yes' } } }),
                sub('s0', 'e3', 'canceled'),
              ],
            },
          ],
        ];
      if (name === 'EmailSubmission/set')
        return [
          [name, { updated: { s1: null }, notUpdated: { s2: { type: 'cannotUnsend' } } }],
          ['Email/set', { updated: { e1: null } }],
        ];
      return [['error', { type: 'unknownMethod' }]];
    });
    const res = await api.cancel('k1', { e1: TO_DRAFTS, e2: TO_DRAFTS, e3: TO_DRAFTS }, false);
    expect(requests.map((r) => r.map(([name]) => name))).toEqual([
      ['EmailSubmission/query', 'EmailSubmission/get'],
      ['EmailSubmission/set'],
      ['EmailSubmission/query', 'EmailSubmission/get'],
    ]);
    expect(requests[0]![0]![1]['filter']).toEqual({ emailIds: ['e1', 'e2', 'e3'], undoStatus: 'pending' });
    expect(requests[1]![0]![1]).toMatchObject({
      update: { s1: { undoStatus: 'canceled' }, s2: { undoStatus: 'canceled' } },
      onSuccessUpdateEmail: { s1: TO_DRAFTS, s2: TO_DRAFTS },
    });
    // e3 was already no longer waiting at the query.
    expect(requests[2]![0]![1]['filter']).toEqual({ emailIds: ['e3', 'e2'] });
    expect(res.canceled).toEqual(new Map([['e1', { identityId: 'i1', envelope: ENV }]]));
    expect([...res.late.keys()].sort()).toEqual(['e2', 'e3']);
    expect(res.late.get('e3')).toMatchObject([{ undoStatus: 'canceled' }]);
    expect(res.failed).toEqual([]);
  });

  it('updates the email itself if the server does not run `onSuccessUpdateEmail`, and reports other errors', async () => {
    const { api, requests } = server(([name]) => {
      if (name === 'EmailSubmission/query') return [[name, { ids: ['s1', 's2'] }]];
      if (name === 'EmailSubmission/get')
        return [[name, { list: [sub('s1', 'e1', 'pending'), sub('s2', 'e2', 'pending')] }]];
      if (name === 'EmailSubmission/set')
        return [[name, { updated: { s1: null }, notUpdated: { s2: { type: 'serverFail' } } }]];
      if (name === 'Email/set') return [[name, { updated: { e1: null } }]];
      return [['error', { type: 'unknownMethod' }]];
    });
    const res = await api.cancel('k1', { e1: TO_DRAFTS, e2: TO_DRAFTS }, true);
    expect(requests.at(-1)).toEqual([
      ['Email/set', { accountId: 'j1', update: { e1: TO_DRAFTS } }, expect.any(String)],
    ]);
    expect([...res.canceled.keys()]).toEqual(['e1']);
    expect(res.failed).toEqual(['e2']);
  });
});

describe('lateVerdict and lateText', () => {
  const late = (undoStatus: LateSubmission['undoStatus'], delivered?: 'yes' | 'no'): LateSubmission => ({
    undoStatus,
    identityId: 'i1',
    envelope: null,
    sendAt: '2026-11-02T07:00:00Z',
    deliveryStatus: delivered ? { 'b@x.example': { delivered, smtpReply: '', displayed: 'unknown' } } : null,
  });

  it('follows the sync: sent, without accepted recipient, cancelled elsewhere, rescheduled', () => {
    expect(lateVerdict([late('final', 'yes')])).toBe('sent');
    expect(lateVerdict([late('final')])).toBe('sent');
    // Without a submission (or after a failed follow-up query) it stays scheduled, as in the sync.
    expect(lateVerdict([])).toBe('pending');
    expect(lateVerdict([late('final', 'no')])).toBe('draft');
    expect(lateVerdict([late('canceled')])).toBe('canceled');
    expect(lateVerdict([late('canceled'), late('final', 'yes')])).toBe('sent');
    expect(lateVerdict([late('canceled'), late('pending')])).toBe('pending');
  });

  it('names single, several and mixed (`planLateMsg`)', () => {
    expect(lateText(1, 0)).toBe('The message has already been sent.');
    expect(lateText(3, 0)).toBe('3 messages were already sent.');
    expect(lateText(1, 1)).toBe('Canceled sending 1 message, 1 was already sent.');
    expect(lateText(2, 1)).toBe('Canceled sending 1 message, 2 were already sent.');
    expect(lateText(1, 2)).toBe('Canceled sending 2 messages, 1 was already sent.');
    expect(lateText(3, 2)).toBe('Canceled sending 2 messages, 3 were already sent.');
  });
});

const ROLES: ActionRoles = {
  inbox: 'in',
  sent: 'se',
  drafts: 'dr',
  scheduled: 'sch',
  trash: 'tr',
  spam: 'sp',
};
const planned = (id: string): ActionEmail => ({ id, mailboxIds: ['sch'], keywords: { $scheduled: true } });

/** Fake API: cancels everything unless `late` and `failed` say otherwise. */
function fakeApi(result: Partial<CancelResult> = {}) {
  const cancel = vi.fn<PlanApi['cancel']>((_account, patches) =>
    Promise.resolve({
      canceled: new Map(
        Object.keys(patches)
          .filter((id) => !result.late?.has(id) && !result.failed?.includes(id))
          .map((id) => [id, { identityId: 'i1', envelope: null }]),
      ),
      late: result.late ?? new Map(),
      failed: result.failed ?? [],
    }),
  );
  const update = vi.fn<PlanApi['update']>(() => Promise.resolve());
  return { api: { cancel, update } satisfies PlanApi, cancel, update };
}

const late = (undoStatus: LateSubmission['undoStatus'], extra: Partial<LateSubmission> = {}): LateSubmission => ({
  undoStatus,
  identityId: 'i1',
  envelope: null,
  deliveryStatus: null,
  sendAt: '2026-11-02T07:00:00Z',
  ...extra,
});
const FINAL = [late('final')];

describe('PlanActions', () => {
  let touch: MockInstance<(account: string) => void>;
  beforeEach(() => {
    vi.useFakeTimers();
    accounts.list = [{ id: 'k1', email: 'a1@example.com', state: 'ok' } as MailAccount];
    touch = vi.spyOn(scheduled, 'touch').mockImplementation(() => {});
  });
  afterEach(() => {
    accounts.list = null;
    edits.reset();
    ui.reset();
    resend.mockClear();
    unsent.mockClear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('"Cancel send": immediately to Drafts, without undo, and reports it', async () => {
    const { api, cancel } = fakeApi();
    const p = new PlanActions(api);
    const before = stamp();
    const onStart = vi.fn();
    const running = p.cancel([{ account: 'k1', emails: [planned('e1')], roles: ROLES }], onStart);
    expect(onStart).toHaveBeenCalledOnce();
    expect(edits.edit('k1', 'e1', before)).toEqual({
      mailboxIds: { sch: false, dr: true },
      keywords: { $scheduled: false, $draft: true },
    });
    expect(await running).toEqual([{ account: 'k1', id: 'e1' }]);
    expect(cancel).toHaveBeenCalledExactlyOnceWith('k1', { e1: TO_DRAFTS }, false);
    expect(touch).toHaveBeenCalledWith('k1');
    // Draft again: compose opens it even if it was scheduled in this session.
    expect(unsent).toHaveBeenCalledExactlyOnceWith('k1', ['e1']);
    expect(ui.toast).toMatchObject({ text: 'Send canceled, saved as draft', undo: false });
    await p.cancel([{ account: 'k1', emails: [planned('e2'), planned('e3')], roles: ROLES }]);
    expect(ui.toast).toMatchObject({ text: 'Canceled sending 2 messages' });
  });

  it('too late: to "Sent" and error toast, also mixed', async () => {
    const { api, update } = fakeApi({ late: new Map([['e2', FINAL]]) });
    const p = new PlanActions(api);
    const before = stamp();
    const done = await p.cancel([{ account: 'k1', emails: [planned('e1'), planned('e2')], roles: ROLES }]);
    expect(done).toEqual([{ account: 'k1', id: 'e1' }]);
    expect(update).toHaveBeenCalledExactlyOnceWith('k1', {
      e2: { 'mailboxIds/sch': null, 'mailboxIds/se': true, 'keywords/$scheduled': null },
    });
    expect(edits.edit('k1', 'e2', before)).toEqual({
      mailboxIds: { sch: false, se: true },
      keywords: { $scheduled: false },
    });
    expect(ui.toast).toMatchObject({
      text: 'Canceled sending 1 message, 1 was already sent.',
      error: true,
    });
  });

  it('already cancelled elsewhere counts as reached; rescheduled and errors stay scheduled', async () => {
    const { api, update } = fakeApi({
      late: new Map([
        ['e1', [late('canceled')]],
        ['e2', [late('pending')]],
      ]),
    });
    const p = new PlanActions(api);
    const before = stamp();
    const done = await p.cancel([{ account: 'k1', emails: [planned('e1'), planned('e2')], roles: ROLES }]);
    expect(done).toEqual([{ account: 'k1', id: 'e1' }]);
    expect(update).toHaveBeenCalledWith('k1', { e1: TO_DRAFTS });
    expect(edits.edit('k1', 'e2', before)).toBeUndefined();
    expect(ui.toast).toMatchObject({
      text: m.plan_cancel_failed(),
      error: true,
    });
  });

  it('names the right account across several accounts, even if an earlier one fails', async () => {
    const { api, cancel } = fakeApi();
    cancel.mockRejectedValueOnce(new Error('500'));
    accounts.list = [
      { id: 'k1', email: 'a1@example.com', state: 'ok' } as MailAccount,
      { id: 'k2', email: 'a2@example.com', state: 'ok' } as MailAccount,
    ];
    const done = await new PlanActions(api).cancel([
      { account: 'k1', emails: [planned('e1')], roles: ROLES },
      { account: 'k2', emails: [planned('e2')], roles: ROLES },
    ]);
    expect(done).toEqual([{ account: 'k2', id: 'e2' }]);
    expect(ui.toast).toMatchObject({ error: true });
  });

  it('"Send now" after sending cancelled elsewhere takes the most recently scheduled submission', async () => {
    const newer = { mailFrom: { email: 'a1@example.com', parameters: null }, rcptTo: [] };
    const { api } = fakeApi({
      late: new Map([
        [
          'e1',
          [
            late('canceled', { sendAt: '2026-11-03T07:00:00Z', identityId: 'i2', envelope: newer }),
            late('canceled', { sendAt: '2026-11-02T07:00:00Z' }),
          ],
        ],
      ]),
    });
    await new PlanActions(api).sendNow({ ...planned('e1'), account: 'k1' }, ROLES, vi.fn());
    expect(resend).toHaveBeenCalledWith('k1', 'e1', { identityId: 'i2', envelope: newer }, expect.any(Function));
  });

  it('if everything fails, everything stays as it was; without connection with the text for it', async () => {
    const { api, cancel } = fakeApi();
    cancel.mockRejectedValueOnce(new NetworkError(new TypeError('Failed to fetch')));
    const p = new PlanActions(api);
    expect(await p.cancel([{ account: 'k1', emails: [planned('e1')], roles: ROLES }])).toEqual([]);
    expect(edits.edit('k1', 'e1', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({ text: 'No connection. Please try again.', error: true });
  });

  it('runs nothing while the account must sign in again (`planStale`); without a scheduled email `null`', async () => {
    accounts.list = [{ id: 'k1', email: 'a1@example.com', state: 'needs_reauth' } as MailAccount];
    const { api, cancel } = fakeApi();
    const p = new PlanActions(api);
    const onStart = vi.fn();
    expect(await p.cancel([{ account: 'k1', emails: [planned('e1')], roles: ROLES }], onStart)).toEqual([]);
    expect(onStart).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(ui.toast).toMatchObject({ text: 'Sign in to a1@example.com again first', error: true });
    const inbox: ActionEmail = { id: 'e9', mailboxIds: ['in'], keywords: {} };
    expect(await p.cancel([{ account: 'k1', emails: [inbox], roles: ROLES }])).toBeNull();
  });

  it('delete: cancellation only after the toast, with `$draft` to the trash; undo cancels nothing', async () => {
    const { api, cancel } = fakeApi();
    const p = new PlanActions(api);
    const part = p.trashPart({ account: 'k1', emails: [planned('e1')], roles: ROLES }, () => false)!;
    expect(part.edits).toEqual(
      new Map([['e1', { mailboxIds: { sch: false, tr: true }, keywords: { $scheduled: false, $draft: true } }]]),
    );
    edits.runAll([part], { text: 'Send canceled, moved to Trash' });
    ui.toasts.undo();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cancel).not.toHaveBeenCalled();

    edits.runAll([part], { text: 'Send canceled, moved to Trash' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      'k1',
      { e1: { 'mailboxIds/sch': null, 'mailboxIds/tr': true, 'keywords/$scheduled': null, 'keywords/$draft': true } },
      false,
    );
    expect(unsent).toHaveBeenCalledExactlyOnceWith('k1', ['e1']);
    expect(p.trashPart({ account: 'k1', emails: [], roles: ROLES }, () => false)).toBeNull();
  });

  it('delete too late: to "Sent" with error toast; if it fails, back to "Scheduled"', async () => {
    const tooLate = fakeApi({ late: new Map([['e1', FINAL]]) });
    const p = new PlanActions(tooLate.api);
    const before = stamp();
    edits.runAll([p.trashPart({ account: 'k1', emails: [planned('e1')], roles: ROLES }, () => false)!], {
      text: 'Send canceled, moved to Trash',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(edits.edit('k1', 'e1', before)).toEqual({
      mailboxIds: { sch: false, se: true },
      keywords: { $scheduled: false },
    });
    expect(ui.toast).toMatchObject({ text: 'The message has already been sent.', error: true });

    const failing = fakeApi({ failed: ['e2'] });
    const q = new PlanActions(failing.api);
    edits.runAll([q.trashPart({ account: 'k1', emails: [planned('e2')], roles: ROLES }, () => false)!], {
      text: 'Send canceled, moved to Trash',
      failed: m.plan_cancel_failed(),
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(edits.edit('k1', 'e2', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({
      text: m.plan_cancel_failed(),
      error: true,
    });
  });

  it('"Send now": first cancel, then resubmit; too late or failed means no second sending', async () => {
    const reopen = vi.fn();
    const { api } = fakeApi();
    const p = new PlanActions(api);
    const before = stamp();
    await p.sendNow({ ...planned('e1'), account: 'k1' }, ROLES, reopen);
    // Draft again before resubmitting; `resend` then remembers it as sent.
    expect(unsent).toHaveBeenCalledExactlyOnceWith('k1', ['e1']);
    expect(resend).toHaveBeenCalledExactlyOnceWith('k1', 'e1', { identityId: 'i1', envelope: null }, reopen);
    expect(edits.edit('k1', 'e1', before)).toEqual({
      mailboxIds: { sch: false, se: true },
      keywords: { $scheduled: false },
    });

    resend.mockClear();
    await new PlanActions(fakeApi({ late: new Map([['e2', FINAL]]) }).api).sendNow(
      { ...planned('e2'), account: 'k1' },
      ROLES,
      reopen,
    );
    expect(resend).not.toHaveBeenCalled();
    expect(ui.toast).toMatchObject({ text: 'The message has already been sent.', error: true });
    // Sent: stays locked.
    expect(unsent).toHaveBeenLastCalledWith('k1', []);

    await new PlanActions(fakeApi({ failed: ['e3'] }).api).sendNow({ ...planned('e3'), account: 'k1' }, ROLES, reopen);
    expect(resend).not.toHaveBeenCalled();
    expect(edits.edit('k1', 'e3', 0)).toBeUndefined();
    expect(ui.toast).toMatchObject({
      text: m.compose_send_failed(),
      error: true,
    });
    expect(reopen).not.toHaveBeenCalled();
  });

  it('back to "Drafts" without an accepted recipient: compose opens it again', async () => {
    const none = late('final', {
      deliveryStatus: { 'b@x.example': { delivered: 'no', smtpReply: '', displayed: 'unknown' } },
    });
    const p = new PlanActions(fakeApi({ late: new Map([['e1', [none]]]) }).api);
    expect(await p.cancel([{ account: 'k1', emails: [planned('e1')], roles: ROLES }])).toEqual([
      { account: 'k1', id: 'e1' },
    ]);
    expect(unsent).toHaveBeenCalledExactlyOnceWith('k1', ['e1']);
  });

  it('"Send now": if only the submission fails, the draft in "Drafts" counts', async () => {
    resend.mockResolvedValueOnce(false);
    const p = new PlanActions(fakeApi().api);
    const before = stamp();
    await p.sendNow({ ...planned('e1'), account: 'k1' }, ROLES, vi.fn());
    expect(edits.edit('k1', 'e1', before)).toEqual({
      mailboxIds: { sch: false, dr: true },
      keywords: { $scheduled: false, $draft: true },
    });
  });
});
