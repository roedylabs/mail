import { JmapClient, JmapError, type EmailBodyPart, type Identity, type SetError } from '@roedy/jmap';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { NetworkError } from '#lib/api.ts';
import type { EditLog, QueuedDraft } from '#lib/mail-queue.ts';
import type { SavedMail } from '#lib/mail-store.ts';
import type { MessageEmail } from '#lib/state/message.svelte.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import {
  AUTOSAVE_MS,
  bodyOf,
  cannotUnsend,
  Compose,
  ComposeError,
  draftRef,
  holdRefused,
  jmapComposeApi,
  OFFLINE_SAVE_MS,
  parseDraftRef,
  parseMailto,
  parseRecipients,
  replyInit,
  splitSignature,
  storedDraft,
  type ComposeApi,
  type DraftEmail,
  type Folders,
  type LoadedDraft,
  type SendResult,
  type StoredDraft,
  type Submission,
} from '#lib/state/compose.svelte.ts';
import { contacts, mergeContacts } from '#lib/state/contacts.svelte.ts';
import { DRAFT_PAUSE_MS, EditQueue, unanswered, type ReplayedDraft } from '#lib/state/edit-queue.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import type { ReplyContext } from '#lib/reply.ts';
import { m } from '#lib/paraglide/messages.js';

const TIME = { tz: 'Europe/Berlin', timeFmt: '24h' } as const;

// Sending remembers recipients in the global `contacts`; no test inherits them from the previous one.
afterEach(() => contacts.reset());
const NOW = Date.UTC(2026, 10, 1, 9, 0); // 10:00 in Berlin

function account(id: string, overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id,
    email: `${id}@example.com`,
    username: `${id}@example.com`,
    url: 'https://mail.example.com',
    host: 'mail.example.com',
    server_id: 's1',
    auth_kind: 'oauth',
    color: 0,
    state: 'ok',
    blocked: false,
    quota_used: null,
    quota_total: null,
    last_check_at: null,
    created_at: '2026-10-27T10:00:00Z',
    ...overrides,
  };
}

function identity(id: string, email: string, overrides: Partial<Identity> = {}): Identity {
  return {
    id,
    name: '',
    email,
    replyTo: null,
    bcc: null,
    textSignature: '',
    htmlSignature: '',
    mayDelete: true,
    ...overrides,
  };
}

const IDS: Record<string, Identity[]> = {
  k1: [
    identity('i2', 'alias@example.com', { name: 'Alias' }),
    identity('i1', 'k1@example.com', { name: 'Anna Becker', textSignature: 'Best regards\nAnna' }),
  ],
  k2: [],
};

/** Fake API: remembers calls, assigns ids d1, d2, … */
function fakeApi(overrides: Partial<ComposeApi> = {}) {
  let n = 0;
  const saves: { account: string; email: DraftEmail; replace: string | null; keepalive: boolean }[] = [];
  const replays: { account: string; email: DraftEmail; replace: string | null }[] = [];
  const destroyed: [string, string][] = [];
  const sends: { account: string; email: DraftEmail; replace: string | null; sub: Submission; keepalive: boolean }[] =
    [];
  const submits: { account: string; email: string; sub: Submission; keepalive: boolean }[] = [];
  const unsent: [string, string, string][] = [];
  const restored: [string, string][] = [];
  const uploads: Upload[] = [];
  const downloads: [string, string | null][] = [];
  const api: ComposeApi = {
    identities: (a) => Promise.resolve(IDS[a] ?? []),
    load: () => Promise.resolve(null),
    save: (account, email, replace, keepalive) => {
      saves.push({ account, email, replace, keepalive });
      return Promise.resolve(`d${++n}`);
    },
    saveQueued: (account, email, replace) => {
      replays.push({ account, email, replace });
      return Promise.resolve({ id: `d${++n}`, conflict: false });
    },
    destroy: (account, id) => {
      destroyed.push([account, id]);
      return Promise.resolve();
    },
    send: (account, email, replace, sub, keepalive) => {
      sends.push({ account, email, replace, sub, keepalive });
      return Promise.resolve({ ok: true, email: `d${++n}`, submission: `s${sends.length}`, rejected: false });
    },
    submit: (account, email, sub, keepalive) => {
      submits.push({ account, email, sub, keepalive });
      return Promise.resolve({ ok: true, email, submission: 'sx', rejected: false });
    },
    unsend: (account, submission, email) => {
      unsent.push([account, submission, email]);
      return Promise.resolve(true);
    },
    restore: (account, email) => {
      restored.push([account, email]);
      return Promise.resolve();
    },
    limits: () => Promise.resolve({ file: 2 * MB, email: 4 * MB }),
    maxDelay: () => Promise.resolve(2_592_000),
    upload: (account, data, type, signal) =>
      new Promise((resolve, reject) => {
        uploads.push({
          account,
          data,
          type,
          signal,
          done: (blobId) => resolve({ blobId, size: data.size }),
          fail: reject,
        });
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }),
    download: (account, part) => {
      downloads.push([account, part.blobId]);
      return Promise.resolve(new Blob(['content']));
    },
    ...overrides,
  };
  return { api, saves, replays, destroyed, sends, submits, unsent, restored, uploads, downloads };
}

const MB = 1024 * 1024;

/** Upload that a test finishes (`done`) or lets fail (`fail`). */
interface Upload {
  account: string;
  data: Blob;
  type: string;
  signal: AbortSignal;
  done: (blobId: string) => void;
  fail: (error: unknown) => void;
}

/** Attaches files and lets the uploads start. */
async function add(c: Compose, files: File[]) {
  await c.addFiles(files);
  await vi.advanceTimersByTimeAsync(0);
}

/** File with a given size, without creating it. */
function file(name: string, size = 3000, type = ''): File {
  const f = new File(['x'], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
}

const nav = () => ({ leave: vi.fn(), reopen: vi.fn() });

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe('Compose helpers', () => {
  it('reads recipients with and without names, separated by comma, semicolon or line', () => {
    expect(parseRecipients('Anna Becker <anna@example.com>; "Ben" <ben@example.com>,\nc@example.com ,')).toEqual([
      { name: 'Anna Becker', email: 'anna@example.com' },
      { name: 'Ben', email: 'ben@example.com' },
      { name: '', email: 'c@example.com' },
    ]);
  });

  it('does not split inside quotes or angle brackets', () => {
    expect(parseRecipients('"Doe, Jane" <jane@example.com>; <a,b@example.com>')).toEqual([
      { name: 'Doe, Jane', email: 'jane@example.com' },
      { name: '', email: 'a,b@example.com' },
    ]);
  });

  it('reads mailto: links according to RFC 6068', () => {
    expect(
      parseMailto(
        'mailto:a@example.com,b%40example.com?cc=c@example.com&subject=Gr%C3%BC%C3%9Fe%20&body=Line%0D%0Atwo&x=1',
      ),
    ).toEqual({
      to: [
        { name: '', email: 'a@example.com' },
        { name: '', email: 'b@example.com' },
      ],
      cc: [{ name: '', email: 'c@example.com' }],
      bcc: [],
      subject: 'Gr\u00fc\u00dfe ',
      text: 'Line\ntwo',
    });
    expect(parseMailto('MAILTO:?to=a+b@example.com')?.to).toEqual([{ name: '', email: 'a+b@example.com' }]);
    expect(parseMailto('https://example.com')).toBeNull();
  });

  it('appends the signature after "-- " and splits it off again on opening', () => {
    const body = bodyOf('Hello\n\n', 'Regards\nAnna');
    expect(body).toBe('Hello\n\n-- \nRegards\nAnna');
    expect(splitSignature(body, 'Regards\nAnna')).toEqual({ text: 'Hello', signed: true });
    expect(splitSignature('Hello\n--\nRegards\nAnna\n', 'Regards\nAnna')).toEqual({ text: 'Hello', signed: true });
    expect(splitSignature('Hello', 'Regards\nAnna')).toEqual({ text: 'Hello', signed: false });
    expect(bodyOf('Hello', '')).toBe('Hello');
  });

  it('encodes the draft in the route parameter with its account', () => {
    expect(draftRef(null)).toBe('new');
    expect(draftRef({ account: 'k1', id: 'Mx1' })).toBe('k1/Mx1');
    expect(parseDraftRef('new')).toBeNull();
    expect(parseDraftRef('k1/Mx1')).toEqual({ account: 'k1', id: 'Mx1' });
    expect(parseDraftRef('k1')).toBeUndefined();
    expect(parseDraftRef('k1/')).toBeUndefined();
  });
});

describe('Compose', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    accounts.list = [account('k1'), account('k2', { color: 3 })];
    prefs.values.defaultAccount = 'k1';
  });
  afterEach(() => {
    accounts.list = null;
    prefs.reset();
    ui.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('only the notice without a mail account', () => {
    accounts.list = [];
    const c = new Compose(fakeApi().api);
    expect(c.start()).toBe(false);
    expect(c.current).toBeNull();
    expect(ui.toast?.text).toBe('Connect an email account first');
  });

  it('opens "New email" with the identity of the account, signature and all senders', async () => {
    const c = new Compose(fakeApi().api);
    c.start({}, { href: '/mailbox/k1/inbox', label: 'Inbox' });
    await settle();
    const v = c.values(TIME);
    expect(v).toMatchObject({
      title: 'New email',
      backLabel: 'Inbox',
      discardLabel: 'Discard',
      hasStatus: false,
      subj: '',
      taAuto: false,
      ph: 'Write a message …',
      sig: 'Best regards\nAnna',
      sigShow: true,
      sigAdd: false,
      anyMenu: false,
    });
    expect(v?.from).toMatchObject({
      name: 'Anna Becker',
      email: 'k1@example.com',
      letter: 'AB',
      multi: true,
      stale: false,
    });
    expect(v?.from.opts.map((o) => [o.key, o.name, o.on])).toEqual([
      ['k1/i1', 'Anna Becker', true],
      ['k1/i2', 'Alias', false],
      ['k2/', 'k2@example.com', false],
    ]);
    expect(v?.fields.map((f) => [f.key, f.label, f.ph, f.auto, f.showToggle])).toEqual([
      ['to', 'To', 'Name or email address', true, true],
    ]);
    expect(c.ref).toBe('new');
  });

  it('takes the account of the view, otherwise the default account; without a target back to its inbox', async () => {
    const c = new Compose(fakeApi().api);
    c.start({ account: 'k2' });
    await settle();
    expect(c.values(TIME)?.from).toMatchObject({ email: 'k2@example.com', letter: 'K' });
    expect(c.values(TIME)?.backLabel).toBe('Inbox');
    c.start({ account: 'gone' });
    expect(c.current?.account).toBe('k1');
    const n = nav();
    await c.close(n);
    expect(n.leave).toHaveBeenCalledWith({ href: '/mailbox/k1/inbox', label: 'Inbox' });
  });

  it('saves 1.5 s after the last change and then replaces the previous draft', async () => {
    const { api, saves } = fakeApi();
    const c = new Compose(api);
    c.start();
    await settle();
    c.input('to', 'Ben <ben@example.com>, ');
    c.setSubject('Hello');
    vi.advanceTimersByTime(AUTOSAVE_MS - 1);
    expect(saves).toHaveLength(0);
    expect(c.values(TIME)).toMatchObject({ status: 'Saving …', statusIcon: 'ti-cloud-upload' });
    c.setText('Text\n');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves).toEqual([
      {
        account: 'k1',
        replace: null,
        keepalive: false,
        email: {
          from: { name: 'Anna Becker', email: 'k1@example.com' },
          to: [{ name: 'Ben', email: 'ben@example.com' }],
          cc: [],
          bcc: [],
          subject: 'Hello',
          text: 'Text\n\n-- \nBest regards\nAnna',
          attachments: [],
          inReplyTo: null,
          references: null,
          keywords: {},
          mailboxIds: [],
          messageId: expect.stringMatching(/@roedy\.invalid$/) as string,
        },
      },
    ]);
    expect(c.ref).toBe('k1/d1');
    expect(c.values(TIME)).toMatchObject({
      status: 'Saved at 10:00',
      statusIcon: 'ti-cloud-check',
      discardLabel: 'Delete draft',
      title: 'New email',
    });
    c.toggleSig();
    c.input('cc', 'x@example.com');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[1]).toMatchObject({
      replace: 'd1',
      email: { text: 'Text', cc: [{ name: null, email: 'x@example.com' }] },
    });
    expect(c.values(TIME)).toMatchObject({ sigShow: false, sigAdd: true });
  });

  it('does not save without content; changes during saving stay marked unsaved', async () => {
    let release: (id: string) => void = () => {};
    const { api, saves } = fakeApi({
      save: (account, email, replace) => {
        saves.push({ account, email, replace, keepalive: false });
        return new Promise((resolve) => (release = resolve));
      },
    });
    const c = new Compose(api);
    c.start();
    c.setText('  ');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves).toHaveLength(0);
    c.setText('a');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves).toHaveLength(1);
    c.setText('ab');
    release('d1');
    await settle();
    expect(c.current).toMatchObject({ saved: { account: 'k1', id: 'd1' }, dirty: true });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[1]).toMatchObject({ replace: 'd1', email: { text: 'ab\n\n-- \nBest regards\nAnna' } });
  });

  it('turns inputs into chips, marks invalid addresses and removes with backspace', () => {
    const c = new Compose(fakeApi().api);
    c.start();
    c.input('to', 'anna@example.com; broken');
    expect(c.current?.to).toEqual([{ name: '', email: 'anna@example.com' }]);
    expect(c.current?.input.to).toBe('broken');
    c.commit('to');
    c.input('to', 'ANNA@example.com,');
    const chips = c.values(TIME)?.fields[0]?.chips;
    expect(chips?.map((x) => [x.label, x.letter, x.bad, x.rmLabel])).toEqual([
      ['anna@example.com', 'A', false, 'Remove anna@example.com'],
      ['broken', '!', true, 'Remove broken'],
    ]);
    expect(c.values(TIME)?.taAuto).toBe(true);
    c.removeLast('to');
    expect(c.current?.to).toHaveLength(1);
    c.input('to', 'x');
    c.removeLast('to');
    expect(c.current?.to).toHaveLength(1);
    c.blur('to');
    expect(c.current?.to.map((r) => r.email)).toEqual(['anna@example.com', 'x']);
    c.remove('to', 0);
    expect(c.current?.to.map((r) => r.email)).toEqual(['x']);
  });

  it('shows Cc and Bcc after "Cc/Bcc" and toggles the "Send as" menu', () => {
    const c = new Compose(fakeApi().api);
    c.start();
    c.showCc();
    expect(c.values(TIME)?.fields.map((f) => [f.key, f.showToggle])).toEqual([
      ['to', false],
      ['cc', false],
      ['bcc', false],
    ]);
    expect(c.current?.dirty).toBe(false);
    c.toggleFrom();
    expect(c.values(TIME)).toMatchObject({ anyMenu: true, from: { open: true } });
    c.closeMenu();
    expect(c.values(TIME)?.from.open).toBe(false);
  });

  it('saves there after a switch of the account and deletes the draft in the previous one', async () => {
    const { api, saves, destroyed } = fakeApi();
    const c = new Compose(api);
    c.start();
    await settle();
    c.setText('Hello');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    c.toggleFrom();
    c.pickFrom('k2/');
    expect(c.values(TIME)?.from).toMatchObject({ email: 'k2@example.com', open: false });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[1]).toMatchObject({ account: 'k2', replace: null, email: { from: { email: 'k2@example.com' } } });
    expect(destroyed).toEqual([['k1', 'd1']]);
    expect(c.ref).toBe('k2/d2');
  });

  it('reports an account with "sign-in required"', async () => {
    accounts.list = [account('k1', { state: 'needs_reauth' })];
    const c = new Compose(fakeApi({ identities: () => Promise.reject(new Error('needs_reauth')) }).api);
    c.start();
    await settle();
    expect(c.values(TIME)?.from).toMatchObject({ email: 'k1@example.com', stale: true, multi: false });
  });

  it('loads identities for the account switch without compose and retries failed ones', async () => {
    let fail = true;
    const calls: string[] = [];
    const c = new Compose(
      fakeApi({
        identities: (a) => {
          calls.push(a);
          return a === 'k2' && fail ? Promise.reject(new Error('unreachable')) : Promise.resolve(IDS[a] ?? []);
        },
      }).api,
    );
    expect(c.identitiesOf('k1')).toBeNull();
    c.loadIdentities(['k1', 'k2']);
    expect(c.identitiesOf('k1')).toBeNull();
    await settle();
    expect(c.identitiesOf('k1')).toEqual(IDS.k1);
    expect(c.identitiesOf('k2')).toBeNull();
    // Loaded ones are not fetched again, a failed one on the next call.
    fail = false;
    c.loadIdentities(['k1', 'k2']);
    await settle();
    expect(calls).toEqual(['k1', 'k2', 'k2']);
    expect(c.identitiesOf('k2')).toEqual([]);
    // A change in Mail account › Identities reaches the account switch.
    c.identitiesChanged('k1', [identity('i1', 'k1@example.com', { name: 'Anna B.' })]);
    expect(c.identitiesOf('k1')?.[0]?.name).toBe('Anna B.');
  });

  it('takes over identities from Mail account › Identities; an older fetch does not overwrite them', async () => {
    let resolve: (list: Identity[]) => void = () => {};
    const c = new Compose(
      fakeApi({
        identities: (a) => (a === 'k1' ? new Promise<Identity[]>((r) => (resolve = r)) : Promise.resolve([])),
      }).api,
    );
    c.start();
    c.identitiesChanged('k1', [identity('i1', 'k1@example.com', { name: 'Anna B.' })]);
    resolve(IDS.k1!);
    await settle();
    expect(c.values(TIME)?.from).toMatchObject({ email: 'k1@example.com', name: 'Anna B.' });
  });

  it('close saves, returns and reports "Saved as draft"', async () => {
    const { api, saves } = fakeApi();
    const c = new Compose(api);
    c.start({}, { href: '/mailbox/k1/f/x', label: 'Projects' });
    c.setSubject('Subject');
    const n = nav();
    await c.close(n);
    expect(saves).toHaveLength(1);
    expect(n.leave).toHaveBeenCalledWith({ href: '/mailbox/k1/f/x', label: 'Projects' });
    expect(c.current).toBeNull();
    expect(ui.toast?.text).toBe('Saved as draft');
  });

  it('close without content goes without a notice; an emptied draft is deleted', async () => {
    const { api, saves, destroyed } = fakeApi();
    const c = new Compose(api);
    c.start();
    const n = nav();
    await c.close(n);
    expect(n.leave).toHaveBeenCalled();
    expect(saves).toHaveLength(0);
    expect(ui.toast).toBeNull();

    c.start();
    c.setText('x');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    c.setText('');
    await c.close(nav());
    await settle();
    expect(destroyed).toEqual([['k1', 'd1']]);
    expect(ui.toast).toBeNull();
  });

  it('stays open if saving fails on close', async () => {
    const c = new Compose(fakeApi({ save: () => Promise.reject(new TypeError('Failed to fetch')) }).api);
    c.start();
    c.setText('Important');
    const n = nav();
    await c.close(n);
    expect(n.leave).not.toHaveBeenCalled();
    expect(c.current?.text).toBe('Important');
    expect(ui.toast).toMatchObject({ error: true });
    expect(c.values(TIME)?.hasStatus).toBe(false);
  });

  it('reports a rejected autosave once per series of failures', async () => {
    const { api, saves } = fakeApi();
    const save = api.save.bind(api);
    let fail = true;
    api.save = (...a) => (fail ? Promise.reject(new ComposeError('Email/set', [{ type: 'overQuota' }])) : save(...a));
    const c = new Compose(api);
    c.start();
    c.setText('One');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    const pref = { text: 'Change not saved. Please try again.', error: true };
    expect(ui.toast).toMatchObject(pref);
    expect(c.values(TIME)?.hasStatus).toBe(false);
    ui.reset();
    // The next change tries again, without another toast.
    c.setText('Two');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(ui.toast).toBeNull();
    fail = false;
    c.setText('Three');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves).toHaveLength(1);
    expect(c.values(TIME)?.hasStatus).toBe(true);
    // After a successful save the next failure reports itself again.
    fail = true;
    c.setText('Vier');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(ui.toast).toMatchObject(pref);
  });

  it('discard deletes the draft only after the toast; undo opens it again', async () => {
    const { api, destroyed } = fakeApi();
    const c = new Compose(api);
    c.start();
    c.setText('Hello');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    const n = nav();
    c.discard(n);
    expect(n.leave).toHaveBeenCalled();
    expect(c.current).toBeNull();
    expect(ui.toast).toMatchObject({ text: 'Draft deleted', undo: true });
    ui.toasts.undo();
    expect(n.reopen).toHaveBeenCalled();
    expect(c.current).toMatchObject({ text: 'Hello', saved: { id: 'd1' } });
    expect(destroyed).toEqual([]);

    c.discard(n);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(destroyed).toEqual([['k1', 'd1']]);
  });

  it('discarding an unsaved email says "Draft discarded", without content nothing', async () => {
    const { api, saves, destroyed } = fakeApi();
    const c = new Compose(api);
    c.start();
    c.setText('Hello');
    c.discard(nav());
    expect(ui.toast?.text).toBe('Draft discarded');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(saves).toHaveLength(0);
    expect(destroyed).toEqual([]);
    ui.reset();
    c.start();
    c.discard(nav());
    expect(ui.toast).toBeNull();
  });

  it('leaving without closing saves with a notice; a new compose saves the old one silently', async () => {
    const { api, saves } = fakeApi();
    const c = new Compose(api);
    c.start();
    c.setText('one');
    c.park();
    await settle();
    expect(saves).toHaveLength(1);
    expect(ui.toast?.text).toBe('Saved as draft');
    ui.reset();
    c.start();
    c.setText('two');
    c.start();
    await settle();
    expect(saves).toHaveLength(2);
    expect(ui.toast).toBeNull();
    expect(c.current?.text).toBe('');
  });

  it('sends unsaved changes with keepalive when leaving the page', async () => {
    const { api, saves } = fakeApi();
    const c = new Compose(api);
    c.start();
    c.flush();
    c.setText('x');
    c.flush();
    await settle();
    expect(saves.map((s) => s.keepalive)).toEqual([true]);
  });

  it('prefills from mailto: and saves that as a change', async () => {
    const { api, saves } = fakeApi();
    const c = new Compose(api);
    c.start(parseMailto('mailto:a@example.com?bcc=b@example.com&subject=Hello') ?? {});
    expect(c.values(TIME)?.fields.map((f) => f.key)).toEqual(['to', 'cc', 'bcc']);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[0]?.email).toMatchObject({ subject: 'Hello', bcc: [{ name: null, email: 'b@example.com' }] });
  });

  it('opens a saved draft with identity, without the signature in the text, and keeps attachments', async () => {
    const loaded: LoadedDraft = {
      from: { name: 'Alias', email: 'ALIAS@example.com' },
      to: [{ name: 'Ben', email: 'ben@example.com' }],
      cc: [],
      bcc: [{ name: '', email: 'c@example.com' }],
      subject: 'Plan',
      text: 'Hello Ben',
      receivedAt: NOW - 60_000,
      attachments: [
        {
          partId: '2',
          blobId: 'b1',
          size: 10,
          headers: [],
          name: 'a.pdf',
          type: 'application/pdf',
          charset: null,
          disposition: 'attachment',
          cid: null,
          language: null,
          location: null,
          subParts: null,
        },
      ],
      inReplyTo: ['<x@example.com>'],
      references: null,
      keywords: { $flagged: true },
      mailboxIds: ['dr', 'tag1'],
    };
    const { api, saves, uploads } = fakeApi({ load: () => Promise.resolve(loaded) });
    const c = new Compose(api);
    expect(await c.openDraft('k1', 'm7', { href: '/mailbox/k1/drafts', label: 'Drafts' })).toBe(true);
    expect(c.ref).toBe('k1/m7');
    expect(c.values(TIME)).toMatchObject({
      title: 'Draft',
      backLabel: 'Drafts',
      discardLabel: 'Delete draft',
      status: 'Saved at 09:59',
      subj: 'Plan',
      text: 'Hello Ben',
      sigShow: false,
      sigAdd: false,
      from: { name: 'Alias', email: 'alias@example.com' },
    });
    expect(c.values(TIME)?.fields.map((f) => f.key)).toEqual(['to', 'cc', 'bcc']);
    expect(await c.openDraft('k1', 'm7')).toBe(true);
    expect(c.values(TIME)?.backLabel).toBe('Drafts');
    expect(await c.openDraft('k1', 'm7', { href: '/mailbox/k1/t/tag1', label: 'Project' })).toBe(true);
    expect(c.values(TIME)?.backLabel).toBe('Project');
    c.setText('Hello Ben!');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[0]).toMatchObject({
      replace: 'm7',
      email: {
        from: { name: 'Alias' },
        attachments: [{ blobId: 'b1' }],
        inReplyTo: ['<x@example.com>'],
        keywords: { $flagged: true },
        mailboxIds: ['dr', 'tag1'],
      },
    });
    // In another account the mailboxes (tags) do not apply, the star does.
    c.pickFrom('k2/');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    // Only when the attachment lies in the new account does the draft move.
    expect(saves).toHaveLength(1);
    uploads[0]?.done('B9');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[1]).toMatchObject({
      account: 'k2',
      email: { keywords: { $flagged: true }, mailboxIds: [], attachments: [{ blobId: 'B9' }] },
    });
  });

  it('splits off the identity\'s signature on opening; if it is missing, "Insert signature" stays', async () => {
    const draft = (text: string): LoadedDraft => ({
      from: { name: 'Anna Becker', email: 'k1@example.com' },
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      text,
      receivedAt: NOW,
      attachments: [],
      inReplyTo: null,
      references: null,
      keywords: {},
      mailboxIds: [],
    });
    let next = draft('Hello\n\n-- \nBest regards\nAnna');
    const c = new Compose(fakeApi({ load: () => Promise.resolve(next) }).api);
    await c.openDraft('k1', 'a');
    expect(c.values(TIME)).toMatchObject({ text: 'Hello', sigShow: true });
    next = draft('Hello');
    await c.openDraft('k1', 'b');
    expect(c.values(TIME)).toMatchObject({ text: 'Hello', sigShow: false, sigAdd: true });
  });

  it('reports a missing draft and an error while loading', async () => {
    const c = new Compose(fakeApi().api);
    expect(await c.openDraft('k1', 'gone')).toBe(false);
    expect(ui.toast).toMatchObject({ error: true });
    expect(c.current).toBeNull();
    const d = new Compose(fakeApi({ load: () => Promise.reject(new TypeError('Failed to fetch')) }).api);
    expect(await d.openDraft('k1', 'x')).toBe(false);
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
  });
});

describe('Compose: edge cases from the review', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    accounts.list = [account('k1')];
  });
  afterEach(() => {
    accounts.list = null;
    ui.reset();
    vi.useRealTimers();
  });

  it('takes over names with a comma while typing only after the closing quote', () => {
    const c = new Compose(fakeApi().api);
    c.start();
    c.input('to', '"Doe, Jane');
    expect(c.current?.to).toEqual([]);
    c.input('to', '"Doe, Jane" <jane@example.com>, ');
    expect(c.current?.to).toEqual([{ name: 'Doe, Jane', email: 'jane@example.com' }]);
  });

  it('close also saves what was typed during saving', async () => {
    let release: (id: string) => void = () => {};
    const { api, saves } = fakeApi();
    const save = api.save.bind(api);
    api.save = (...a) =>
      saves.length === 0
        ? new Promise(
            (r) => (saves.push({ account: a[0], email: a[1], replace: a[2], keepalive: a[3] }), (release = r)),
          )
        : save(...a);
    const c = new Compose(api);
    c.start();
    c.setText('one');
    const n = nav();
    const closing = c.close(n);
    await settle();
    c.setText('one two');
    release('d1');
    await closing;
    expect(saves.map((x) => x.email.text.split('\n')[0])).toEqual(['one', 'one two']);
    expect(n.leave).toHaveBeenCalled();
  });

  it('if deleting after discarding fails, the view stays', async () => {
    const { api } = fakeApi({ destroy: () => Promise.reject(new Error('500')) });
    const c = new Compose(api);
    c.start();
    c.setText('x');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    const error = vi.spyOn(ui.toasts, 'error');
    const n = nav();
    c.discard(n);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(n.reopen).not.toHaveBeenCalled();
    expect(c.current).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it('loses nothing on leaving: new attempt, can be reopened via the address', async () => {
    let fail = true;
    const { api, saves } = fakeApi();
    const save = api.save.bind(api);
    api.save = (...a) => (fail ? Promise.reject(new TypeError('Failed to fetch')) : save(...a));
    const c = new Compose(api);
    c.start();
    c.setText('lang');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    fail = false;
    c.setText('lang!');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(c.ref).toBe('k1/d1');
    fail = true;
    c.setText('lang!!');
    c.park();
    await settle();
    expect(ui.toast).toMatchObject({ error: true });
    expect(await c.openDraft('k1', 'd1')).toBe(true);
    expect(c.current?.text).toBe('lang!!');
    c.park();
    await settle();
    expect(saves).toHaveLength(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(saves).toHaveLength(2);
    expect(saves[1]?.replace).toBe('d1');
    expect(saves[1]?.email.text).toMatch(/^lang!!\n/);
  });

  it('back to an address replaced in the meantime opens the newest state', async () => {
    const loads: string[] = [];
    const { api } = fakeApi({
      load: (_a, id) => {
        loads.push(id);
        return Promise.resolve(null);
      },
    });
    const c = new Compose(api);
    c.start();
    c.setText('a');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    c.setText('ab');
    c.park();
    expect(await c.openDraft('k1', 'd1')).toBe(false);
    expect(loads).toEqual(['d2']);
  });
});

describe('Send', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    accounts.list = [account('k1'), account('k2', { color: 3 })];
    prefs.values.defaultAccount = 'k1';
  });
  afterEach(() => {
    accounts.list = null;
    prefs.reset();
    ui.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** New email to `to` with subject and text, identities loaded. */
  async function ready(api: ComposeApi, to = 'b@example.com') {
    const c = new Compose(api);
    c.start();
    await settle();
    c.input('to', to);
    c.setSubject('Hello');
    c.setText('Text');
    return c;
  }

  it('checks recipients, red addresses and the sign-in before sending', async () => {
    const { api, sends } = fakeApi();
    const c = new Compose(api);
    c.start();
    await settle();
    const n = nav();
    c.send(n);
    expect(ui.toast).toMatchObject({ text: 'Please add at least one recipient', error: false });
    expect(c.values(TIME)?.fields[0]).toMatchObject({ err: true, ph: 'Add a recipient' });

    c.input('to', 'b@example.com, broken');
    expect(c.current?.err).toBeNull();
    c.send(n);
    expect(ui.toast?.text).toBe('Please check the addresses marked in red');
    // Open inputs are chips now, the invalid one red.
    expect(c.current?.input.to).toBe('');
    expect(c.values(TIME)?.fields[0]?.chips.map((x) => x.bad)).toEqual([false, true]);

    c.remove('to', 1);
    accounts.list = [account('k1', { state: 'needs_reauth' })];
    c.send(n);
    expect(ui.toast?.text).toBe('Sign in to k1@example.com again first');
    await settle();
    expect(sends).toEqual([]);
    expect(n.leave).not.toHaveBeenCalled();
    expect(c.current).not.toBeNull();
  });

  it('asks without a subject and sends only after "Send anyway"', async () => {
    const { api, sends } = fakeApi();
    const c = await ready(api);
    c.setSubject('  ');
    c.send(nav());
    expect(ui.confirm).toMatchObject({
      title: 'Send without a subject?',
      text: 'This message has no subject.',
      icon: 'ti-mail-question',
      ok: 'Send anyway',
    });
    await settle();
    expect(sends).toEqual([]);
    ui.confirmOk();
    await settle();
    expect(sends).toHaveLength(1);
  });

  it('submits with HOLDFOR from gUndo plus buffer and shows "Message sent"', async () => {
    prefs.values.gUndo = '10 s';
    const { api, sends } = fakeApi();
    const c = await ready(api);
    c.showCc();
    c.input('cc', '"B" <B@Example.com>');
    c.input('bcc', 'c@example.com');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(c.current?.saved).toEqual({ account: 'k1', id: 'd1' });
    const n = nav();
    c.send(n);
    // Compose closes immediately and returns.
    expect(c.current).toBeNull();
    // Replaces the history entry: "back" does not lead to the sent draft.
    expect(n.leave).toHaveBeenCalledWith({ href: '/mailbox/k1/inbox', label: 'Inbox' }, true);
    await settle();
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      account: 'k1',
      replace: 'd1',
      email: {
        from: { name: 'Anna Becker', email: 'k1@example.com' },
        subject: 'Hello',
        text: 'Text\n\n-- \nBest regards\nAnna',
      },
      sub: { identity: 'i1', mailFrom: 'k1@example.com', rcptTo: ['b@example.com', 'c@example.com'], holdFor: 15 },
      keepalive: true,
    });
    expect(ui.toast).toMatchObject({ text: 'Message sent', undo: true, error: false });
    // Without undo: nothing happens after expiry.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ui.toast).toBeNull();
    expect(c.current).toBeNull();
  });

  it('undo withdraws the submission and opens compose with the draft', async () => {
    const { api, unsent } = fakeApi();
    const c = await ready(api);
    const n = nav();
    c.send(n);
    await settle();
    ui.toasts.undo();
    await settle();
    expect(unsent).toEqual([['k1', 's1', 'd1']]);
    expect(n.reopen).toHaveBeenCalled();
    expect(c.current).toMatchObject({
      subject: 'Hello',
      text: 'Text',
      saved: { account: 'k1', id: 'd1' },
      dirty: false,
    });
    // As before sending, also the input not yet taken over.
    expect(c.current?.input.to).toBe('b@example.com');
  });

  it('reports a withdrawal that is too late; the message stays sent', async () => {
    const { api } = fakeApi({
      unsend: () => Promise.reject(new ComposeError('EmailSubmission/set', [{ type: 'cannotUnsend' }])),
    });
    const c = await ready(api);
    const n = nav();
    c.send(n);
    await settle();
    ui.toasts.undo();
    await settle();
    expect(ui.toast).toMatchObject({ text: 'The message has already been sent.', error: true });
    expect(n.reopen).not.toHaveBeenCalled();
    expect(c.current).toBeNull();
  });

  it('opens compose again if the server rejects the submission or saving fails', async () => {
    const refused = fakeApi({
      send: () => Promise.resolve<SendResult>({ ok: false, email: 'd7', error: { type: 'forbiddenFrom' } }),
    });
    let c = await ready(refused.api);
    let n = nav();
    c.send(n);
    await settle();
    expect(n.reopen).toHaveBeenCalled();
    expect(c.current).toMatchObject({ subject: 'Hello', saved: { account: 'k1', id: 'd7' } });
    expect(ui.toast).toMatchObject({
      text: m.compose_send_failed(),
      error: true,
    });

    const broken = fakeApi({ send: () => Promise.reject(new ComposeError('Email/set', [{ type: 'overQuota' }])) });
    c = await ready(broken.api);
    n = nav();
    c.send(n);
    await settle();
    expect(n.reopen).toHaveBeenCalled();
    expect(c.current).toMatchObject({ subject: 'Hello', saved: null });
    expect(ui.toast?.text).toBe(m.compose_send_failed());
  });

  it('if the server accepts no recipient, the email lies in Drafts again', async () => {
    const { api, restored } = fakeApi({
      send: () => Promise.resolve<SendResult>({ ok: true, email: 'd5', submission: 's5', rejected: true }),
    });
    const c = await ready(api);
    const n = nav();
    c.send(n);
    await settle();
    expect(restored).toEqual([['k1', 'd5']]);
    expect(n.reopen).toHaveBeenCalled();
    expect(c.current?.saved).toEqual({ account: 'k1', id: 'd5' });
    expect(ui.toast).toMatchObject({ error: true, undo: false });
  });

  it('if the server rejects HOLDFOR, it sends without it after the toast expires', async () => {
    const error = {
      type: 'forbiddenMailFrom',
      description: 'Server rejected MAIL-FROM: 501 5.5.4 FUTURERELEASE extension has been disabled.',
    };
    const { api, submits } = fakeApi({
      send: () => Promise.resolve<SendResult>({ ok: false, email: 'd3', error }),
    });
    const c = await ready(api);
    const n = nav();
    c.send(n);
    await settle();
    expect(ui.toast).toMatchObject({ text: 'Message sent', undo: true });
    // Undo sends nothing and opens the draft again.
    ui.toasts.undo();
    expect(n.reopen).toHaveBeenCalled();
    expect(c.current?.saved).toEqual({ account: 'k1', id: 'd3' });
    expect(submits).toEqual([]);

    c.send(n);
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(submits).toEqual([
      { account: 'k1', email: 'd3', sub: expect.objectContaining({ holdFor: null }) as Submission, keepalive: false },
    ]);
  });

  it('after sign-out nothing opens any more', async () => {
    let answer!: (r: SendResult) => void;
    const { api } = fakeApi({ send: () => new Promise((r) => (answer = r)) });
    const c = await ready(api);
    const n = nav();
    c.send(n);
    await settle();
    c.reset();
    answer({ ok: false, email: 'd1', error: { type: 'forbiddenFrom' } });
    await settle();
    expect(n.reopen).not.toHaveBeenCalled();
    expect(c.current).toBeNull();
  });

  it('back to the sent draft opens nothing and leaves the toast in place', async () => {
    const { api } = fakeApi();
    const c = await ready(api);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    c.send(nav());
    await settle();
    expect(await c.openDraft('k1', 'd1')).toBe(false);
    expect(await c.openDraft('k1', 'd2')).toBe(false);
    expect(ui.toast).toMatchObject({ text: 'Message sent', undo: true });
  });

  it('shortens the toast to the rest of HOLDFOR; without time for the withdrawal no undo', async () => {
    const slow = (ms: number) =>
      fakeApi({
        send: () =>
          new Promise((r) => setTimeout(() => r({ ok: true, email: 'd1', submission: 's1', rejected: false }), ms)),
      });
    let c = await ready(slow(4000).api);
    c.send(nav());
    await vi.advanceTimersByTimeAsync(4000);
    expect(ui.toast).toMatchObject({ text: 'Message sent', undo: true });
    // HOLDFOR 10 s: 4 s run time, 2 s for the withdrawal leave 4 s.
    await vi.advanceTimersByTimeAsync(3999);
    expect(ui.toast).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(ui.toast).toBeNull();

    c = await ready(slow(8000).api);
    c.send(nav());
    await vi.advanceTimersByTimeAsync(8000);
    expect(ui.toast).toMatchObject({ text: 'Message sent', undo: false });
  });

  it('if the email still lies in Sent after undo, the next save replaces it', async () => {
    const { api, saves } = fakeApi({ unsend: () => Promise.resolve(false) });
    const c = await ready(api);
    const n = nav();
    c.send(n);
    await settle();
    ui.toasts.undo();
    await settle();
    expect(n.reopen).toHaveBeenCalled();
    expect(c.current).toMatchObject({ saved: { id: 'd1' }, dirty: true });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves.at(-1)).toMatchObject({ replace: 'd1' });
  });

  it('detects rejected HOLDFOR and a withdrawal that is too late', () => {
    expect(holdRefused({ type: 'forbiddenMailFrom', description: '501 5.5.4 Hold time exceeds maximum' })).toBe(true);
    expect(holdRefused({ type: 'forbiddenMailFrom', description: '550 5.7.1 Sender not allowed' })).toBe(false);
    expect(
      holdRefused({ type: 'forbiddenMailFrom', description: '552 5.3.4 Message size exceeds maximum permitted' }),
    ).toBe(false);
    expect(holdRefused({ type: 'forbiddenFrom', description: 'FUTURERELEASE' })).toBe(false);
    expect(cannotUnsend(new ComposeError('x', [{ type: 'cannotUnsend' }]))).toBe(true);
    expect(cannotUnsend(new Error('cannotUnsend'))).toBe(false);
  });
});

describe('Send later', () => {
  // NOW is Sunday, 1 Nov 2026, 10:00 in Berlin: no preset "Monday morning".
  const BERLIN = { ...TIME, now: NOW, device: 'Europe/Berlin' };
  const MON_8 = Date.UTC(2026, 10, 2, 7, 0);
  const refused = (description: string): SendResult => ({
    ok: false,
    email: 'd1',
    error: { type: 'forbiddenMailFrom', description: `Server rejected MAIL-FROM: 501 5.5.4 ${description}` },
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    accounts.list = [account('k1'), account('k2', { color: 3 })];
    prefs.values.defaultAccount = 'k1';
    prefs.values.tz = 'Europe/Berlin';
    prefs.values.tzAuto = false;
  });
  afterEach(() => {
    accounts.list = null;
    prefs.reset();
    ui.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function ready(api: ComposeApi, subject = 'Hello') {
    const c = new Compose(api);
    c.start();
    await settle();
    c.input('to', 'b@example.com');
    c.setSubject(subject);
    c.setText('Text');
    return c;
  }

  it('shows presets, field and limit in the time zone from language & region', async () => {
    const c = await ready(fakeApi().api);
    expect(c.values(BERLIN)?.later).toMatchObject({ open: false, dis: false, tip: '' });
    c.toggleLater();
    expect(c.values(BERLIN)?.anyMenu).toBe(true);
    expect(c.values(BERLIN)?.later).toEqual({
      open: true,
      dis: false,
      tip: '',
      opts: [
        { key: 'morning', label: 'Tomorrow morning', icon: 'ti-sunrise', sub: 'Tomorrow, 08:00', dis: false },
        { key: 'afternoon', label: 'Tomorrow afternoon', icon: 'ti-sun', sub: 'Tomorrow, 13:00', dis: false },
      ],
      val: '',
      min: '2026-11-01T10:01',
      max: '2026-11-08T10:00',
      hasHint: false,
      hintText: '',
      invalid: false,
      showLimit: true,
      limitText: 'Up to 7 days ahead',
      tzShow: false,
      tzText: 'Time zone: Berlin, Vienna, Zurich (CET)',
      btnDis: true,
    });
    // Different time zone: times in Tokyo, plus the row with its name.
    const tokyo = c.values({ ...BERLIN, tz: 'Asia/Tokyo' })?.later;
    expect(tokyo).toMatchObject({ min: '2026-11-01T18:01', tzShow: true, tzText: 'Time zone: Tokyo, Seoul (GMT+9)' });
    c.toggleLater();
    expect(c.values(BERLIN)?.later.open).toBe(false);
  });

  it('checks the field: in the future and at most up to the limit', async () => {
    const c = await ready(fakeApi().api);
    c.toggleLater();
    c.setLater('2026-11-01T10:00');
    expect(c.values(BERLIN)?.later).toMatchObject({
      hasHint: true,
      hintText: 'Please choose a time in the future.',
      invalid: true,
      showLimit: false,
      btnDis: true,
    });
    expect(c.plan(nav())).toBe(false);
    c.setLater('2026-11-09T09:00');
    expect(c.values(BERLIN)?.later.hintText).toBe('Please choose a time no more than 7 days ahead.');
    expect(c.plan(nav())).toBe(false);
    c.setLater('2026-11-03T09:30');
    expect(c.values(BERLIN)?.later).toMatchObject({ hasHint: false, showLimit: true, btnDis: false });
  });

  it('takes the limit of the account from "Send as": smaller disables presets, 0 the button', async () => {
    const { api } = fakeApi({ maxDelay: (a) => Promise.resolve(a === 'k2' ? 0 : 86_400) });
    IDS['k2'] = [identity('i3', 'k2@example.com')];
    try {
      const c = await ready(api);
      c.toggleLater();
      const later = c.values(BERLIN)?.later;
      expect(later?.limitText).toBe('Up to 1 day ahead');
      expect(later?.max).toBe('2026-11-02T10:00');
      expect(later?.opts.map((o) => [o.key, o.sub, o.dis])).toEqual([
        ['morning', 'Tomorrow, 08:00', false],
        ['afternoon', 'More than 1 day ahead', true],
      ]);
      expect(c.plan(nav(), 'afternoon')).toBe(false);
      // Account without scheduled sending: button disabled, no popover, a toast on mobile.
      c.pickFrom(c.values(BERLIN)?.from.opts.find((o) => o.email === 'k2@example.com')?.key ?? '');
      await settle();
      expect(c.values(BERLIN)?.later).toMatchObject({
        open: false,
        dis: true,
        tip: m.compose_plan_none(),
      });
      c.toggleLater();
      expect(c.current?.menu).toBeNull();
      expect(ui.toast).toBeNull();
      c.toggleLater(true);
      expect(ui.toast?.text).toBe(m.compose_plan_none());
      expect(c.plan(nav(), 'morning')).toBe(false);
    } finally {
      IDS['k2'] = [];
    }
  });

  it('names the reason if the time has expired since rendering (review)', async () => {
    const { api, sends } = fakeApi();
    const c = await ready(api);
    c.toggleLater();
    c.setLater('2026-11-01T10:03');
    expect(c.values(BERLIN)?.later.btnDis).toBe(false);
    // Three minutes later the time is past; "Schedule" says why instead of silently doing nothing.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(c.plan(nav())).toBe(false);
    expect(c.current?.laterErr).toBe('Please choose a time in the future.');
    expect(c.values({ ...BERLIN, now: Date.now() })?.later).toMatchObject({ hasHint: true, btnDis: true });
    expect(sends).toEqual([]);
  });

  it('computes nothing while closed and does not query maxDelayedSend on every input after an error (review)', async () => {
    let calls = 0;
    const { api } = fakeApi({
      maxDelay: () => {
        calls++;
        return Promise.reject(new Error('offline'));
      },
    });
    const c = await ready(api);
    expect(calls).toBe(1);
    c.setText('a');
    c.setText('ab');
    await settle();
    expect(calls).toBe(1);
    expect(c.values(BERLIN)?.later).toMatchObject({ open: false, opts: [], dis: false });
    await vi.advanceTimersByTimeAsync(30_000);
    c.setText('abc');
    await settle();
    expect(calls).toBe(2);
  });

  it('closes the popover if the limit 0 only comes after opening (review)', async () => {
    let answer: (v: number) => void = () => {};
    const { api } = fakeApi({ maxDelay: () => new Promise((resolve) => (answer = resolve)) });
    const c = new Compose(api);
    c.start();
    // The query is running but not answered yet: the popover opens with the default.
    await settle();
    c.toggleLater();
    expect(c.values(BERLIN)?.later.open).toBe(true);
    answer(0);
    await settle();
    expect(c.current?.menu).toBeNull();
    expect(c.values(BERLIN)).toMatchObject({ anyMenu: false, later: { open: false, dis: true } });
  });

  it('schedules a preset with HOLDUNTIL; undo withdraws to Drafts', async () => {
    const planned: boolean[] = [];
    const { api, sends, unsent } = fakeApi();
    const unsend = api.unsend.bind(api);
    api.unsend = (a, s, e, p) => {
      planned.push(p ?? false);
      return unsend(a, s, e, p);
    };
    const c = await ready(api);
    c.toggleLater();
    const n = nav();
    expect(c.plan(n, 'morning')).toBe(true);
    expect(c.current).toBeNull();
    expect(n.leave).toHaveBeenCalledWith({ href: '/mailbox/k1/inbox', label: 'Inbox' }, true);
    await settle();
    expect(sends[0]?.sub).toEqual({
      identity: 'i1',
      mailFrom: 'k1@example.com',
      rcptTo: ['b@example.com'],
      holdFor: null,
      holdUntil: MON_8,
    });
    expect(ui.toast).toMatchObject({ text: 'Scheduled: Tomorrow, 08:00', undo: true, error: false });
    ui.toasts.undo();
    await settle();
    expect(unsent).toEqual([['k1', 's1', 'd1']]);
    expect(planned).toEqual([true]);
    expect(n.reopen).toHaveBeenCalled();
    expect(c.current).toMatchObject({ subject: 'Hello', saved: { account: 'k1', id: 'd1' } });
  });

  it('opens the scheduled draft again as soon as "Scheduled" withdraws the sending', async () => {
    const draft: LoadedDraft = {
      from: { name: '', email: 'k1@example.com' },
      to: [{ name: '', email: 'b@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Hello',
      text: 'Text',
      receivedAt: NOW,
      attachments: [],
      inReplyTo: null,
      references: null,
      keywords: {},
      mailboxIds: ['drafts'],
    };
    const c = await ready(fakeApi({ load: () => Promise.resolve(draft) }).api);
    c.toggleLater();
    expect(c.plan(nav(), 'morning')).toBe(true);
    await settle();
    expect(await c.openDraft('k1', 'd1')).toBe(false);
    c.unsent('k1', ['d1']);
    expect(await c.openDraft('k1', 'd1')).toBe(true);
    expect(c.current).toMatchObject({ subject: 'Hello', saved: { account: 'k1', id: 'd1' } });
  });

  it('schedules the time from the field and asks without a subject with "Schedule anyway"', async () => {
    const { api, sends } = fakeApi();
    const c = await ready(api, '');
    c.toggleLater();
    c.setLater('2026-11-03T09:30');
    expect(c.plan(nav())).toBe(true);
    expect(c.current?.menu).toBeNull();
    expect(ui.confirm).toMatchObject({ title: 'Send without a subject?', ok: 'Schedule anyway' });
    ui.confirmOk();
    await settle();
    expect(sends[0]?.sub.holdUntil).toBe(Date.UTC(2026, 10, 3, 8, 30));
    expect(ui.toast?.text).toBe('Scheduled: Tue 3 Nov, 09:30');
  });

  it("beyond the server's limit: draft, compose open again, reason in the popover and as a toast", async () => {
    const { api } = fakeApi({
      send: () => Promise.resolve(refused('Requested release time exceeds maximum of 2026-11-02T09:00:00+00:00.')),
    });
    const c = await ready(api);
    const n = nav();
    c.plan(n, 'morning');
    await settle();
    const text = m.compose_plan_reject();
    expect(n.reopen).toHaveBeenCalled();
    expect(c.current).toMatchObject({ later: '2026-11-02T08:00', laterErr: text, saved: { account: 'k1', id: 'd1' } });
    expect(c.values(BERLIN)?.later).toMatchObject({ open: true, hasHint: true, hintText: text, btnDis: true });
    expect(ui.toast).toMatchObject({ text, error: true, undo: false });
    // A new input enables "Schedule".
    c.setLater('2026-11-02T07:00');
    expect(c.values(BERLIN)?.later).toMatchObject({ hasHint: false, btnDis: false });
  });

  it('time in the past: the sentence for it in the reopened popover', async () => {
    const { api } = fakeApi({
      send: () => Promise.resolve(refused('HOLDUNTIL must be a date and time in the future.')),
    });
    const c = await ready(api);
    c.plan(nav(), 'morning');
    await settle();
    expect(c.values(BERLIN)?.later).toMatchObject({
      open: true,
      hintText: 'Please choose a time in the future.',
    });
    expect(ui.toast).toMatchObject({ text: 'Please choose a time in the future.', error: true });
  });

  it('FUTURERELEASE switched off: "Send later" disabled in the account until reload', async () => {
    const { api } = fakeApi({ send: () => Promise.resolve(refused('FUTURERELEASE extension has been disabled.')) });
    const c = await ready(api);
    c.plan(nav(), 'morning');
    await settle();
    expect(ui.toast).toMatchObject({ text: m.compose_plan_ext(), error: true });
    expect(c.current).toMatchObject({ menu: null, later: '2026-11-02T08:00', laterErr: null });
    expect(c.values(BERLIN)?.later).toMatchObject({ open: false, dis: true });
    c.toggleLater();
    expect(c.current?.menu).toBeNull();
    // Sending without a time keeps working.
    expect(c.send(nav())).toBe(true);
  });

  it('other errors and rejected recipients: compose open again, general error', async () => {
    const other = fakeApi({
      send: () => Promise.resolve({ ok: false, email: 'd1', error: { type: 'forbiddenFrom' } }),
    });
    const c = await ready(other.api);
    const n = nav();
    c.plan(n, 'morning');
    await settle();
    expect(n.reopen).toHaveBeenCalled();
    expect(c.current?.laterErr).toBeNull();
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });

    const restored: [string, string, boolean | undefined][] = [];
    const nobody = fakeApi({
      send: () => Promise.resolve({ ok: true, email: 'd7', submission: 's7', rejected: true }),
      restore: (a, e, p) => {
        restored.push([a, e, p]);
        return Promise.resolve();
      },
    });
    const d = await ready(nobody.api);
    d.plan(nav(), 'morning');
    await settle();
    expect(restored).toEqual([['k1', 'd7', true]]);
    expect(d.current?.saved).toEqual({ account: 'k1', id: 'd7' });
  });
});

describe('Attachments', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    accounts.list = [account('k1'), account('k2', { color: 3 })];
    prefs.values.defaultAccount = 'k1';
  });
  afterEach(() => {
    accounts.list = null;
    prefs.reset();
    ui.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function opened(api: ComposeApi) {
    const c = new Compose(api);
    c.start();
    await settle();
    return c;
  }

  const PART = {
    partId: '2',
    blobId: 'b1',
    size: 2048,
    headers: [],
    name: 'a.pdf',
    type: 'application/pdf',
    charset: null,
    disposition: 'attachment',
    cid: null,
    language: null,
    location: null,
    subParts: null,
  };

  const draft = (attachments: LoadedDraft['attachments']): LoadedDraft => ({
    from: null,
    to: [],
    cc: [],
    bcc: [],
    subject: 'Plan',
    text: 'Hello',
    receivedAt: NOW - 60_000,
    attachments,
    inReplyTo: null,
    references: null,
    keywords: {},
    mailboxIds: [],
  });

  it('uploads chosen files, shows "Uploading …" and then saves with the attachment', async () => {
    const { api, saves, uploads } = fakeApi();
    const c = await opened(api);
    await add(c, [file('plan.pdf', 3000, 'application/pdf')]);
    expect(c.values(TIME)).toMatchObject({
      hasAtts: true,
      attTitle: '1 attachment',
      atts: [
        {
          name: 'plan.pdf',
          icon: 'ti-cloud-upload',
          sub: 'Uploading …',
          up: true,
          rmLabel: 'Remove plan.pdf',
        },
      ],
    });
    expect(uploads.map((u) => [u.account, u.type])).toEqual([['k1', 'application/pdf']]);
    // While it is uploading nothing changes in the draft.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves).toEqual([]);

    uploads[0]?.done('B1');
    await settle();
    expect(c.values(TIME)?.atts[0]).toMatchObject({ icon: 'ti-file-type-pdf', sub: '3 KB', up: false });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[0]?.email.attachments).toEqual([
      expect.objectContaining({ blobId: 'B1', name: 'plan.pdf', type: 'application/pdf', disposition: 'attachment' }),
    ]);

    // Without a type: application/octet-stream, icon by extension.
    await add(c, [file('note.txt')]);
    expect(uploads[1]?.type).toBe('application/octet-stream');
    expect(c.values(TIME)?.attTitle).toBe('2 attachments');
    uploads[1]?.done('B2');
    await settle();
    expect(c.values(TIME)?.atts[1]?.icon).toBe('ti-file-text');
  });

  it("reports files that are too large with the server's limit and attaches only the others", async () => {
    const { api, uploads } = fakeApi();
    const c = await opened(api);
    await add(c, [file('large.zip', 2 * MB + 1), file('small.png', 10)]);
    expect(ui.toast).toMatchObject({ text: m.compose_att_too_big({ name: 'large.zip', size: '2 MB' }), error: false });
    expect(c.values(TIME)?.atts.map((a) => a.name)).toEqual(['small.png']);
    expect(uploads).toHaveLength(1);

    await add(c, [file('a.zip', 3 * MB), file('b.zip', 4 * MB)]);
    expect(ui.toast?.text).toBe('2 files are larger than 2 MB');
    expect(uploads).toHaveLength(1);
  });

  it('removing aborts a running upload; an uploaded attachment is missing on the next save', async () => {
    const { api, saves, uploads } = fakeApi();
    const c = await opened(api);
    c.setText('Hello');
    await add(c, [file('a.pdf')]);
    const key = c.values(TIME)?.atts[0]?.key ?? '';
    c.removeAttachment(key);
    expect(uploads[0]?.signal.aborted).toBe(true);
    expect(c.values(TIME)?.hasAtts).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves.map((x) => x.email.attachments)).toEqual([[]]);

    await add(c, [file('b.pdf')]);
    uploads[1]?.done('B2');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[1]?.email.attachments.map((p) => p.blobId)).toEqual(['B2']);
    c.removeAttachment(c.values(TIME)?.atts[0]?.key ?? '');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[2]?.email.attachments).toEqual([]);
  });

  it('if an upload fails, the tile stays with "Try again" without a toast', async () => {
    const { api, saves, sends, uploads } = fakeApi();
    const c = await opened(api);
    c.input('to', 'b@example.com');
    c.setSubject('Hello');
    await add(c, [file('a.pdf')]);
    const f = uploads[0]?.data;
    uploads[0]?.fail(new Error('broken'));
    await settle();
    expect(ui.toast).toBeNull();
    expect(c.values(TIME)?.atts).toEqual([
      expect.objectContaining({
        icon: 'ti-alert-circle',
        sub: 'Upload failed',
        up: false,
        failed: true,
        retryLabel: 'Upload a.pdf again',
      }),
    ]);
    // Not in the draft and no reason to send.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves.at(-1)?.email.attachments).toEqual([]);
    const n = nav();
    c.send(n);
    expect(ui.toast?.text).toBe('Please upload the failed attachments again or remove them');
    expect(sends).toEqual([]);
    // New files do not try again.
    await add(c, [file('b.pdf')]);
    expect(uploads).toHaveLength(2);

    // Without a connection (mail server unreachable): "No connection".
    uploads[1]?.fail(new JmapError('unreachable'));
    await settle();
    expect(c.values(TIME)?.atts[1]).toMatchObject({ sub: 'No connection', failed: true });

    c.retryAttachment(c.values(TIME)?.atts[0]?.key ?? '');
    expect(c.values(TIME)?.atts[0]).toMatchObject({ icon: 'ti-cloud-upload', sub: 'Uploading …', up: true });
    await settle();
    expect(uploads[2]?.data).toBe(f);
    uploads[2]?.done('B3');
    c.removeAttachment(c.values(TIME)?.atts[1]?.key ?? '');
    await settle();
    expect(c.values(TIME)?.atts).toEqual([expect.objectContaining({ failed: false, up: false, sub: '3 KB' })]);
    c.send(n);
    await settle();
    expect(sends[0]?.email.attachments.map((p) => p.blobId)).toEqual(['B3']);
  });

  it('checks the sum of the attachments per email when adding, in the chosen order', async () => {
    const { api, uploads } = fakeApi();
    const c = await opened(api);
    await add(c, [file('a.bin', 1.5 * MB), file('b.bin', 1.5 * MB), file('c.bin', 1.5 * MB), file('d.bin', 10)]);
    // From the first one that does not fit, no more – not even the small one.
    expect(ui.toast).toMatchObject({ text: 'The attachments would exceed 4 MB in total', error: false });
    expect(c.values(TIME)?.atts.map((a) => a.name)).toEqual(['a.bin', 'b.bin']);
    // Failed tiles count too.
    uploads[0]?.fail(new Error('broken'));
    await settle();
    await add(c, [file('e.bin', MB + 1)]);
    expect(ui.toast?.text).toBe('The attachments would exceed 4 MB in total');
    ui.reset();
    await add(c, [file('f.bin', MB)]);
    expect(ui.toast).toBeNull();
    expect(c.values(TIME)?.attTitle).toBe('3 attachments');

    // Both limits affected: one toast with all rejected files.
    const d = await opened(api);
    await add(d, [
      file('large.zip', 3 * MB),
      file('x.bin', 1.5 * MB),
      file('y.bin', 1.5 * MB),
      file('z.bin', 1.5 * MB),
    ]);
    expect(ui.toast?.text).toBe('2 files are too large to attach');
    expect(d.values(TIME)?.atts.map((a) => a.name)).toEqual(['x.bin', 'y.bin']);
  });

  it('sending checks the sum against the limit of the account under "Send as"', async () => {
    const { api, sends, uploads } = fakeApi({
      limits: (a) => Promise.resolve({ file: 2 * MB, email: a === 'k2' ? MB : 4 * MB }),
    });
    const c = await opened(api);
    c.input('to', 'b@example.com');
    c.setSubject('Hello');
    await add(c, [file('a.bin', 0.8 * MB), file('b.bin', 0.8 * MB)]);
    uploads[0]?.done('B1');
    uploads[1]?.done('B2');
    await settle();
    // Another account with a smaller limit: the attachments stay, sending refuses.
    c.pickFrom('k2/');
    await settle();
    uploads[2]?.done('C1');
    uploads[3]?.done('C2');
    await settle();
    expect(c.values(TIME)?.atts).toHaveLength(2);
    const n = nav();
    c.send(n);
    expect(ui.toast?.text).toBe('The attachments exceed 1 MB in total');
    expect(n.leave).not.toHaveBeenCalled();
    c.pickFrom('k1/i1');
    await settle();
    uploads[4]?.done('D1');
    uploads[5]?.done('D2');
    await settle();
    c.send(n);
    await settle();
    expect(sends).toHaveLength(1);
  });

  it('sending checks the sum also for an opened draft without new files', async () => {
    const { api, sends } = fakeApi({
      load: () => Promise.resolve(draft([PART, { ...PART, partId: '3', blobId: 'b2' }])),
      limits: () => Promise.resolve({ file: 2 * MB, email: 4000 }),
    });
    const c = new Compose(api);
    expect(await c.openDraft('k1', 'm7')).toBe(true);
    await settle();
    c.input('to', 'b@example.com');
    c.send(nav());
    expect(ui.toast?.text).toBe('The attachments exceed 3 KB in total');
    expect(sends).toEqual([]);
  });

  it('a switch under "Send as" also re-uploads failed attachments', async () => {
    const { api, uploads } = fakeApi();
    const c = await opened(api);
    await add(c, [file('a.pdf')]);
    uploads[0]?.fail(new Error('broken'));
    await settle();
    expect(c.values(TIME)?.atts[0]?.failed).toBe(true);
    c.pickFrom('k2/');
    await settle();
    expect(uploads.map((u) => u.account)).toEqual(['k1', 'k2']);
    expect(c.values(TIME)?.atts[0]).toMatchObject({ failed: false, up: true });
  });

  it('sending waits until all attachments are uploaded', async () => {
    const { api, sends, uploads } = fakeApi();
    const c = await opened(api);
    c.input('to', 'b@example.com');
    c.setSubject('Hello');
    await add(c, [file('a.pdf')]);
    const n = nav();
    c.send(n);
    expect(ui.toast?.text).toBe('Please wait until all attachments have uploaded');
    expect(n.leave).not.toHaveBeenCalled();
    uploads[0]?.done('B1');
    await settle();
    c.send(n);
    await settle();
    expect(sends[0]?.email.attachments.map((p) => p.blobId)).toEqual(['B1']);
    expect(n.leave).toHaveBeenCalled();
  });

  it('close waits for running uploads and then saves; if one fails, it saves without it', async () => {
    const { api, saves, uploads } = fakeApi();
    const c = await opened(api);
    c.setText('Hello');
    await add(c, [file('a.pdf')]);
    const n = nav();
    const closing = c.close(n);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(n.leave).not.toHaveBeenCalled();
    uploads[0]?.done('B1');
    await closing;
    expect(saves.at(-1)?.email.attachments.map((p) => p.blobId)).toEqual(['B1']);
    expect(n.leave).toHaveBeenCalled();
    expect(ui.toast?.text).toBe('Saved as draft');

    const d = await opened(api);
    d.setText('Second');
    await add(d, [file('b.pdf')]);
    const m2 = nav();
    const again = d.close(m2);
    uploads[1]?.fail(new Error('broken'));
    await again;
    expect(m2.leave).toHaveBeenCalled();
    expect(d.current).toBeNull();
    expect(saves.at(-1)?.email.text).toMatch(/^Second/);
    expect(saves.at(-1)?.email.attachments).toEqual([]);
    expect(ui.toast).toMatchObject({ text: m.compose_saved_without({ name: 'b.pdf' }), error: false });

    // Without further content no draft stays: error toast.
    const e = await opened(api);
    await add(e, [file('c.pdf'), file('d.pdf')]);
    uploads[2]?.fail(new Error('broken'));
    uploads[3]?.fail(new Error('broken'));
    await settle();
    const m3 = nav();
    const before = saves.length;
    await e.close(m3);
    expect(m3.leave).toHaveBeenCalled();
    expect(saves).toHaveLength(before);
    expect(ui.toast).toMatchObject({ text: m.compose_att_fail_bg_many({ count: 2 }), error: true });
  });

  it('leaving saves without failed attachments; if one fails in the background, error toast', async () => {
    const { api, saves, uploads } = fakeApi();
    const c = await opened(api);
    c.setText('Hello');
    await add(c, [file('a.pdf'), file('b.pdf')]);
    uploads[0]?.fail(new Error('broken'));
    await settle();
    c.park();
    await settle();
    expect(saves.at(-1)?.email.attachments).toEqual([]);
    expect(ui.toast).toMatchObject({ text: m.compose_saved_without({ name: 'a.pdf' }), error: false });
    // The second keeps uploading in the background and fails there.
    uploads[1]?.fail(new Error('broken'));
    await settle();
    expect(ui.toast).toMatchObject({ text: m.compose_att_fail_bg({ name: 'b.pdf' }), error: true });

    // Several shortly after one another count together, after 5 s it starts anew.
    const d = await opened(api);
    d.setText('Second');
    await add(d, [file('c.pdf'), file('e.pdf')]);
    d.park();
    await settle();
    uploads[2]?.fail(new Error('broken'));
    uploads[3]?.fail(new Error('broken'));
    await settle();
    expect(ui.toast).toMatchObject({ text: m.compose_att_fail_bg_many({ count: 2 }), error: true });
    await vi.advanceTimersByTimeAsync(5000);
    d.start();
    await settle();
    d.setText('Third');
    await add(d, [file('f.pdf')]);
    d.park();
    await settle();
    uploads[4]?.fail(new Error('broken'));
    await settle();
    expect(ui.toast?.text).toBe(m.compose_att_fail_bg({ name: 'f.pdf' }));
  });

  it('leaving while close waits for uploads saves anyway', async () => {
    const { api, saves, uploads } = fakeApi();
    const c = await opened(api);
    c.setText('Hello');
    await add(c, [file('a.pdf')]);
    const n = nav();
    const closing = c.close(n);
    c.park();
    uploads[0]?.fail(new Error('broken'));
    await closing;
    await settle();
    expect(saves).toHaveLength(1);
    expect(saves[0]?.email.text).toMatch(/^Hello/);
    expect(n.leave).not.toHaveBeenCalled();
  });

  it('shows attachments of an opened draft; another account moves them there', async () => {
    const { api, saves, destroyed, uploads, downloads } = fakeApi({
      load: () =>
        Promise.resolve(
          draft([
            PART,
            { ...PART, blobId: 'b2', name: null, type: 'image/png', size: 5, disposition: 'inline', cid: 'c1' },
          ]),
        ),
    });
    const c = new Compose(api);
    expect(await c.openDraft('k1', 'm7')).toBe(true);
    expect(c.values(TIME)).toMatchObject({
      attTitle: '2 attachments',
      atts: [
        { name: 'a.pdf', icon: 'ti-file-type-pdf', sub: '2 KB', up: false },
        { name: 'File', icon: 'ti-photo', sub: '1 KB', up: false, rmLabel: 'Remove File' },
      ],
    });
    await add(c, [file('new.txt')]);
    uploads[0]?.done('N1');
    await settle();

    c.pickFrom('k2/');
    await settle();
    // Upload again from the device, download from the server first.
    expect(downloads).toEqual([
      ['k1', 'b1'],
      ['k1', 'b2'],
    ]);
    expect(uploads.slice(1).map((u) => u.account)).toEqual(['k2', 'k2', 'k2']);
    expect(uploads.slice(1).filter((u) => u.data instanceof File)).toHaveLength(1);
    expect(c.values(TIME)?.atts.every((a) => a.up)).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    // While the attachments are moving, the draft stays in the first account.
    expect(saves.filter((x) => x.account === 'k2')).toEqual([]);
    expect(destroyed).toEqual([]);

    // Back into the first account: the blobs still lie there, the uploads abort.
    c.pickFrom('k1/i1');
    expect(uploads.slice(1).every((u) => u.signal.aborted)).toBe(true);
    expect(c.values(TIME)?.atts.some((a) => a.up)).toBe(false);

    // Into the second again: only when all attachments lie there does the draft move.
    c.pickFrom('k2/');
    await settle();
    const moving = uploads.slice(4);
    expect(moving).toHaveLength(3);
    moving.forEach((u, i) => u.done(`K${i}`));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves.at(-1)?.account).toBe('k2');
    expect(
      saves
        .at(-1)
        ?.email.attachments.map((p) => p.blobId)
        .sort(),
    ).toEqual(['K0', 'K1', 'K2']);
    // Embedded images stay embedded.
    expect(saves.at(-1)?.email.attachments).toContainEqual(
      expect.objectContaining({ disposition: 'inline', cid: 'c1' }),
    );
    expect(destroyed.at(-1)?.[0]).toBe('k1');
  });

  it('reports a smaller limit of the new account when moving', async () => {
    const { api, uploads } = fakeApi({
      limits: (a) => Promise.resolve({ file: a === 'k2' ? MB : 2 * MB, email: Infinity }),
    });
    const c = await opened(api);
    await add(c, [file('large.pdf', 1.5 * MB)]);
    uploads[0]?.done('B1');
    await settle();
    c.pickFrom('k2/');
    await settle();
    expect(ui.toast).toMatchObject({ text: m.compose_att_too_big({ name: 'large.pdf', size: '1 MB' }), error: false });
    expect(c.values(TIME)?.hasAtts).toBe(false);
    expect(uploads).toHaveLength(1);
  });

  it('saves no empty draft while only an attachment is uploading', async () => {
    const { api, saves } = fakeApi();
    const c = await opened(api);
    await add(c, [file('a.pdf')]);
    c.setText('x');
    c.setText('');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves).toEqual([]);
  });

  it('a waiting close does not hold up other drafts and does not close a reopened one', async () => {
    const { api, saves, uploads } = fakeApi();
    const c = await opened(api);
    c.setText('First');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    await add(c, [file('a.pdf')]);
    const n = nav();
    const closing = c.close(n);
    // A new compose can be closed; leaving saves it.
    c.start();
    c.setText('Zweiter');
    c.park();
    await settle();
    expect(saves.at(-1)?.email.text).toMatch(/^Zweiter/);
    // The first draft via its address: the same session, the close is aborted.
    expect(await c.openDraft('k1', 'd1')).toBe(true);
    uploads[0]?.done('B1');
    await closing;
    await settle();
    expect(n.leave).not.toHaveBeenCalled();
    expect(c.current?.text).toBe('First');
    const m2 = nav();
    await c.close(m2);
    expect(m2.leave).toHaveBeenCalled();
    expect(saves.at(-1)?.email.attachments.map((p) => p.blobId)).toEqual(['B1']);
  });

  it('after leaving, a finished upload saves in the background; the address opens this session', async () => {
    const { api, saves, uploads } = fakeApi({ load: () => Promise.reject(new Error('do not load')) });
    const c = await opened(api);
    c.setText('Hello');
    await add(c, [file('a.pdf')]);
    c.park();
    await settle();
    expect(saves.map((x) => x.email.attachments)).toEqual([[]]);
    expect(ui.toast?.text).toBe('Saved as draft');
    expect(await c.openDraft('k1', 'd1')).toBe(true);
    expect(c.values(TIME)?.atts[0]?.up).toBe(true);
    c.park();
    uploads[0]?.done('B1');
    await settle();
    expect(saves[1]).toMatchObject({
      replace: 'd1',
      email: { attachments: [expect.objectContaining({ blobId: 'B1' })] },
    });
  });

  it('a failed move without content keeps the previous draft until the attachment has moved or is removed', async () => {
    let reachable = false;
    const { api, saves, destroyed, uploads } = fakeApi({
      load: () => Promise.resolve(draft([PART])),
      download: () =>
        reachable ? Promise.resolve(new Blob(['content'])) : Promise.reject(new JmapError('unreachable')),
    });
    const c = new Compose(api);
    expect(await c.openDraft('k1', 'm7')).toBe(true);
    c.pickFrom('k2/');
    await settle();
    expect(c.values(TIME)?.atts[0]).toMatchObject({ failed: true, sub: 'No connection' });
    // The autosave moves without the attachment; the draft in k1 stays as its only copy.
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves.at(-1)).toMatchObject({ account: 'k2', replace: null });
    expect(saves.at(-1)?.email.attachments).toEqual([]);
    expect(destroyed).toEqual([]);
    // "Try again" downloads from k1; after saving in k2 the old draft goes.
    reachable = true;
    c.retryAttachment(c.values(TIME)?.atts[0]?.key ?? '');
    await settle();
    uploads[0]?.done('K2');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves.at(-1)?.email.attachments.map((p) => p.blobId)).toEqual(['K2']);
    expect(destroyed).toEqual([['k1', 'm7']]);

    // Removing releases it as well.
    reachable = false;
    const d = new Compose(api);
    expect(await d.openDraft('k1', 'm8')).toBe(true);
    d.pickFrom('k2/');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(destroyed).toHaveLength(1);
    d.removeAttachment(d.values(TIME)?.atts[0]?.key ?? '');
    expect(destroyed.at(-1)).toEqual(['k1', 'm8']);
  });

  it('close does not delete a draft that is the only copy of a failed attachment', async () => {
    const { api, destroyed } = fakeApi({
      load: () => Promise.resolve({ ...draft([PART]), subject: '', text: '' }),
      download: () => Promise.reject(new JmapError('unreachable')),
    });
    const c = new Compose(api);
    expect(await c.openDraft('k1', 'm7')).toBe(true);
    c.pickFrom('k2/');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    const n = nav();
    await c.close(n);
    await settle();
    expect(n.leave).toHaveBeenCalled();
    expect(destroyed).toEqual([]);
    expect(ui.toast).toMatchObject({ text: m.compose_att_fail_bg({ name: 'a.pdf' }), error: true });
  });

  it('if saving fails on close, failed tiles stay', async () => {
    let broken = true;
    const { api, saves, uploads } = fakeApi({
      save: (account, email) => {
        if (broken) return Promise.reject(new Error('broken'));
        saves.push({ account, email, replace: null, keepalive: false });
        return Promise.resolve('d1');
      },
    });
    const c = await opened(api);
    c.setText('Hello');
    await add(c, [file('a.pdf')]);
    uploads[0]?.fail(new Error('broken'));
    await settle();
    const n = nav();
    await c.close(n);
    expect(n.leave).not.toHaveBeenCalled();
    expect(ui.toast).toMatchObject({ error: true });
    expect(c.values(TIME)?.atts).toEqual([expect.objectContaining({ name: 'a.pdf', failed: true })]);
    broken = false;
    await c.close(n);
    expect(n.leave).toHaveBeenCalled();
    expect(ui.toast?.text).toBe(m.compose_saved_without({ name: 'a.pdf' }));
  });

  it('a switch back into the account of a failed upload tries again', async () => {
    const { api, uploads } = fakeApi();
    const c = await opened(api);
    await add(c, [file('a.pdf')]);
    uploads[0]?.fail(new Error('broken'));
    await settle();
    c.pickFrom('k2/');
    await settle();
    c.pickFrom('k1/i1');
    await settle();
    expect(uploads.map((u) => u.account)).toEqual(['k1', 'k2', 'k1']);
    expect(uploads[1]?.signal.aborted).toBe(true);
    expect(c.values(TIME)?.atts[0]).toMatchObject({ failed: false, up: true });
  });

  it('a new compose names left-out attachments; it queries limits once per account at the same time', async () => {
    let calls = 0;
    const { api, saves, uploads } = fakeApi({
      limits: () => {
        calls++;
        return Promise.resolve({ file: 2 * MB, email: 4 * MB });
      },
    });
    const c = await opened(api);
    c.setText('Hello');
    await add(c, [file('a.pdf'), file('b.pdf'), file('c.pdf')]);
    // `addFiles`, then `#sync` with all three uploads together.
    expect(calls).toBe(2);
    uploads[0]?.fail(new Error('broken'));
    uploads[1]?.done('B2');
    uploads[2]?.done('B3');
    await settle();
    c.start();
    await settle();
    expect(saves.at(-1)?.email.attachments.map((p) => p.blobId)).toEqual(['B2', 'B3']);
    expect(ui.toast?.text).toBe(m.compose_saved_without({ name: 'a.pdf' }));
  });

  it('leaving while close is saving names the left-out attachments', async () => {
    let finish: (id: string) => void = () => {};
    const { api, uploads } = fakeApi({
      save: () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    });
    const c = await opened(api);
    c.setText('Hello');
    await add(c, [file('a.pdf')]);
    uploads[0]?.fail(new Error('broken'));
    await settle();
    const n = nav();
    const closing = c.close(n);
    await settle();
    c.park();
    finish('d1');
    await closing;
    expect(n.leave).not.toHaveBeenCalled();
    expect(ui.toast?.text).toBe(m.compose_saved_without({ name: 'a.pdf' }));
  });

  it('discard aborts uploads, undo uploads again; sign-out aborts', async () => {
    const { api, uploads } = fakeApi();
    const c = await opened(api);
    c.setText('Hello');
    await add(c, [file('a.pdf')]);
    const n = nav();
    c.discard(n);
    expect(uploads[0]?.signal.aborted).toBe(true);
    expect(ui.toast).toMatchObject({ text: 'Draft discarded', undo: true });
    ui.toasts.undo();
    await settle();
    expect(uploads).toHaveLength(2);
    expect(c.values(TIME)?.atts[0]?.up).toBe(true);
    c.reset();
    expect(uploads[1]?.signal.aborted).toBe(true);
  });
});

describe('jmapComposeApi', () => {
  /** Real timers: deleting the previous draft runs without `await`. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  const MAIL = 'https://mail.example.com';
  const MAIL_CAP = 'urn:ietf:params:jmap:mail';
  const SESSION = {
    capabilities: {
      'urn:ietf:params:jmap:core': {
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
    accounts: {
      j1: {
        name: 'k1@example.com',
        isPersonal: true,
        isReadOnly: false,
        accountCapabilities: {
          [MAIL_CAP]: { maxSizeAttachmentsPerEmail: 5000 },
          'urn:ietf:params:jmap:submission': { maxDelayedSend: 2_592_000, submissionExtensions: {} },
        },
      },
    },
    primaryAccounts: { [MAIL_CAP]: 'j1' },
    username: 'k1@example.com',
    apiUrl: `${MAIL}/jmap/`,
    downloadUrl: `${MAIL}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${MAIL}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${MAIL}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
    state: 's1',
  };
  type Invocation = [string, Record<string, unknown>, string];

  function server(answer: (call: Invocation) => unknown, folders: Folders = { drafts: 'dr', sent: 'se' }) {
    const seen: Invocation[] = [];
    const keepalive: boolean[] = [];
    const fetch = (_url: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      keepalive.push(init.keepalive ?? false);
      const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Invocation[] };
      // One response per call, or several as a list of [name, arguments] (implicit `Email/set`).
      const methodResponses = methodCalls.flatMap((call) => {
        seen.push(call);
        const out = answer(call);
        return Array.isArray(out)
          ? (out as [string, unknown][]).map(([name, args]) => [name, args, call[2]])
          : [[call[0], out, call[2]]];
      });
      return Promise.resolve(
        new Response(JSON.stringify({ methodResponses, sessionState: 's1' }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    };
    const client = new JmapClient({
      url: MAIL,
      tokens: { token: () => Promise.resolve('t1') },
      session: SESSION,
      fetch,
    });
    const api = jmapComposeApi(
      () => Promise.resolve(client),
      () => Promise.resolve(folders),
    );
    return { api, seen, keepalive };
  }

  const SET = { accountId: 'j1', oldState: 'e1', newState: 'e2', updated: null, destroyed: null };

  it('creates the draft and deletes the previous one only afterwards in a second Email/set', async () => {
    const { api, seen, keepalive } = server(() => ({
      ...SET,
      created: { draft: { id: 'M9' } },
      notCreated: null,
      notDestroyed: null,
    }));
    const id = await api.save(
      'k1',
      {
        from: { name: 'Anna', email: 'k1@example.com' },
        to: [{ name: null, email: 'b@example.com' }],
        cc: [],
        bcc: [],
        subject: 'S',
        text: 'T',
        attachments: [],
        inReplyTo: null,
        references: null,
        keywords: { $flagged: true },
        mailboxIds: ['tag1'],
      },
      'M8',
      true,
    );
    expect(id).toBe('M9');
    // Deleting does not wait for saving.
    await tick();
    expect(keepalive).toEqual([true, true]);
    expect(seen.map((c) => c[0])).toEqual(['Email/set', 'Email/set']);
    expect(seen[0]?.[1]).toEqual({
      accountId: 'j1',
      create: {
        draft: {
          mailboxIds: { tag1: true, dr: true },
          keywords: { $flagged: true, $draft: true, $seen: true },
          from: [{ name: 'Anna', email: 'k1@example.com' }],
          to: [{ name: null, email: 'b@example.com' }],
          subject: 'S',
          bodyValues: { body: { value: 'T', isEncodingProblem: false, isTruncated: false } },
          textBody: [{ partId: 'body', type: 'text/plain' }],
        },
      },
    });
    expect(seen[1]?.[1]).toEqual({ accountId: 'j1', destroy: ['M8'] });
  });

  it('if the server rejects creating, the previous draft stays', async () => {
    // Stalwart v1.0.2 also deletes in the same call then, hence two steps.
    const { api, seen } = server(() => ({
      ...SET,
      created: null,
      notCreated: { draft: { type: 'blobNotFound', notFound: ['B1'] } },
      notDestroyed: null,
    }));
    const email = {
      from: { name: null, email: 'k1@example.com' },
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      text: 'x',
      attachments: [],
      inReplyTo: null,
      references: null,
      keywords: {},
      mailboxIds: [],
    };
    await expect(api.save('k1', email, 'M8', false)).rejects.toThrow('Email/set: blobNotFound');
    expect(seen.map((c) => c[1]['destroy'])).toEqual([undefined]);
  });

  it('if only deleting the previous one fails, the save counts', async () => {
    const { api, seen } = server((call) => {
      if (!call[1]['create']) throw new TypeError('Failed to fetch');
      return { ...SET, created: { draft: { id: 'M9' } }, notCreated: null, notDestroyed: null };
    });
    const email = {
      from: { name: null, email: 'k1@example.com' },
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      text: 'x',
      attachments: [],
      inReplyTo: null,
      references: null,
      keywords: {},
      mailboxIds: [],
    };
    await expect(api.save('k1', email, 'M8', false)).resolves.toBe('M9');
    await tick();
    expect(seen).toHaveLength(2);
  });

  it('reports a rejected creation; an already deleted draft is no error', async () => {
    const { api, seen } = server((call) =>
      call[1]['create']
        ? { ...SET, created: null, notCreated: { draft: { type: 'overQuota' } }, notDestroyed: null }
        : { ...SET, created: null, notCreated: null, notDestroyed: { M1: { type: 'notFound' } } },
    );
    const email = {
      from: { name: null, email: 'k1@example.com' },
      to: [],
      cc: [],
      bcc: [],
      subject: '',
      text: 'x',
      attachments: [],
      inReplyTo: null,
      references: null,
      keywords: {},
      mailboxIds: [],
    };
    await expect(api.save('k1', email, null, false)).rejects.toThrow('Email/set: overQuota');
    // Empty recipient fields are missing entirely (Stalwart v1.0.2 rejects `null`).
    const draft = (seen[0]?.[1]['create'] as Record<string, object>)['draft'];
    for (const key of ['to', 'cc', 'bcc']) expect(draft).not.toHaveProperty(key);
    await expect(api.destroy('k1', 'M1', false)).resolves.toBeUndefined();
  });

  describe('saveQueued', () => {
    const NO_ID = {
      from: { name: 'Anna', email: 'k1@example.com' },
      to: [],
      cc: [],
      bcc: [],
      subject: 'S',
      text: 'T',
      attachments: [],
      inReplyTo: null,
      references: null,
      keywords: {},
      mailboxIds: [],
    };
    const DRAFT = { ...NO_ID, messageId: 'm1@roedy.invalid' };

    /**
     * `recent` lies in "Drafts"; `create` and `destroy` extend the response
     * of the first or second `Email/set`, `lost` lets the response to the deletion fail to come.
     */
    function replayServer(
      recent: { id: string; messageId: string[] | null }[],
      create: Record<string, unknown> = {},
      destroy: Record<string, unknown> = {},
      lost = false,
    ) {
      return server((call) => {
        const looked = lookup(call, recent);
        if (looked) return looked;
        if (call[1]['create'])
          return { ...SET, created: { draft: { id: 'M9' } }, notCreated: null, notDestroyed: null, ...create };
        if (lost) throw new TypeError('Failed to fetch');
        return { ...SET, created: null, notCreated: null, notDestroyed: null, ...destroy };
      });
    }

    /** Responses to the look-up before creating; `null` for `Email/set`. */
    function lookup(call: Invocation, recent: { id: string; messageId: string[] | null }[]) {
      if (call[0] === 'Email/query')
        return { accountId: 'j1', queryState: 'q1', canCalculateChanges: false, position: 0, ids: [] };
      if (call[0] === 'Email/get') return { accountId: 'j1', state: 'e1', notFound: [], list: recent };
      return null;
    }

    const sets = (seen: Invocation[]) => seen.filter((c) => c[0] === 'Email/set').map((c) => c[1]);
    const destroys = (seen: Invocation[]) => sets(seen).map((a) => a['destroy']);

    it('looks through the 50 newest drafts, creates and only then deletes the state', async () => {
      const { api, seen, keepalive } = replayServer([{ id: 'M1', messageId: ['anders@roedy.invalid'] }]);
      await expect(api.saveQueued('k1', DRAFT, 'M8')).resolves.toEqual({ id: 'M9', conflict: false });
      expect(seen.map((c) => c[0])).toEqual(['Email/query', 'Email/get', 'Email/set', 'Email/set']);
      expect(keepalive).toEqual([false, false, false]);
      expect(seen[0]?.[1]).toEqual({
        accountId: 'j1',
        filter: { inMailbox: 'dr' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 50,
      });
      expect(seen[1]?.[1]).toMatchObject({
        accountId: 'j1',
        '#ids': { name: 'Email/query', path: '/ids' },
        properties: ['messageId'],
      });
      expect(seen[2]?.[1]).toMatchObject({
        accountId: 'j1',
        create: { draft: { messageId: ['m1@roedy.invalid'], mailboxIds: { dr: true } } },
        destroy: [],
      });
      expect(seen[3]?.[1]).toEqual({ accountId: 'j1', destroy: ['M8'] });
    });

    it('only creates without a state at the server: no second `Email/set`', async () => {
      const { api, seen, keepalive } = replayServer([]);
      await expect(api.saveQueued('k1', DRAFT, null)).resolves.toEqual({ id: 'M9', conflict: false });
      expect(destroys(seen)).toEqual([[]]);
      expect(keepalive).toHaveLength(2);
    });

    it('detects the conflict by `notDestroyed` of the second call', async () => {
      const { api } = replayServer([], {}, { notDestroyed: { M8: { type: 'notFound' } } });
      await expect(api.saveQueued('k1', DRAFT, 'M8')).resolves.toEqual({ id: 'M9', conflict: true });
    });

    it('does not count another rejection of the deletion as a conflict', async () => {
      const { api } = replayServer([], {}, { notDestroyed: { M8: { type: 'forbidden' } } });
      await expect(api.saveQueued('k1', DRAFT, 'M8')).resolves.toEqual({ id: 'M9', conflict: false });
    });

    it('takes an earlier attempt away in the first call, `replace` in the second, no conflict', async () => {
      const { api, seen } = replayServer(
        [
          { id: 'M1', messageId: ['m1@roedy.invalid'] },
          { id: 'M2', messageId: ['anders@roedy.invalid'] },
          { id: 'M3', messageId: null },
        ],
        {},
        // The attempt without a response has already deleted `replace`.
        { notDestroyed: { M8: { type: 'notFound' } } },
      );
      await expect(api.saveQueued('k1', DRAFT, 'M8')).resolves.toEqual({ id: 'M9', conflict: false });
      expect(destroys(seen)).toEqual([['M1'], ['M8']]);
    });

    it('names an earlier attempt without a state at the server exactly once', async () => {
      const { api, seen } = replayServer([{ id: 'M1', messageId: ['m1@roedy.invalid'] }]);
      await expect(api.saveQueued('k1', DRAFT, null)).resolves.toEqual({ id: 'M9', conflict: false });
      expect(destroys(seen)).toEqual([['M1']]);
    });

    it('does not delete an id twice if `replace` itself is the earlier attempt', async () => {
      const { api, seen } = replayServer([{ id: 'M8', messageId: ['m1@roedy.invalid'] }]);
      await expect(api.saveQueued('k1', DRAFT, 'M8')).resolves.toEqual({ id: 'M9', conflict: false });
      expect(destroys(seen)).toEqual([[], ['M8']]);
    });

    it('also leaves a `replace` with its own `messageId` in place if the server rejects creating', async () => {
      const { api, seen } = replayServer([{ id: 'M8', messageId: ['m1@roedy.invalid'] }], {
        created: null,
        notCreated: { draft: { type: 'overQuota' } },
      });
      await expect(api.saveQueued('k1', DRAFT, 'M8')).rejects.toBeInstanceOf(ComposeError);
      expect(destroys(seen)).toEqual([[]]);
    });

    it('hits nothing without its own `messageId`', async () => {
      const { api, seen } = replayServer([{ id: 'M1', messageId: ['m1@roedy.invalid'] }]);
      await api.saveQueued('k1', NO_ID, null);
      expect(destroys(seen)).toEqual([[]]);
    });

    it('leaves `replace` in place if the server rejects creating: `ComposeError`', async () => {
      const { api, seen } = replayServer([{ id: 'M1', messageId: ['m1@roedy.invalid'] }], {
        created: null,
        notCreated: { draft: { type: 'blobNotFound', notFound: ['b1'] } },
      });
      const error = await api.saveQueued('k1', DRAFT, 'M8').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ComposeError);
      expect((error as ComposeError).errors).toEqual([{ type: 'blobNotFound', notFound: ['b1'] }]);
      expect(destroys(seen)).toEqual([['M1']]);
    });

    it('reports no false conflict on the second attempt after a rejected creation', async () => {
      // Stalwart v1.0.2 also deletes in the same call when it rejects `create`: the state may only go afterwards.
      let creates = 0;
      let alive = true;
      const { api, seen } = server((call) => {
        const looked = lookup(call, []);
        if (looked) return looked;
        const wanted = (call[1]['destroy'] as string[]).includes('M8');
        const notDestroyed = wanted && !alive ? { M8: { type: 'notFound' } } : null;
        if (wanted) alive = false;
        if (!call[1]['create']) return { ...SET, created: null, notCreated: null, notDestroyed };
        return ++creates === 1
          ? { ...SET, created: null, notCreated: { draft: { type: 'blobNotFound' } }, notDestroyed }
          : { ...SET, created: { draft: { id: 'M9' } }, notCreated: null, notDestroyed };
      });
      await expect(api.saveQueued('k1', DRAFT, 'M8')).rejects.toBeInstanceOf(ComposeError);
      expect(alive).toBe(true);
      await expect(api.saveQueued('k1', DRAFT, 'M8')).resolves.toEqual({ id: 'M9', conflict: false });
      expect(destroys(seen)).toEqual([[], [], ['M8']]);
    });

    it('throws if the response to the deletion fails to come: the version keeps waiting', async () => {
      const { api, seen } = replayServer([], {}, {}, true);
      const error = await api.saveQueued('k1', DRAFT, 'M8').catch((e: unknown) => e);
      expect(unanswered(error)).toBe(true);
      expect(sets(seen)).toHaveLength(2);
    });

    it('does not let the drafts grow if responses permanently fail to come', async () => {
      // The server creates and deletes, only the response gets lost on the way.
      const stored = new Map<string, string[]>([['M0', ['old@roedy.invalid']]]);
      const state = { lost: true, ids: 0 };
      const { api } = server((call) => {
        const list = [...stored].map(([id, messageId]) => ({ id, messageId }));
        const looked = lookup(call, list);
        if (looked) return looked;
        const { create, destroy = [] } = call[1] as {
          create?: { draft: { messageId: string[] } };
          destroy?: string[];
        };
        const notDestroyed = Object.fromEntries(
          destroy.filter((id) => !stored.delete(id)).map((id) => [id, { type: 'notFound' }]),
        );
        const id = create ? `M${++state.ids}` : null;
        if (id && create) stored.set(id, create.draft.messageId);
        if (state.lost) throw new TypeError('Failed to fetch');
        return { ...SET, created: id ? { draft: { id } } : null, notCreated: null, notDestroyed };
      });

      for (let run = 1; run <= 5; run++) {
        const error = await api.saveQueued('k1', DRAFT, 'M0').catch((e: unknown) => e);
        expect(unanswered(error)).toBe(true);
        // The confirmed state and at most one created draft.
        expect([...stored.keys()]).toEqual(['M0', `M${run}`]);
      }

      state.lost = false;
      await expect(api.saveQueued('k1', DRAFT, 'M0')).resolves.toEqual({ id: 'M6', conflict: false });
      expect([...stored.keys()]).toEqual(['M6']);
    });
  });

  it('loads a draft as plain text, HTML without a text part converted', async () => {
    const { api, seen } = server(() => ({
      accountId: 'j1',
      state: 'e1',
      notFound: [],
      list: [
        {
          id: 'M1',
          from: [{ name: 'Anna', email: 'k1@example.com' }],
          to: [{ name: null, email: 'b@example.com' }],
          cc: null,
          bcc: null,
          subject: null,
          receivedAt: '2026-11-01T09:00:00Z',
          inReplyTo: null,
          references: ['<r@example.com>'],
          textBody: [
            { partId: '1', type: 'text/html' },
            { partId: '2', type: 'image/png' },
          ],
          attachments: [],
          bodyValues: { '1': { value: '<p>Hello<br>Ben</p><p>Regards</p>' } },
          keywords: { $draft: true, $seen: true, $flagged: true },
          mailboxIds: { dr: true, tag1: true },
        },
      ],
    }));
    const d = await api.load('k1', 'M1');
    expect(seen[0]?.[1]).toMatchObject({ ids: ['M1'], fetchTextBodyValues: true });
    expect(d).toEqual({
      from: { name: 'Anna', email: 'k1@example.com' },
      to: [{ name: '', email: 'b@example.com' }],
      cc: [],
      bcc: [],
      subject: '',
      text: 'Hello\nBen\nRegards',
      receivedAt: NOW,
      attachments: [],
      inReplyTo: null,
      references: ['<r@example.com>'],
      keywords: { $flagged: true },
      mailboxIds: ['dr', 'tag1'],
    });
  });

  it('returns null for a draft that no longer exists', async () => {
    const { api } = server(() => ({ accountId: 'j1', state: 'e1', notFound: ['M1'], list: [] }));
    expect(await api.load('k1', 'M1')).toBeNull();
  });

  const EMAIL: DraftEmail = {
    from: { name: 'Anna', email: 'k1@example.com' },
    to: [{ name: null, email: 'b@example.com' }],
    cc: [],
    bcc: [],
    subject: 'S',
    text: 'T',
    attachments: [],
    inReplyTo: null,
    references: null,
    keywords: {},
    mailboxIds: [],
  };
  const SUB: Submission = { identity: 'i1', mailFrom: 'k1@example.com', rcptTo: ['b@example.com'], holdFor: 10 };
  const SUB_SET = { accountId: 'j1', oldState: 'u1', newState: 'u2', updated: null, destroyed: null };

  it('saves and submits in one request: HOLDFOR, then Sent without $draft; a second one deletes the previous', async () => {
    const { api, seen, keepalive } = server((call) =>
      call[0] === 'Email/set'
        ? { ...SET, created: { draft: { id: 'M9' } }, notCreated: null, notDestroyed: null }
        : [
            [
              'EmailSubmission/set',
              { ...SUB_SET, created: { send: { id: 'U1', undoStatus: 'pending', sendAt: '2026-11-01T09:00:15Z' } } },
            ],
            ['Email/set', { ...SET, created: null, updated: { M9: null } }],
          ],
    );
    expect(await api.send('k1', EMAIL, 'M8', SUB, true)).toEqual({
      ok: true,
      email: 'M9',
      submission: 'U1',
      rejected: false,
    });
    await tick();
    expect(seen.map((c) => c[0])).toEqual(['Email/set', 'EmailSubmission/set', 'Email/set']);
    expect(seen[0]?.[1]).toMatchObject({ create: { draft: { mailboxIds: { dr: true } } } });
    expect(seen[0]?.[1]).not.toHaveProperty('destroy');
    expect(seen[2]?.[1]).toEqual({ accountId: 'j1', destroy: ['M8'] });
    expect(keepalive).toEqual([true, true]);
    expect(seen[1]?.[1]).toEqual({
      accountId: 'j1',
      create: {
        send: {
          identityId: 'i1',
          emailId: '#draft',
          envelope: {
            mailFrom: { email: 'k1@example.com', parameters: { HOLDFOR: '10' } },
            rcptTo: [{ email: 'b@example.com', parameters: null }],
          },
        },
      },
      onSuccessUpdateEmail: { '#send': { 'mailboxIds/dr': null, 'mailboxIds/se': true, 'keywords/$draft': null } },
    });
  });

  it('detects rejected recipients, queries a missing status and moves to Sent itself', async () => {
    const rejected = server((call) =>
      call[0] === 'Email/set'
        ? { ...SET, created: { draft: { id: 'M9' } }, notCreated: null, notDestroyed: null }
        : {
            ...SUB_SET,
            created: {
              send: { id: 'U1', undoStatus: 'final', deliveryStatus: { 'b@example.com': { delivered: 'no' } } },
            },
          },
    );
    expect(await rejected.api.send('k1', EMAIL, null, SUB, false)).toMatchObject({ ok: true, rejected: true });
    // Rejected: do not move anything to Sent.
    expect(rejected.seen).toHaveLength(2);

    const bare = server((call) => {
      if (call[0] === 'EmailSubmission/get')
        return {
          accountId: 'j1',
          state: 'u2',
          notFound: [],
          list: [{ id: 'U1', undoStatus: 'pending', deliveryStatus: null }],
        };
      if (call[0] === 'EmailSubmission/set') return { ...SUB_SET, created: { send: { id: 'U1' } } };
      return { ...SET, created: null, updated: { M5: null }, notCreated: null, notUpdated: null };
    });
    expect(await bare.api.submit('k1', 'M5', { ...SUB, holdFor: null }, true)).toEqual({
      ok: true,
      email: 'M5',
      submission: 'U1',
      rejected: false,
    });
    expect(bare.keepalive[0]).toBe(true);
    expect(bare.seen.map((c) => c[0])).toEqual(['EmailSubmission/set', 'EmailSubmission/get', 'Email/set']);
    expect(bare.seen[0]?.[1]).toMatchObject({
      create: { send: { emailId: 'M5', envelope: { mailFrom: { parameters: null } } } },
    });
    expect(bare.seen[2]?.[1]).toEqual({
      accountId: 'j1',
      update: { M5: { 'mailboxIds/dr': null, 'mailboxIds/se': true, 'keywords/$draft': null } },
    });
  });

  it('without information on the recipients the submission counts as accepted, even if the query fails', async () => {
    for (const answer of [
      { undoStatus: 'final', deliveryStatus: null },
      { undoStatus: undefined, deliveryStatus: undefined },
    ]) {
      const { api, seen } = server((call) => {
        if (call[0] === 'EmailSubmission/get') return [['error', { type: 'serverFail' }]];
        if (call[0] === 'EmailSubmission/set') return { ...SUB_SET, created: { send: { id: 'U1', ...answer } } };
        return { ...SET, created: null, updated: { M5: null }, notCreated: null, notUpdated: null };
      });
      expect(await api.submit('k1', 'M5', SUB, false)).toMatchObject({ ok: true, rejected: false });
      expect(seen.at(-1)?.[0]).toBe('Email/set');
    }
  });

  it('returns a rejected submission; a failed save throws', async () => {
    const error = { type: 'forbiddenMailFrom', description: 'FUTURERELEASE extension has been disabled' };
    const refused = server((call) =>
      call[0] === 'Email/set'
        ? { ...SET, created: { draft: { id: 'M9' } }, notCreated: null, notDestroyed: null }
        : { ...SUB_SET, created: null, notCreated: { send: error } },
    );
    expect(await refused.api.send('k1', EMAIL, null, SUB, false)).toEqual({ ok: false, email: 'M9', error });

    // If the method fails as a whole, the draft is saved anyway.
    const broken = server((call) =>
      call[0] === 'Email/set'
        ? { ...SET, created: { draft: { id: 'M9' } }, notCreated: null, notDestroyed: null }
        : [['error', { type: 'forbidden', description: 'No sending' }]],
    );
    expect(await broken.api.send('k1', EMAIL, 'M8', SUB, false)).toEqual({
      ok: false,
      email: 'M9',
      error: { type: 'forbidden', description: 'No sending' },
    });

    await tick();
    expect(broken.seen.at(-1)?.[1]).toEqual({ accountId: 'j1', destroy: ['M8'] });

    // Rejected creation: the submission fails with (`invalidResultReference`), the previous draft stays.
    const full = server((call) =>
      call[0] === 'Email/set'
        ? { ...SET, created: null, notCreated: { draft: { type: 'overQuota' } }, notDestroyed: null }
        : [['error', { type: 'invalidResultReference' }]],
    );
    await expect(full.api.send('k1', EMAIL, 'M8', SUB, false)).rejects.toThrow('Email/set: overQuota');
    expect(full.seen.map((c) => c[0])).toEqual(['Email/set', 'EmailSubmission/set']);
    expect(full.seen[0]?.[1]).not.toHaveProperty('destroy');
  });

  it('schedules with HOLDUNTIL to Scheduled with $scheduled and withdraws from there', async () => {
    const FOLDERS = { drafts: 'dr', sent: 'se', scheduled: 'ge' };
    const { api, seen } = server(
      (call) =>
        call[0] === 'Email/set'
          ? { ...SET, created: { draft: { id: 'M9' } }, updated: { M9: null }, notCreated: null, notDestroyed: null }
          : call[1]['update']
            ? { ...SUB_SET, updated: { U1: null } }
            : { ...SUB_SET, created: { send: { id: 'U1', undoStatus: 'pending' } } },
      FOLDERS,
    );
    const when = Date.UTC(2026, 10, 2, 7, 0, 0, 500);
    expect(await api.send('k1', EMAIL, null, { ...SUB, holdFor: null, holdUntil: when }, false)).toEqual({
      ok: true,
      email: 'M9',
      submission: 'U1',
      rejected: false,
    });
    const scheduled = {
      'mailboxIds/dr': null,
      'mailboxIds/ge': true,
      'keywords/$draft': null,
      'keywords/$scheduled': true,
    };
    expect(seen[1]?.[1]).toMatchObject({
      create: { send: { envelope: { mailFrom: { parameters: { HOLDUNTIL: '2026-11-02T07:00:00Z' } } } } },
      onSuccessUpdateEmail: { '#send': scheduled },
    });
    // Without an implicit Email/set the app moves to "Scheduled" itself.
    expect(seen[2]?.[1]).toEqual({ accountId: 'j1', update: { M9: scheduled } });

    expect(await api.unsend('k1', 'U1', 'M9', true)).toBe(true);
    const back = {
      'mailboxIds/ge': null,
      'mailboxIds/dr': true,
      'keywords/$draft': true,
      'keywords/$scheduled': null,
    };
    expect(seen[3]?.[1]).toEqual({
      accountId: 'j1',
      update: { U1: { undoStatus: 'canceled' } },
      onSuccessUpdateEmail: { U1: back },
    });
    await api.restore('k1', 'M9', true);
    expect(seen.at(-1)?.[1]).toEqual({ accountId: 'j1', update: { M9: back } });
  });

  it('does not schedule without a "Scheduled" mailbox and reads maxDelayedSend from the session', async () => {
    const { api, seen } = server(() => ({}));
    await expect(api.send('k1', EMAIL, null, { ...SUB, holdUntil: Date.UTC(2026, 10, 2) }, false)).rejects.toThrow(
      'Scheduled',
    );
    expect(seen).toEqual([]);
    expect(await api.maxDelay('k1')).toBe(2_592_000);
  });

  it('withdraws and moves the email back to Drafts; too late throws cannotUnsend', async () => {
    const back = { 'mailboxIds/se': null, 'mailboxIds/dr': true, 'keywords/$draft': true };
    const ok = server((call) =>
      call[0] === 'EmailSubmission/set'
        ? { ...SUB_SET, updated: { U1: null } }
        : { ...SET, created: null, updated: { M9: null }, notUpdated: null },
    );
    expect(await ok.api.unsend('k1', 'U1', 'M9')).toBe(true);
    expect(ok.seen[0]?.[1]).toEqual({
      accountId: 'j1',
      update: { U1: { undoStatus: 'canceled' } },
      onSuccessUpdateEmail: { U1: back },
    });
    // Without an implicit Email/set the app follows up itself.
    expect(ok.seen[1]?.[1]).toEqual({ accountId: 'j1', update: { M9: back } });

    const late = server(() => ({ ...SUB_SET, notUpdated: { U1: { type: 'cannotUnsend' } } }));
    const failed = await late.api.unsend('k1', 'U1', 'M9').catch((e: unknown) => e);
    expect(cannotUnsend(failed)).toBe(true);
    expect(late.seen).toHaveLength(1);

    // Withdrawn, only moving back fails: no error, but `false`.
    const stuck = server((call) =>
      call[0] === 'EmailSubmission/set'
        ? { ...SUB_SET, updated: { U1: null } }
        : { ...SET, created: null, updated: null, notUpdated: { M9: { type: 'notFound' } } },
    );
    expect(await stuck.api.unsend('k1', 'U1', 'M9')).toBe(false);

    const restore = server(() => ({ ...SET, created: null, updated: { M9: null }, notUpdated: null }));
    await restore.api.restore('k1', 'M9');
    expect(restore.seen[0]?.[1]).toEqual({ accountId: 'j1', update: { M9: back } });
  });

  it('reads the limits from the session and uploads attachments into the account', async () => {
    const posted: [string, string | null][] = [];
    const client = new JmapClient({
      url: MAIL,
      tokens: { token: () => Promise.resolve('t1') },
      session: SESSION,
      fetch: (url: RequestInfo | URL, init: RequestInit = {}) => {
        const href = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
        posted.push([href, new Headers(init.headers).get('Content-Type')]);
        return Promise.resolve(
          new Response(JSON.stringify({ accountId: 'j1', blobId: 'B1', type: 'text/plain', size: 4 }), {
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      },
    });
    const api = jmapComposeApi(
      () => Promise.resolve(client),
      () => Promise.resolve({ drafts: 'dr', sent: 'se' }),
    );
    expect(await api.limits('k1')).toEqual({ file: 1000, email: 5000 });
    expect(await api.upload('k1', new Blob(['test']), 'text/plain', new AbortController().signal)).toEqual({
      blobId: 'B1',
      size: 4,
    });
    expect(posted).toEqual([[`${MAIL}/jmap/upload/j1/`, 'text/plain']]);
    await expect(
      api.download('k1', { blobId: null } as EmailBodyPart, new AbortController().signal),
    ).rejects.toBeInstanceOf(ComposeError);
  });
});

describe('Drafts without a connection', () => {
  const OFF_SEND = 'Not available offline. Your draft is saved.';
  const noAnswer = () => new JmapError('unreachable');

  /** Queue in memory: only drafts, the replay runs via the session (`attach`). */
  function outbox() {
    const rows = new Map<string, QueuedDraft>();
    const log: EditLog = {
      all: () => Promise.resolve([]),
      add: () => Promise.resolve(true),
      remove: () => Promise.resolve(),
      drafts: () => Promise.resolve([...rows.values()]),
      putDraft: (d) => {
        rows.set(d.key, d);
        return Promise.resolve(true);
      },
      removeDraft: (key) => {
        rows.delete(key);
        return Promise.resolve();
      },
      retain: () => Promise.resolve(),
    };
    const queue = new EditQueue({
      log: () => log,
      replay: () => Promise.resolve([]),
      offline: () => false,
      lacksAccess: () => false,
      exclusive: (task) => task(),
      restored: () => {},
      finished: () => {},
      transferred: () => {},
    });
    return { queue, rows };
  }

  /** `link.up = false`: every attempt stays without a response. At the start the connection is gone. */
  function setup(overrides: Partial<ComposeApi> = {}, stored?: StoredDraft) {
    const link = { up: false };
    const fake = fakeApi(overrides);
    const { api } = fake;
    const save = api.save.bind(api);
    const saveQueued = api.saveQueued.bind(api);
    api.save = (...a) => (link.up ? save(...a) : Promise.reject(noAnswer()));
    api.saveQueued = (...a) => (link.up ? saveQueued(...a) : Promise.reject(noAnswer()));
    const { queue, rows } = outbox();
    return { ...fake, link, queue, rows, c: new Compose(api, queue, stored) };
  }

  /** Writes a new email until the autosave is through. */
  async function write(c: Compose, text: string) {
    c.start();
    await settle();
    c.input('to', 'Ben <ben@example.com>, ');
    c.setSubject('Hello');
    c.setText(text);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
  }

  async function retype(c: Compose, text: string) {
    c.setText(text);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
  }

  /** Version as from the queue. */
  const queued = (key: string, patch: Partial<QueuedDraft> = {}, email: Partial<DraftEmail> = {}): QueuedDraft => ({
    key,
    account: 'k1',
    email: {
      from: { name: 'Anna Becker', email: 'k1@example.com' },
      to: [{ name: 'Ben', email: 'ben@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Offline',
      text: 'My text',
      attachments: [],
      inReplyTo: null,
      references: null,
      keywords: {},
      mailboxIds: [],
      messageId: 'm1@roedy.invalid',
      ...email,
    },
    replace: null,
    moved: null,
    at: NOW,
    ...patch,
  });

  const part = (blobId: string, name: string | null): EmailBodyPart => ({
    partId: null,
    blobId,
    size: 10,
    headers: [],
    name,
    type: 'application/pdf',
    charset: null,
    disposition: 'attachment',
    cid: null,
    language: null,
    location: null,
    subParts: null,
  });

  function deferred<T>() {
    let open!: (value: T) => void;
    let fail!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      open = resolve;
      fail = reject;
    });
    return { promise, open, fail };
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    accounts.list = [account('k1'), account('k2', { color: 3 })];
    prefs.values.defaultAccount = 'k1';
  });
  afterEach(() => {
    accounts.list = null;
    prefs.reset();
    ui.reset();
    network.simulated = false;
    network.online = true;
    network.reached = new Map();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('Autosave without a response', () => {
    it.each([
      ['NetworkError', new NetworkError(new Error('gone'))],
      ['no connection to the mail server', new JmapError('unreachable')],
      ['503 from the proxy', new JmapError('status', { status: 503 })],
    ])('parks the version on %s and shows it as saved', async (_name, error) => {
      const { c, api, queue, rows } = setup();
      api.save = () => Promise.reject(error);
      c.start();
      await settle();
      c.input('to', 'Ben <ben@example.com>, ');
      c.setText('Text');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
      expect(queue.drafts).toHaveLength(1);
      expect(rows.size).toBe(1);
      expect(queue.drafts[0]).toMatchObject({
        account: 'k1',
        replace: null,
        moved: null,
        at: NOW + AUTOSAVE_MS,
        email: {
          text: 'Text\n\n-- \nBest regards\nAnna',
          messageId: expect.stringMatching(/@roedy\.invalid$/) as string,
        },
      });
    });

    it('says "Offline gespeichert", on mobile "Saved locally", and throws no error', async () => {
      const { c, queue } = setup();
      await write(c, 'Text');
      const key = queue.drafts[0]?.key;
      expect(c.current).toMatchObject({ dirty: false, failed: false, parked: key, saved: null });
      expect(c.values(TIME)).toMatchObject({
        status: 'Saved offline at 10:00',
        statusM: 'Saved locally',
        hasStatus: true,
        statusIcon: 'ti-cloud-off',
        sendOff: true,
        discardLabel: 'Delete draft',
      });
      expect(ui.toast).toBeNull();
      expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
    });

    it('`status` switches to "Saving …" while writing, also on mobile', async () => {
      const { c } = setup();
      await write(c, 'Text');
      c.setText('Text!');
      expect(c.values(TIME)).toMatchObject({
        status: 'Saving …',
        statusM: 'Saving …',
        statusIcon: 'ti-cloud-upload',
      });
    });

    it('shows the time online also on mobile', async () => {
      const { c, link } = setup();
      link.up = true;
      await write(c, 'Text');
      expect(c.values(TIME)).toMatchObject({
        status: 'Saved at 10:00',
        statusM: 'Saved at 10:00',
        statusIcon: 'ti-cloud-check',
        sendOff: false,
      });
    });

    it('does not park if the server has answered: that stays an error', async () => {
      const { c, api, queue } = setup();
      api.save = () => Promise.reject(new JmapError('status', { status: 500 }));
      await write(c, 'Text');
      expect(queue.drafts).toEqual([]);
      expect(c.current).toMatchObject({ failed: true, parked: null });
      expect(c.values(TIME)).toMatchObject({ hasStatus: false, sendOff: false });
    });

    it('stays `dirty` if typing happened during the attempt', async () => {
      const attempt = deferred<string>();
      const { c, api, queue } = setup();
      api.save = () => attempt.promise;
      await write(c, 'one');
      c.setText('one two');
      attempt.fail(noAnswer());
      await settle();
      expect(queue.drafts).toHaveLength(1);
      expect(queue.drafts[0]?.email.text).toMatch(/^one\n/);
      expect(c.current?.dirty).toBe(true);
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
      expect(queue.drafts).toHaveLength(1);
      expect(queue.drafts[0]?.email.text).toMatch(/^one two\n/);
      expect(c.current?.dirty).toBe(false);
    });

    it('queues further versions instead of sending, even if the connection is back', async () => {
      const { c, api, queue, link, saves, replays } = setup();
      const save = vi.spyOn(api, 'save');
      await write(c, 'one');
      expect(save).toHaveBeenCalledOnce();
      const key = queue.drafts[0]?.key;

      await retype(c, 'two');
      expect(save).toHaveBeenCalledOnce();
      expect(queue.drafts.map((d) => d.key)).toEqual([key]);
      expect(queue.drafts[0]?.email.text).toMatch(/^two\n/);

      link.up = true;
      await vi.advanceTimersByTimeAsync(DRAFT_PAUSE_MS);
      await retype(c, 'three');
      expect(save).toHaveBeenCalledOnce();
      expect(saves).toEqual([]);
      expect(replays.map((r) => r.email.text.split('\n')[0])).toEqual(['three']);
      expect(queue.drafts).toEqual([]);
    });

    it('keeps `messageId` until a response came, and assigns a new one afterwards', async () => {
      const { c, api, queue, link, saves, replays } = setup();
      const save = vi.spyOn(api, 'save');
      await write(c, 'one');
      const mid = queue.drafts[0]?.email.messageId;
      expect(save.mock.calls[0]?.[1].messageId).toBe(mid);
      await retype(c, 'two');
      expect(queue.drafts[0]?.email.messageId).toBe(mid);
      link.up = true;
      await queue.replay(true);
      expect(replays[0]?.email.messageId).toBe(mid);

      await retype(c, 'three');
      const next = saves[0]?.email.messageId;
      expect(next).toMatch(/@roedy\.invalid$/);
      expect(next).not.toBe(mid);
      await retype(c, 'vier');
      expect(saves[1]?.email.messageId).not.toBe(next);
    });

    it('puts the state at the server into the version as `replace`', async () => {
      const { c, queue, link } = setup();
      link.up = true;
      await write(c, 'one');
      link.up = false;
      await retype(c, 'two');
      expect(queue.drafts[0]).toMatchObject({ replace: { account: 'k1', id: 'd1' }, moved: null });
      expect(c.current?.saved).toEqual({ account: 'k1', id: 'd1' });
      expect(c.ref).toBe('k1/d1');
    });

    it('puts the old state in as `moved` after a switch of "Send as"', async () => {
      const { c, queue, link, destroyed, replays } = setup();
      link.up = true;
      await write(c, 'one');
      link.up = false;
      c.pickFrom('k2/');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
      expect(queue.drafts[0]).toMatchObject({ account: 'k2', replace: null, moved: { account: 'k1', id: 'd1' } });
      expect(destroyed).toEqual([]);

      link.up = true;
      await queue.replay();
      expect(replays).toMatchObject([{ account: 'k2', replace: null }]);
      expect(destroyed).toEqual([['k1', 'd1']]);
      expect(c.current?.saved).toEqual({ account: 'k2', id: 'd2' });
      expect(c.ref).toBe('k2/d2');
    });

    it('shows the address `~<key>` as long as the draft exists only in the queue', async () => {
      const { c, queue } = setup();
      await write(c, 'Text');
      expect(c.ref).toBe(`k1/~${queue.drafts[0]?.key}`);
    });

    describe('Autosave earlier', () => {
      const typed = async (c: Compose) => {
        c.start();
        await settle();
        c.setText('Text');
      };

      it('waits only `OFFLINE_SAVE_MS` without a connection', async () => {
        const { c, queue } = setup();
        expect(OFFLINE_SAVE_MS).toBe(200);
        network.simulated = true;
        await typed(c);
        await vi.advanceTimersByTimeAsync(OFFLINE_SAVE_MS - 1);
        expect(queue.drafts).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(queue.drafts).toHaveLength(1);
      });

      it('also applies without a reported connection until a response came', async () => {
        const { c, api } = setup();
        const save = vi.spyOn(api, 'save');
        network.online = false;
        await typed(c);
        await vi.advanceTimersByTimeAsync(OFFLINE_SAVE_MS);
        expect(save).toHaveBeenCalledOnce();

        save.mockClear();
        network.record('https://mail.example.test', true);
        c.start();
        await settle();
        c.setText('Another text');
        await vi.advanceTimersByTimeAsync(OFFLINE_SAVE_MS);
        expect(save).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - OFFLINE_SAVE_MS);
        expect(save).toHaveBeenCalledOnce();
      });

      it('waits only `OFFLINE_SAVE_MS` with a waiting version, even if the connection is back', async () => {
        const { c, queue, link } = setup();
        await write(c, 'one');
        link.up = true;
        c.setText('two');
        await vi.advanceTimersByTimeAsync(OFFLINE_SAVE_MS - 1);
        expect(queue.drafts[0]?.email.text).toMatch(/^one\n/);
        await vi.advanceTimersByTimeAsync(1);
        expect(c.current?.dirty).toBe(false);
      });

      it('stays at `AUTOSAVE_MS` online', async () => {
        const { c, api, link } = setup();
        const save = vi.spyOn(api, 'save');
        link.up = true;
        await typed(c);
        await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 1);
        expect(save).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(save).toHaveBeenCalledOnce();
      });
    });

    it('`close()` keeps a draft that exists only in the queue', async () => {
      const { c, queue, rows, destroyed } = setup();
      await write(c, 'Text');
      expect(c.current).toMatchObject({ dirty: false, saved: null });
      const key = queue.drafts[0]?.key;
      const n = nav();
      await c.close(n);
      await settle();
      expect(n.leave).toHaveBeenCalledOnce();
      expect(c.current).toBeNull();
      expect(queue.drafts.map((d) => d.key)).toEqual([key]);
      expect(rows.size).toBe(1);
      expect(destroyed).toEqual([]);
      expect(ui.toast).toMatchObject({ text: 'Saved as draft' });
      expect(ui.toast?.error).toBeFalsy();
    });

    it('`close()` keeps it also with a failed attachment and names the attachment', async () => {
      const { c, queue, destroyed, uploads } = setup();
      await write(c, 'Text');
      await add(c, [file('image.png')]);
      uploads[0]?.fail(noAnswer());
      await vi.advanceTimersByTimeAsync(OFFLINE_SAVE_MS);
      expect(c.values(TIME)?.atts[0]).toMatchObject({ failed: true });
      const n = nav();
      await c.close(n);
      await settle();
      expect(n.leave).toHaveBeenCalledOnce();
      expect(queue.drafts).toHaveLength(1);
      expect(destroyed).toEqual([]);
      expect(ui.toast).toMatchObject({ text: m.compose_saved_without({ name: 'image.png' }) });
      expect(ui.toast?.error).toBeFalsy();
    });

    it('`close()` of an emptied draft keeps taking back the version', async () => {
      const { c, queue } = setup();
      c.start();
      await settle();
      c.setText('Text');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
      expect(queue.drafts).toHaveLength(1);
      c.setText('');
      await c.close(nav());
      await settle();
      expect(queue.drafts).toEqual([]);
    });

    it('loses nothing on closing without a connection and does not retry by itself', async () => {
      const { c, api, queue } = setup();
      const save = vi.spyOn(api, 'save');
      c.start();
      await settle();
      c.setText('Text');
      const n = nav();
      await c.close(n);
      await settle();
      expect(n.leave).toHaveBeenCalledOnce();
      expect(queue.drafts).toHaveLength(1);
      expect(ui.toast).toMatchObject({ text: 'Saved as draft' });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(save).toHaveBeenCalledOnce();
    });
  });

  describe('`flush()` when leaving the page', () => {
    it('parks without a connection, without an attempt and without a replay', async () => {
      const { c, api, queue, rows } = setup();
      const save = vi.spyOn(api, 'save');
      const replay = vi.spyOn(api, 'saveQueued');
      network.simulated = true;
      c.start();
      await settle();
      c.setText('last text');
      c.flush();
      await settle();
      expect(save).not.toHaveBeenCalled();
      expect(replay).not.toHaveBeenCalled();
      expect(rows.size).toBe(1);
      expect(queue.stuck).toEqual([]);
    });

    it('tries if a response came despite the browser reporting no connection', async () => {
      const { c, queue, link, saves } = setup();
      link.up = true;
      network.online = false;
      network.record('https://mail.example.test', true);
      c.start();
      await settle();
      c.setText('Text');
      c.flush();
      await settle();
      expect(saves).toMatchObject([{ keepalive: true }]);
      expect(queue.drafts).toEqual([]);
    });

    it('queues a further version without a replay, also with a connection', async () => {
      const { c, api, queue } = setup();
      await write(c, 'one');
      const replay = vi.spyOn(api, 'saveQueued');
      c.setText('two');
      c.flush();
      await settle();
      expect(replay).not.toHaveBeenCalled();
      expect(queue.drafts[0]?.email.text).toMatch(/^two\n/);
    });
  });

  describe('Replay', () => {
    it('then continues with the new id', async () => {
      const { c, queue, rows, link, saves, replays } = setup();
      await write(c, 'one');
      link.up = true;
      await queue.replay();
      expect(replays).toMatchObject([{ account: 'k1', replace: null }]);
      expect(c.current).toMatchObject({ saved: { account: 'k1', id: 'd1' }, parked: null, dirty: false });
      expect(c.ref).toBe('k1/d1');
      expect(c.values(TIME)).toMatchObject({
        status: 'Saved at 10:00',
        statusM: 'Saved at 10:00',
        statusIcon: 'ti-cloud-check',
        sendOff: false,
      });
      expect(queue.count).toBe(0);
      expect(rows.size).toBe(0);

      await retype(c, 'two');
      expect(saves).toMatchObject([{ replace: 'd1' }]);
    });

    it('the old address opens the new state', async () => {
      const loads: string[] = [];
      const { c, queue, link } = setup({
        load: (_a, id) => {
          loads.push(id);
          return Promise.resolve(null);
        },
      });
      link.up = true;
      await write(c, 'one');
      link.up = false;
      await retype(c, 'two');
      link.up = true;
      await queue.replay();
      expect(c.ref).toBe('k1/d2');
      expect(await c.openDraft('k1', 'd1')).toBe(true);
      expect(loads).toEqual([]);

      c.park();
      await settle();
      expect(await c.openDraft('k1', 'd1')).toBe(false);
      expect(loads).toEqual(['d2']);
    });

    it('`~<key>` follows the new state after the replay', async () => {
      const loads: string[] = [];
      const { c, queue, link } = setup({
        load: (_a, id) => {
          loads.push(id);
          return Promise.resolve(null);
        },
      });
      await write(c, 'one');
      const key = queue.drafts[0]?.key ?? '';
      link.up = true;
      await queue.replay();
      expect(await c.openDraft('k1', `~${key}`)).toBe(true);
      expect(loads).toEqual([]);
    });

    it('also reports the new id to a closed session', async () => {
      const loads: string[] = [];
      const { c, queue, link } = setup({
        load: (_a, id) => {
          loads.push(id);
          return Promise.resolve(null);
        },
      });
      await write(c, 'one');
      const key = queue.drafts[0]?.key ?? '';
      c.park();
      await settle();
      link.up = true;
      await queue.replay();
      expect(queue.drafts).toEqual([]);
      await c.openDraft('k1', `~${key}`);
      expect(loads).toEqual(['d1']);
    });

    it('lets no session be touched any more after sign-out', async () => {
      const { c, queue, link } = setup();
      await write(c, 'one');
      c.reset();
      link.up = true;
      await queue.replay();
      expect(queue.drafts).toEqual([]);
      expect(c.current).toBeNull();
    });

    it('keeps the version if it stays without a response again', async () => {
      const { c, queue } = setup();
      await write(c, 'one');
      const key = queue.drafts[0]?.key;
      await queue.replay();
      expect(c.current?.parked).toBe(key);
      expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
    });

    it('lays the newer version over the draft just created', async () => {
      const first = deferred<ReplayedDraft>();
      const { c, api, queue, link, replays } = setup();
      await write(c, 'one');
      link.up = true;
      const replay = api.saveQueued.bind(api);
      api.saveQueued = (...a) => {
        api.saveQueued = replay;
        replays.push({ account: a[0], email: a[1], replace: a[2] });
        return first.promise;
      };
      const run = queue.replay();
      await settle();
      await retype(c, 'two');
      expect(c.current?.parked).not.toBeNull();
      first.open({ id: 'mitte', conflict: false });
      await run;
      await settle();
      expect(replays.map((r) => [r.email.text.split('\n')[0], r.replace])).toEqual([
        ['one', null],
        ['two', 'mitte'],
      ]);
      // Both carry the same `messageId`: the replay also replaces an unconfirmed attempt.
      expect(replays[1]?.email.messageId).toBe(replays[0]?.email.messageId);
      expect(c.current).toMatchObject({ parked: null, saved: { account: 'k1', id: 'd1' } });
      expect(queue.drafts).toEqual([]);
    });

    it('moves a version switched during the replay into the new account without a further trigger', async () => {
      const first = deferred<ReplayedDraft>();
      const { c, api, queue, link, replays, destroyed } = setup();
      link.up = true;
      await write(c, 'one');
      link.up = false;
      await retype(c, 'two');
      link.up = true;
      const replay = api.saveQueued.bind(api);
      api.saveQueued = (...a) => {
        api.saveQueued = replay;
        replays.push({ account: a[0], email: a[1], replace: a[2] });
        return first.promise;
      };
      const run = queue.replay();
      await settle();
      c.pickFrom('k2/');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
      first.open({ id: 'mitte', conflict: false });
      await run;
      await settle();
      // An id from k1 means nothing in k2: `replace` stays empty, the draft just created goes as `moved`.
      expect(replays.map((r) => [r.account, r.replace])).toEqual([
        ['k1', 'd1'],
        ['k2', null],
      ]);
      expect(destroyed).toEqual([['k1', 'mitte']]);
      expect(queue.drafts).toEqual([]);
      expect(queue.conflict).toBeNull();
      expect(c.current).toMatchObject({ saved: { account: 'k2', id: 'd2' }, parked: null });
      expect(c.ref).toBe('k2/d2');
    });

    it('takes the new id after a conflict and names the draft in `conflict`', async () => {
      const { c, queue, link } = setup({
        saveQueued: () => Promise.resolve({ id: 'd9', conflict: true }),
      });
      link.up = true;
      await write(c, 'one');
      link.up = false;
      await retype(c, 'two');
      link.up = true;
      await queue.replay();
      expect(queue.conflict).toMatchObject({ count: 1, subject: 'Hello', account: 'k1', id: 'd9' });
      expect(c.current?.saved).toEqual({ account: 'k1', id: 'd9' });
      expect(c.ref).toBe('k1/d9');
    });

    it('keeps the draft in the old account as long as it is the only copy of an attachment', async () => {
      const loaded: LoadedDraft = {
        from: { name: 'Anna Becker', email: 'k1@example.com' },
        to: [],
        cc: [],
        bcc: [],
        subject: 'S',
        text: 'T',
        attachments: [part('b1', 'a.pdf')],
        inReplyTo: null,
        references: null,
        keywords: {},
        mailboxIds: [],
        receivedAt: NOW,
      };
      const { c, queue, link, destroyed } = setup({
        load: () => Promise.resolve(loaded),
        download: () => Promise.reject(noAnswer()),
      });
      link.up = true;
      await c.openDraft('k1', 'm7');
      link.up = false;
      c.pickFrom('k2/');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
      expect(queue.drafts[0]).toMatchObject({ account: 'k2', replace: null, moved: null });

      link.up = true;
      await queue.replay();
      expect(c.current?.saved).toEqual({ account: 'k2', id: 'd1' });
      expect(destroyed).toEqual([]);
      c.removeAttachment(c.values(TIME)?.atts[0]?.key ?? '');
      expect(destroyed).toEqual([['k1', 'm7']]);
    });
  });

  describe('Leaving out what the server misses', () => {
    /** Opens a version with `attachments` and answers the first attempt with `errors`. */
    async function refused(errors: SetError[], email: Partial<DraftEmail>) {
      const f = setup();
      f.link.up = true;
      const replay = f.api.saveQueued.bind(f.api);
      let first = true;
      f.api.saveQueued = (...a) => {
        if (!first) return replay(...a);
        first = false;
        return Promise.reject(new ComposeError('Email/set', errors));
      };
      await f.queue.addDraft(queued('1', {}, email), true);
      await f.c.openDraft('k1', '~1');
      await f.queue.replay();
      await settle();
      return f;
    }

    it('takes out a missing blob and names it in the toast', async () => {
      const { c, queue, replays } = await refused([{ type: 'blobNotFound', notFound: ['b2'] }], {
        attachments: [part('b1', 'invoice.pdf'), part('b2', 'image.pdf')],
      });
      expect(replays.map((r) => r.email.attachments.map((a) => a.blobId))).toEqual([['b1']]);
      expect(ui.toast).toMatchObject({ text: m.compose_saved_without({ name: 'image.pdf' }) });
      expect(c.current?.atts.map((a) => a.name)).toEqual(['invoice.pdf']);
      expect(queue.drafts).toEqual([]);
      expect(queue.stuck).toEqual([]);
    });

    it('counts several missing attachments', async () => {
      const { replays } = await refused([{ type: 'blobNotFound', notFound: ['b1', 'b2'] }], {
        attachments: [part('b1', 'a.pdf'), part('b2', 'b.pdf'), part('b3', 'c.pdf')],
      });
      expect(replays[0]?.email.attachments.map((a) => a.blobId)).toEqual(['b3']);
      expect(ui.toast).toMatchObject({ text: 'Saved as draft without 2 attachments' });
    });

    it('calls a nameless attachment "File"', async () => {
      await refused([{ type: 'blobNotFound', notFound: ['b1'] }], { attachments: [part('b1', null)] });
      expect(ui.toast).toMatchObject({ text: m.compose_saved_without({ name: 'File' }) });
    });

    it('leaves out further mailboxes, without a toast', async () => {
      const { c, queue, replays } = await refused([{ type: 'invalidProperties', properties: ['mailboxIds'] }], {
        mailboxIds: ['tag1', 'tag2'],
      });
      expect(replays.map((r) => r.email.mailboxIds)).toEqual([[]]);
      expect(ui.toast).toBeNull();
      expect(c.current?.extras.mailboxIds).toEqual([]);
      expect(queue.drafts).toEqual([]);
    });

    it('leaves the version if `mailboxIds` contains nothing that can be left out', async () => {
      const { c, queue, replays } = await refused([{ type: 'invalidProperties', properties: ['mailboxIds'] }], {
        mailboxIds: [],
      });
      expect(replays).toEqual([]);
      expect(queue.drafts).toHaveLength(1);
      expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
      expect(c.current?.parked).toBe('1');
    });

    it('leaves the version if the missing blob does not belong to it at all', async () => {
      const { queue, replays } = await refused([{ type: 'blobNotFound', notFound: ['fremd'] }], {
        attachments: [part('b1', 'a.pdf')],
      });
      expect(replays).toEqual([]);
      expect(queue.drafts).toHaveLength(1);
    });

    it.each([
      ['another rejection', [{ type: 'overQuota' }]],
      ['another invalid field', [{ type: 'invalidProperties', properties: ['subject'] }]],
      ['a rejection without details', []],
    ])('leaves the version on %s, "Erneut versuchen" stays', async (_name, errors: SetError[]) => {
      const { c, queue, rows, replays } = await refused(errors, {
        attachments: [part('b1', 'a.pdf')],
        mailboxIds: ['tag1'],
      });
      expect(replays).toEqual([]);
      expect(rows.size).toBe(1);
      expect(queue.stuck).toEqual([{ account: 'k1', count: 1 }]);
      expect(c.current?.atts).toHaveLength(1);
      expect(ui.toast).toBeNull();
    });

    it('rethrows errors other than `ComposeError`', async () => {
      const { c, api, queue, link } = setup({ saveQueued: () => Promise.reject(new Error('anders')) });
      link.up = true;
      await queue.addDraft(queued('1'), true);
      await c.openDraft('k1', '~1');
      const replay = vi.spyOn(api, 'saveQueued');
      await queue.replay();
      expect(replay).toHaveBeenCalledOnce();
      expect(queue.drafts).toHaveLength(1);
    });
  });

  describe('Sending disabled', () => {
    it.each([
      ['in the simulation', () => (network.simulated = true)],
      ['without a reported connection', () => (network.online = false)],
    ])('%s: send and send later give an error toast', async (_name, cut) => {
      const { c, sends, link } = setup();
      link.up = true;
      await write(c, 'Text');
      cut();
      expect(c.values(TIME)).toMatchObject({
        sendOff: true,
        status: 'Saved offline at 10:00',
        statusM: 'Saved locally',
        statusIcon: 'ti-cloud-off',
      });
      expect(c.values(TIME)?.later).toMatchObject({ dis: true, tip: OFF_SEND, open: false });

      const n = nav();
      expect(c.send(n)).toBe(false);
      await settle();
      expect(ui.toast).toMatchObject({ text: OFF_SEND, error: true });
      expect(sends).toEqual([]);
      expect(n.leave).not.toHaveBeenCalled();
      expect(c.current).not.toBeNull();

      ui.reset();
      c.toggleLater();
      expect(c.current?.menu).toBeNull();
      expect(ui.toast).toMatchObject({ text: OFF_SEND, error: true });
    });

    it('sends if a response came despite the browser reporting no connection', async () => {
      const { c, sends, link } = setup();
      link.up = true;
      await write(c, 'Text');
      network.online = false;
      network.record('https://mail.example.test', true);
      expect(c.values(TIME)).toMatchObject({ sendOff: false, status: 'Saved at 10:00' });
      expect(c.send(nav())).toBe(true);
      await settle();
      expect(sends).toHaveLength(1);
    });

    it('disables while a version waits, and tries the replay right away', async () => {
      const { c, queue, sends, link, replays } = setup();
      await write(c, 'Text');
      const n = nav();
      link.up = true;
      expect(c.values(TIME)?.sendOff).toBe(true);
      expect(c.send(n)).toBe(false);
      expect(ui.toast).toMatchObject({ text: OFF_SEND, error: true });
      expect(sends).toEqual([]);
      await settle();
      expect(replays).toHaveLength(1);
      expect(queue.drafts).toEqual([]);
      expect(c.values(TIME)?.sendOff).toBe(false);

      expect(c.send(n)).toBe(true);
      await settle();
      expect(sends).toMatchObject([{ replace: 'd1' }]);
    });

    it('"Send later" also triggers the replay', async () => {
      const { c, queue, link, replays } = setup();
      await write(c, 'Text');
      link.up = true;
      c.toggleLater();
      await settle();
      expect(replays).toHaveLength(1);
      expect(queue.drafts).toEqual([]);
      expect(c.current?.menu).toBeNull();
    });

    it('checks the connection first, then the recipients', () => {
      const { c } = setup();
      c.start();
      network.simulated = true;
      expect(c.send(nav())).toBe(false);
      expect(ui.toast).toMatchObject({ text: OFF_SEND, error: true });
      expect(c.current?.err).toBeNull();
    });

    it('enables sending if another tab has replayed the version', async () => {
      const { c, queue, rows, link, sends } = setup();
      await write(c, 'Text');
      link.up = true;
      expect(c.values(TIME)?.sendOff).toBe(true);
      rows.clear();
      await queue.restore();
      expect(queue.drafts).toEqual([]);
      expect(c.values(TIME)).toMatchObject({
        sendOff: false,
        status: 'Saved at 10:00',
        statusIcon: 'ti-cloud-check',
      });
      expect(c.values(TIME)?.later).toMatchObject({ dis: false, tip: '' });
      expect(c.send(nav())).toBe(true);
      await settle();
      expect(sends).toHaveLength(1);
    });

    it('stays disabled without a connection even if the version is already replayed', async () => {
      const { c, queue, rows } = setup();
      await write(c, 'Text');
      rows.clear();
      await queue.restore();
      network.simulated = true;
      expect(c.values(TIME)?.sendOff).toBe(true);
    });

    it('takes back a version still stored while sending', async () => {
      const attempt = deferred<string>();
      const { c, api, queue, sends, link } = setup();
      link.up = true;
      api.save = () => attempt.promise;
      await write(c, 'Text');
      expect(c.send(nav())).toBe(true);
      attempt.fail(noAnswer());
      await settle();
      expect(sends).toHaveLength(1);
      expect(queue.drafts).toEqual([]);
    });
  });

  describe('Discard', () => {
    it('`discard` takes back the version after the toast', async () => {
      const { c, queue, rows, destroyed } = setup();
      await write(c, 'Text');
      c.discard(nav());
      expect(ui.toast).toMatchObject({ text: 'Draft deleted' });
      expect(queue.drafts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(queue.drafts).toEqual([]);
      expect(rows.size).toBe(0);
      expect(destroyed).toEqual([]);
    });

    it('also deletes the state at the server that the version was to replace', async () => {
      const { c, queue, link, destroyed } = setup();
      link.up = true;
      await write(c, 'one');
      link.up = false;
      await retype(c, 'two');
      link.up = true;
      c.discard(nav());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(queue.drafts).toEqual([]);
      expect(destroyed).toEqual([['k1', 'd1']]);
    });

    it('undo lets the version wait', async () => {
      const { c, queue } = setup();
      await write(c, 'Text');
      const key = queue.drafts[0]?.key;
      c.discard(nav());
      ui.toasts.undo();
      await settle();
      expect(c.current?.parked).toBe(key);
      expect(queue.drafts).toHaveLength(1);
    });

    it('takes back the version immediately even without content', async () => {
      const { c, queue } = setup();
      c.start();
      await settle();
      c.setText('Text');
      await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
      expect(queue.drafts).toHaveLength(1);
      c.setText('');
      c.discard(nav());
      await settle();
      expect(queue.drafts).toEqual([]);
    });

    it('removes the new draft again if it was discarded during the replay', async () => {
      const answer = deferred<ReplayedDraft>();
      const { c, api, queue, link, destroyed } = setup();
      await write(c, 'Text');
      link.up = true;
      api.saveQueued = () => answer.promise;
      const run = queue.replay();
      await settle();
      c.discard(nav());
      await vi.advanceTimersByTimeAsync(10_000);
      answer.open({ id: 'd9', conflict: false });
      await run;
      await settle();
      expect(destroyed).toEqual([['k1', 'd9']]);
      expect(queue.drafts).toEqual([]);
    });
  });

  describe('`openDraft`', () => {
    const loader = () => {
      const loads: string[] = [];
      return {
        loads,
        load: (_a: string, id: string) => {
          loads.push(id);
          return Promise.resolve(null);
        },
      };
    };

    it('takes the version before the state at the server', async () => {
      const { loads, load } = loader();
      const { c, queue } = setup({ load });
      await queue.addDraft(queued('1', { replace: { account: 'k1', id: 'd7' }, at: NOW - 60_000 }), true);
      expect(await c.openDraft('k1', 'd7')).toBe(true);
      expect(loads).toEqual([]);
      expect(c.current).toMatchObject({
        account: 'k1',
        subject: 'Offline',
        text: 'My text',
        parked: '1',
        saved: { account: 'k1', id: 'd7' },
        savedAt: NOW - 60_000,
        dirty: false,
      });
      expect(c.ref).toBe('k1/d7');
      expect(c.values(TIME)).toMatchObject({ title: 'Draft', sendOff: true, statusIcon: 'ti-cloud-off' });
    });

    it('finds the version from the database after reloading', async () => {
      const { loads, load } = loader();
      const { c, rows } = setup({ load });
      rows.set('1', queued('1', { replace: { account: 'k1', id: 'd7' } }));
      expect(await c.openDraft('k1', 'd7')).toBe(true);
      expect(loads).toEqual([]);
      expect(c.current?.text).toBe('My text');
    });

    it('takes the version even if the connection is already back', async () => {
      const { loads, load } = loader();
      const { c, queue, link } = setup({ load });
      link.up = true;
      await queue.addDraft(queued('1', { replace: { account: 'k1', id: 'd7' } }), true);
      expect(await c.openDraft('k1', 'd7')).toBe(true);
      expect(loads).toEqual([]);
    });

    it('opens a draft that exists only in the queue via `~<key>`', async () => {
      const { loads, load } = loader();
      const { c, queue } = setup({ load });
      await queue.addDraft(queued('1'), true);
      expect(await c.openDraft('k1', '~1')).toBe(true);
      expect(loads).toEqual([]);
      expect(c.current).toMatchObject({ text: 'My text', parked: '1', saved: null });
      expect(c.ref).toBe('k1/~1');
    });

    it('ends silently at `~<key>` without an entry: no server, no toast', async () => {
      const { loads, load } = loader();
      const { c } = setup({ load });
      expect(await c.openDraft('k1', '~gone')).toBe(false);
      expect(loads).toEqual([]);
      expect(c.current).toBeNull();
      expect(ui.toast).toBeNull();
    });

    it('opens in the account of the version if the address still names the previous one', async () => {
      const { c, queue } = setup();
      await queue.addDraft(queued('1', { account: 'k2', moved: { account: 'k1', id: 'd7' } }), true);
      expect(await c.openDraft('k1', 'd7')).toBe(true);
      expect(c.current).toMatchObject({ account: 'k2', saved: { account: 'k1', id: 'd7' }, parked: '1' });
    });

    it('queues the next version under the same key and the same `messageId`', async () => {
      const { c, queue } = setup();
      await queue.addDraft(queued('1', { replace: { account: 'k1', id: 'd7' } }), true);
      await c.openDraft('k1', 'd7');
      await retype(c, 'More still');
      expect(queue.drafts).toHaveLength(1);
      expect(queue.drafts[0]).toMatchObject({
        key: '1',
        replace: { account: 'k1', id: 'd7' },
        email: { messageId: 'm1@roedy.invalid' },
      });
      expect(queue.drafts[0]?.email.text).toMatch(/^More still/);
    });

    it('reports the new id to the opened session after opening', async () => {
      const { c, queue, link } = setup();
      await queue.addDraft(queued('1', { replace: { account: 'k1', id: 'd7' } }), true);
      await c.openDraft('k1', 'd7');
      link.up = true;
      await queue.replay();
      expect(c.current).toMatchObject({ saved: { account: 'k1', id: 'd1' }, parked: null });
    });

    it('leaves an already open version open', async () => {
      const { c, queue } = setup();
      await write(c, 'Text');
      const key = queue.drafts[0]?.key ?? '';
      const open = c.current;
      expect(await c.openDraft('k1', `~${key}`)).toBe(true);
      expect(c.current).toBe(open);
    });

    it('without a version it asks the server as before', async () => {
      const { loads, load } = loader();
      const { c } = setup({ load });
      expect(await c.openDraft('k1', 'd7')).toBe(false);
      expect(loads).toEqual(['d7']);
    });

    const att = part('B1', 'Plan.pdf');
    const fromStore: LoadedDraft = {
      from: { name: 'Anna Becker', email: 'k1@example.com' },
      to: [{ name: 'Ben', email: 'ben@example.com' }],
      cc: [],
      bcc: [{ name: '', email: 'boss@example.com' }],
      subject: 'Saved',
      text: 'From storage',
      receivedAt: NOW - 3_600_000,
      attachments: [att],
      inReplyTo: ['<a@example.com>'],
      references: ['<a@example.com>'],
      keywords: { $flagged: true },
      mailboxIds: ['tag1'],
    };

    it('without a response it opens the draft from the message storage; writing on queues up', async () => {
      const asked: string[] = [];
      const { c, queue } = setup({ load: () => Promise.reject(noAnswer()) }, (account, id) => {
        asked.push(`${account}/${id}`);
        return Promise.resolve(fromStore);
      });
      expect(await c.openDraft('k1', 'd7')).toBe(true);
      expect(asked).toEqual(['k1/d7']);
      expect(c.current).toMatchObject({
        account: 'k1',
        subject: 'Saved',
        text: 'From storage',
        bcc: [{ email: 'boss@example.com' }],
        saved: { account: 'k1', id: 'd7' },
        parked: null,
        dirty: false,
        atts: [{ name: 'Plan.pdf', blob: { account: 'k1', part: att } }],
      });
      expect(c.ref).toBe('k1/d7');
      await retype(c, 'Continue');
      expect(queue.drafts).toHaveLength(1);
      // Attachments, references, star and tags go with the version.
      expect(queue.drafts[0]).toMatchObject({
        replace: { account: 'k1', id: 'd7' },
        email: {
          bcc: [{ email: 'boss@example.com' }],
          attachments: [att],
          references: ['<a@example.com>'],
          keywords: { $flagged: true },
          mailboxIds: ['tag1'],
        },
      });
      expect(queue.drafts[0]?.email.text).toMatch(/^Continue/);
    });

    it('also falls back to storage on 502 to 504; a failing storage leaves the error in place', async () => {
      const gateway = setup({ load: () => Promise.reject(new JmapError('status', { status: 503 })) }, () =>
        Promise.resolve(fromStore),
      );
      expect(await gateway.c.openDraft('k1', 'd7')).toBe(true);
      expect(gateway.c.current?.text).toBe('From storage');
      const broken = setup({ load: () => Promise.reject(noAnswer()) }, () => Promise.reject(new Error('IndexedDB')));
      expect(await broken.c.openDraft('k1', 'd7')).toBe(false);
      expect(ui.toast).toMatchObject({ text: 'No connection. Please try again.', error: true });
    });

    it('if the draft is missing in storage, the toast "No connection" stays', async () => {
      const { c } = setup({ load: () => Promise.reject(noAnswer()) }, () => Promise.resolve(null));
      expect(await c.openDraft('k1', 'd7')).toBe(false);
      expect(c.current).toBeNull();
      expect(ui.toast).toMatchObject({ text: 'No connection. Please try again.', error: true });
    });

    it('with a response from the server it counts, not the storage', async () => {
      const asked: string[] = [];
      const stored: StoredDraft = (account, id) => {
        asked.push(`${account}/${id}`);
        return Promise.resolve(fromStore);
      };
      const gone = setup({}, stored);
      expect(await gone.c.openDraft('k1', 'd7')).toBe(false);
      const failed = setup({ load: () => Promise.reject(new ComposeError('Email/get')) }, stored);
      expect(await failed.c.openDraft('k1', 'd7')).toBe(false);
      expect(asked).toEqual([]);
    });
  });
});

describe('storedDraft', () => {
  const NOW_AT = Date.UTC(2026, 10, 11, 9, 0, 0);
  const email = (patch: Partial<MessageEmail> = {}): MessageEmail => ({
    id: 'd7',
    blobId: 'b7',
    threadId: 't7',
    mailboxIds: ['dr', 'tag1'],
    keywords: { $draft: true, $seen: true, $flagged: true },
    receivedAt: NOW_AT,
    from: [{ name: 'Anna', email: 'k1@example.com' }],
    to: [{ name: 'Ben', email: 'ben@example.com' }],
    cc: [],
    bcc: [{ name: null, email: 'boss@example.com' }],
    replyTo: [],
    messageId: ['x@roedy.invalid'],
    inReplyTo: [],
    references: [],
    subject: 'Subject',
    preview: 'Text',
    hasAttachment: true,
    textBody: [
      {
        partId: '1',
        blobId: 'b1',
        size: 4,
        name: null,
        type: 'text/plain',
        charset: 'utf-8',
        disposition: null,
        cid: null,
      },
    ],
    htmlBody: [],
    attachments: [
      {
        partId: '2',
        blobId: 'B1',
        size: 10,
        name: 'Plan.pdf',
        type: 'application/pdf',
        charset: null,
        disposition: 'attachment',
        cid: null,
      },
    ],
    bodyValues: { '1': { value: 'Text\r\nline', isEncodingProblem: false, isTruncated: false } },
    ...patch,
  });
  /** Conversations whose priority `useThread` has renewed. */
  let used: string[] = [];
  const store = (emails: MessageEmail[], account = 'k1') => ({
    useThread: (key: string) => void used.push(key),
    heads: (a: string) =>
      Promise.resolve(
        a === account
          ? [
              {
                key: 'h1',
                account,
                threadId: 't7',
                size: 1,
                usedAt: 0,
                mails: emails.map((e) => ({ id: e.id }) as SavedMail),
                refs: [],
              },
            ]
          : [],
      ),
    thread: (key: string) => Promise.resolve(key === 'h1' ? { key, account, threadId: 't7', emails } : null),
  });

  it('reads the draft via its conversation, without $draft and $seen, empty references as null', async () => {
    used = [];
    expect(await storedDraft(store([email()]), 'k1', 'd7')).toEqual({
      from: { name: 'Anna', email: 'k1@example.com' },
      to: [{ name: 'Ben', email: 'ben@example.com' }],
      cc: [],
      bcc: [{ name: '', email: 'boss@example.com' }],
      subject: 'Subject',
      text: 'Text\nline',
      receivedAt: NOW_AT,
      attachments: [email().attachments[0]],
      inReplyTo: null,
      references: null,
      keywords: { $flagged: true },
      mailboxIds: ['dr', 'tag1'],
    });
    // Opened, the conversation stays in storage longer, as in the reading view.
    expect(used).toEqual(['h1']);
  });

  it('takes only complete ones: without text, truncated, without known Bcc or elsewhere nothing', async () => {
    used = [];
    const cut = { '1': { value: 'Te', isEncodingProblem: false, isTruncated: true } };
    // Replacement characters instead of the original: the next save would make them the text.
    const garbled = { '1': { value: 'T\uFFFDxt', isEncodingProblem: true, isTruncated: false } };
    // An entry without a known `bcc`.
    const noBcc = email();
    delete noBcc.bcc;
    for (const e of [
      email({ miss: true, bodyValues: {} }),
      email({ bodyValues: cut }),
      email({ bodyValues: garbled }),
      // Without a value the text would count as empty, and the next save would overwrite the draft.
      email({ bodyValues: {} }),
      noBcc,
    ])
      expect(await storedDraft(store([e]), 'k1', 'd7')).toBeNull();
    expect(await storedDraft(store([email()]), 'k2', 'd7')).toBeNull();
    expect(await storedDraft(store([email({ id: 'd8' })]), 'k1', 'd7')).toBeNull();
    expect(await storedDraft(null, 'k1', 'd7')).toBeNull();
    expect(used).toEqual([]);
  });

  it('asks all heads that name the email (outdated head after a merge)', async () => {
    const mail = { id: 'd7' } as SavedMail;
    const two = {
      useThread: () => {},
      heads: () =>
        Promise.resolve(
          ['old', 'new'].map((key) => ({
            key,
            account: 'k1',
            threadId: key,
            size: 1,
            usedAt: 0,
            mails: [mail],
            refs: [],
          })),
        ),
      thread: (key: string) =>
        Promise.resolve({
          key,
          account: 'k1',
          threadId: key,
          emails: key === 'new' ? [email()] : [email({ id: 'd9' })],
        }),
    };
    expect(await storedDraft(two, 'k1', 'd7')).toMatchObject({ subject: 'Subject' });
  });

  it('skips an incomplete match if another head holds the email completely', async () => {
    const mail = { id: 'd7' } as SavedMail;
    const used: string[] = [];
    const two = {
      useThread: (key: string) => void used.push(key),
      heads: () =>
        Promise.resolve(
          ['old', 'new'].map((key) => ({
            key,
            account: 'k1',
            threadId: key,
            size: 1,
            usedAt: 0,
            mails: [mail],
            refs: [],
          })),
        ),
      thread: (key: string) =>
        Promise.resolve({
          key,
          account: 'k1',
          threadId: key,
          emails: [key === 'new' ? email() : email({ miss: true, bodyValues: {} })],
        }),
    };
    expect(await storedDraft(two, 'k1', 'd7')).toMatchObject({ subject: 'Subject', text: 'Text\nline' });
    expect(used).toEqual(['new']);
  });
});

describe('Reply and forward', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    accounts.list = [account('k1'), account('k2', { color: 3 })];
    prefs.values.defaultAccount = 'k1';
  });
  afterEach(() => {
    accounts.list = null;
    prefs.reset();
    ui.reset();
    network.simulated = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const part: EmailBodyPart = {
    partId: '2',
    blobId: 'b1',
    size: 10,
    headers: [],
    name: 'a.pdf',
    type: 'application/pdf',
    charset: null,
    disposition: 'attachment',
    cid: null,
    language: null,
    location: null,
    subParts: null,
  };
  const ctx: ReplyContext = {
    id: 'e1',
    to: [{ name: 'Ben Weber', email: 'ben@example.com' }],
    allTo: [{ name: 'Ben Weber', email: 'ben@example.com' }],
    allCc: [{ name: null, email: 'cara@example.com' }],
    hasAll: true,
    base: 'Plan',
    quote: { head: 'On Sunday Ben Weber wrote:', paras: ['Hello,', 'how are you?'] },
    inReplyTo: ['m1@example.com'],
    references: ['m0@example.com', 'm1@example.com'],
    attachments: [
      {
        partId: '2',
        blobId: 'b1',
        size: 10,
        name: 'a.pdf',
        type: 'application/pdf',
        charset: null,
        disposition: 'attachment',
        cid: null,
      },
    ],
  };
  const ret = { href: '/mailbox/k1/inbox/t1', label: 'Back to message' };

  it('prefills replies with recipient, "Re:", quote and references; without text no change', async () => {
    const { api, saves } = fakeApi();
    const c = new Compose(api);
    expect(c.start(replyInit(ctx, { mode: 'all', text: '', to: '' }, 'k1'), ret)).toBe(true);
    await settle();
    expect(c.current).toMatchObject({
      mode: 'all',
      to: [{ name: 'Ben Weber', email: 'ben@example.com' }],
      cc: [{ name: '', email: 'cara@example.com' }],
      showCc: true,
      subject: 'Re: Plan',
      dirty: false,
      atts: [],
    });
    const v = c.values(TIME)!;
    expect(v).toMatchObject({
      title: 'Reply all',
      ph: 'Write a message …',
      backLabel: 'Back to message',
      hasQuote: true,
      quoteHead: 'On Sunday Ben Weber wrote:',
      quoteParas: [{ t: 'Hello,' }, { t: 'how are you?' }],
      quoteOpen: false,
      quoteExp: 'false',
      quoteChevT: 'none',
      taAuto: true,
    });
    c.toggleQuote();
    expect(c.values(TIME)).toMatchObject({ quoteOpen: true, quoteExp: 'true', quoteChevT: 'rotate(180deg)' });
    // Without own text no autosave (`cmpFromReply`: dirty only with text).
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves).toHaveLength(0);
    c.setText('Sure!');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[0]?.email).toMatchObject({
      subject: 'Re: Plan',
      text: 'Sure!\n\n-- \nBest regards\nAnna\n\nOn Sunday Ben Weber wrote:\n> Hello,\n>\n> how are you?',
      inReplyTo: ['m1@example.com'],
      references: ['m0@example.com', 'm1@example.com'],
      attachments: [],
    });
  });

  it('text from the bar counts as a change right away; title per kind', async () => {
    const { api, saves } = fakeApi();
    const c = new Compose(api);
    c.start(replyInit(ctx, { mode: 'reply', text: 'Ja', to: '' }, 'k1'), ret);
    expect(c.current).toMatchObject({ dirty: true, cc: [], showCc: false });
    expect(c.values(TIME)?.title).toBe('Reply');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves).toHaveLength(1);
  });

  it('forwards with the attachments of the original, without upload and without references', async () => {
    const { api, saves, uploads } = fakeApi();
    const c = new Compose(api);
    c.start(replyInit(ctx, { mode: 'fwd', text: '', to: 'Dora <dora@example.com>' }, 'k1'), ret);
    await settle();
    expect(c.current).toMatchObject({
      to: [{ name: 'Dora', email: 'dora@example.com' }],
      subject: 'Fwd: Plan',
      extras: { inReplyTo: null, references: null },
    });
    expect(c.current?.atts).toMatchObject([
      { name: 'a.pdf', size: 10, blob: { account: 'k1', part: { blobId: 'b1' } } },
    ]);
    expect(c.values(TIME)).toMatchObject({
      title: 'Forward',
      ph: 'Add a message (optional)',
      hasQuote: true,
      atts: [{ name: 'a.pdf', up: false, failed: false }],
    });
    expect(uploads).toHaveLength(0);
    c.setText('FYI');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[0]?.email.attachments).toEqual([part]);
  });

  it('moves forwarded attachments on a switch of the account', async () => {
    const { api, uploads, downloads } = fakeApi();
    const c = new Compose(api);
    c.start(replyInit(ctx, { mode: 'fwd', text: '', to: '' }, 'k1'), ret);
    await settle();
    c.pickFrom('k2/');
    await settle();
    expect(downloads).toEqual([['k1', 'b1']]);
    expect(uploads.map((u) => u.account)).toEqual(['k2']);
  });

  it('opens a draft with a quote and splits it off behind the signature', async () => {
    const loaded: LoadedDraft = {
      from: { name: 'Anna Becker', email: 'k1@example.com' },
      to: [{ name: 'Ben', email: 'ben@example.com' }],
      cc: [],
      bcc: [],
      subject: 'Re: Plan',
      text: 'Sure!\n\n-- \nBest regards\nAnna\n\nOn Sunday Ben wrote:\n> Hello,\n>\n> how are you?',
      receivedAt: NOW - 60_000,
      attachments: [],
      inReplyTo: ['m1@example.com'],
      references: ['m1@example.com'],
      keywords: {},
      mailboxIds: ['dr'],
    };
    const { api, saves } = fakeApi({ load: () => Promise.resolve(loaded) });
    const c = new Compose(api);
    expect(await c.openDraft('k1', 'd7')).toBe(true);
    expect(c.current).toMatchObject({
      text: 'Sure!',
      sigOff: false,
      quote: { head: 'On Sunday Ben wrote:', paras: ['Hello,', 'how are you?'] },
    });
    c.setText('Sure, see you tomorrow!');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves[0]?.email.text).toBe(
      'Sure, see you tomorrow!\n\n-- \nBest regards\nAnna\n\nOn Sunday Ben wrote:\n> Hello,\n>\n> how are you?',
    );
  });

  it('sends from the bar without showing compose, undo opens it', async () => {
    const { api, sends } = fakeApi();
    const c = new Compose(api);
    const n = nav();
    expect(c.sendNow(replyInit(ctx, { mode: 'reply', text: 'Ja', to: '' }, 'k1'), ret, n, 'Reply sent')).toBe(true);
    expect(c.current).toBeNull();
    await settle();
    expect(sends).toHaveLength(1);
    expect(sends[0]?.email).toMatchObject({ subject: 'Re: Plan', inReplyTo: ['m1@example.com'] });
    expect(sends[0]?.sub.rcptTo).toEqual(['ben@example.com']);
    expect(ui.toast).toMatchObject({ text: 'Reply sent', undo: true });
    ui.toasts.undo();
    await settle();
    expect(n.reopen).toHaveBeenCalled();
    expect(c.current).toMatchObject({ mode: 'reply', text: 'Ja', ret });
  });

  it('names the reply even if the server rejects HOLDFOR', async () => {
    const error = { type: 'forbiddenMailFrom', description: '501 5.5.4 FUTURERELEASE extension has been disabled.' };
    const { api } = fakeApi({ send: () => Promise.resolve<SendResult>({ ok: false, email: 'd3', error }) });
    const c = new Compose(api);
    expect(c.sendNow(replyInit(ctx, { mode: 'reply', text: 'Ja', to: '' }, 'k1'), ret, nav(), 'Reply sent')).toBe(true);
    await settle();
    expect(ui.toast).toMatchObject({ text: 'Reply sent', undo: true });
  });

  it('moves forwarded attachments if the account of the message is missing', async () => {
    const { api, uploads, downloads } = fakeApi();
    const c = new Compose(api);
    c.start(replyInit(ctx, { mode: 'fwd', text: '', to: '' }, 'k9'), ret);
    await settle();
    // No account "k9": compose takes the default account, the blobs stay assigned to the message's account.
    expect(c.current?.account).toBe('k1');
    expect(c.current?.atts[0]?.blob?.account).toBe('k9');
    expect(downloads).toEqual([['k9', 'b1']]);
    expect(uploads.map((u) => u.account)).toEqual(['k1']);
  });

  it('if a check fails, nothing remains', async () => {
    const { api, saves, sends } = fakeApi();
    const c = new Compose(api);
    const n = nav();
    const lone = { ...ctx, to: [], allTo: [], allCc: [] };
    expect(c.sendNow(replyInit(lone, { mode: 'reply', text: 'Ja', to: '' }, 'k1'), ret, n, 'Reply sent')).toBe(false);
    expect(c.current).toBeNull();
    expect(ui.toast?.text).toBe('Please add at least one recipient');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves).toHaveLength(0);
    expect(sends).toHaveLength(0);
    expect(n.reopen).not.toHaveBeenCalled();
  });

  it('does not send without a connection, creates no draft and triggers the replay', async () => {
    const { api, saves, sends } = fakeApi();
    const replay = vi.fn(() => Promise.resolve([]));
    const c = new Compose(api, { attach: vi.fn(), replay } as unknown as EditQueue);
    const n = nav();
    network.simulated = true;
    expect(c.sendNow(replyInit(ctx, { mode: 'reply', text: 'Ja', to: '' }, 'k1'), ret, n, 'Reply sent')).toBe(false);
    expect(c.current).toBeNull();
    expect(ui.toast).toMatchObject({
      text: m.offline_reply(),
      error: true,
    });
    expect(replay).toHaveBeenCalledExactlyOnceWith(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS);
    expect(saves).toHaveLength(0);
    expect(sends).toHaveLength(0);
    expect(n.reopen).not.toHaveBeenCalled();
  });
});

describe('Recipient suggestions', () => {
  const person = (name: string, email: string) => ({ name, email });
  let ensure: MockInstance<() => Promise<void>>;
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    accounts.list = [account('k1'), account('k2', { color: 3 })];
    prefs.values.defaultAccount = 'k1';
    ensure = vi.spyOn(contacts, 'ensure').mockResolvedValue();
    contacts.list = mergeContacts(
      [{ at: 1, to: [person('Lea Fischer', 'lea@example.com'), person('', 'leon@example.com')] }],
      [
        person('Anna Becker', 'k1@example.com'),
        person('Alias', 'ALIAS@example.com'),
        person('Leo King', 'leo@team.test'),
      ],
    );
  });
  afterEach(() => {
    accounts.list = null;
    contacts.reset();
    prefs.reset();
    ui.reset();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function open() {
    const c = new Compose(fakeApi().api);
    c.start();
    await settle();
    return c;
  }
  const field = (c: Compose, i = 0) => c.values(TIME)?.fields[i];

  it('shows suggestions only in the focused field with input, without own addresses and chosen recipients', async () => {
    const c = await open();
    c.input('to', 'le');
    expect(field(c)).toMatchObject({ hasSug: false, sug: [] });
    c.focus('to');
    expect(ensure).toHaveBeenCalledOnce();
    expect(field(c)?.sug.map(({ avBg, avInk, ...x }) => ({ ...x, av: !!avBg && !!avInk }))).toEqual([
      { key: 'lea@example.com', name: 'Lea Fischer', email: 'lea@example.com', letter: 'LF', av: true, on: true },
      { key: 'leon@example.com', name: 'leon@example.com', email: '', letter: 'L', av: true, on: false },
      { key: 'leo@team.test', name: 'Leo King', email: 'leo@team.test', letter: 'LK', av: true, on: false },
    ]);
    expect(field(c)?.hasSug).toBe(true);
    // Own addresses (account, identity) are missing even with a matching input.
    c.input('to', 'example');
    expect(field(c)?.sug.map((x) => x.key)).toEqual(['lea@example.com', 'leon@example.com']);
    c.showCc();
    c.input('to', 'lea@example.com,');
    c.focus('cc');
    c.input('cc', 'le');
    expect(field(c, 0)?.hasSug).toBe(false);
    expect(field(c, 1)?.sug.map((x) => x.key)).toEqual(['leon@example.com', 'leo@team.test']);
    c.blur('cc');
    expect(field(c, 1)?.hasSug).toBe(false);
  });

  it('chooses in turn with ↑/↓ and takes over the chosen one with click, Enter or Tab', async () => {
    const c = await open();
    c.focus('to');
    c.input('to', 'le');
    const on = () => field(c)?.sug.findIndex((x) => x.on);
    c.moveSuggestion('to', -1);
    expect(on()).toBe(2);
    c.moveSuggestion('to', 1);
    expect(on()).toBe(0);
    c.moveSuggestion('to', 1);
    c.pickSuggestion('to');
    expect(c.current?.to).toEqual([person('', 'leon@example.com')]);
    expect(c.current).toMatchObject({ input: { to: '' }, sug: 0, dirty: true });
    expect(field(c)?.hasSug).toBe(false);
    c.input('to', 'Le');
    c.pickSuggestion('to', 1);
    expect(c.current?.to.map((r) => r.name)).toEqual(['', 'Leo King']);
    // A new input starts with the first again.
    c.moveSuggestion('to', 1);
    c.input('to', 'l');
    expect(on()).toBe(0);
    // Without suggestions nothing happens.
    c.input('to', 'xyz');
    c.moveSuggestion('to', 1);
    c.pickSuggestion('to');
    expect(c.current).toMatchObject({ sug: 0, input: { to: 'xyz' } });
    expect(c.current?.to).toHaveLength(2);
  });

  it('gives typed addresses the name of a known contact', async () => {
    const c = await open();
    c.input('to', 'LEA@example.com, "Own Name" <leo@team.test>; new@example.com,');
    expect(c.current?.to).toEqual([
      person('Lea Fischer', 'LEA@example.com'),
      person('Own Name', 'leo@team.test'),
      person('', 'new@example.com'),
    ]);
  });

  it('remembers the recipients on sending', async () => {
    const remember = vi.spyOn(contacts, 'remember');
    const c = await open();
    c.input('to', 'leo@team.test');
    c.setSubject('Hello');
    c.send({ leave: vi.fn(), reopen: vi.fn() });
    expect(remember).toHaveBeenCalledWith([person('Leo King', 'leo@team.test')]);
  });
});

describe('Scheduled: actions', () => {
  const loaded: LoadedDraft = {
    from: { name: 'Anna Becker', email: 'k1@example.com' },
    to: [{ name: 'Leo', email: 'leo@team.test' }],
    cc: [],
    bcc: [],
    subject: 'Report',
    text: 'Hello',
    receivedAt: NOW,
    attachments: [],
    inReplyTo: null,
    references: null,
    keywords: { $draft: true },
    mailboxIds: ['drafts'],
  };
  const PRIOR = {
    identityId: 'i1',
    envelope: {
      mailFrom: { email: 'k1@example.com', parameters: { HOLDUNTIL: '2026-11-02T07:00:00Z' } },
      rcptTo: [{ email: 'leo@team.test', parameters: null }],
    },
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    accounts.list = [account('k1')];
    prefs.values.tz = 'Europe/Berlin';
    prefs.values.tzAuto = false;
  });
  afterEach(() => {
    accounts.list = null;
    prefs.reset();
    ui.reset();
    vi.useRealTimers();
  });

  it('prefills the previous time after "Cancel send" as long as it applies (`planPre`)', async () => {
    const c = new Compose(fakeApi({ load: () => Promise.resolve(loaded) }).api);
    await c.openDraft('k1', 'p1', null, NOW + 2 * 3_600_000);
    expect(c.current?.later).toBe('2026-11-01T12:00');
    // In the past or beyond the limit (7 days) the field stays empty.
    await c.openDraft('k1', 'p2', null, NOW - 60_000);
    expect(c.current?.later).toBe('');
    await c.openDraft('k1', 'p3', null, NOW + 8 * 86_400_000);
    expect(c.current?.later).toBe('');
  });

  it('submits "Send now" with identity and envelope of the previous submission, with undo', async () => {
    const { api, submits, unsent } = fakeApi({ load: () => Promise.resolve(loaded) });
    const c = new Compose(api);
    const reopen = vi.fn();
    expect(await c.resend('k1', 'p1', PRIOR, reopen)).toBe(true);
    expect(submits).toEqual([
      {
        account: 'k1',
        email: 'p1',
        sub: { identity: 'i1', mailFrom: 'k1@example.com', rcptTo: ['leo@team.test'], holdFor: 10 },
        keepalive: false,
      },
    ]);
    expect(ui.toast).toMatchObject({ text: 'Message sent', undo: true });
    // Sent: the draft's address opens nothing until undo brings it back.
    expect(await c.openDraft('k1', 'p1')).toBe(false);
    ui.toasts.undo();
    await vi.waitFor(() => expect(reopen).toHaveBeenCalledOnce());
    expect(unsent).toEqual([['k1', 'sx', 'p1']]);
    expect(await c.openDraft('k1', 'p1')).toBe(true);
  });

  it('opens compose if the new submission fails; without an envelope without undo', async () => {
    const failing = fakeApi({
      submit: () => Promise.resolve({ ok: false, email: 'p1', error: { type: 'forbiddenFrom' } }),
    });
    const reopen = vi.fn();
    expect(await new Compose(failing.api).resend('k1', 'p1', PRIOR, reopen)).toBe(false);
    expect(reopen).toHaveBeenCalledOnce();
    expect(ui.toast).toMatchObject({
      text: m.compose_send_failed(),
      error: true,
    });
    const { api, submits } = fakeApi();
    expect(await new Compose(api).resend('k1', 'p1', { identityId: 'i1', envelope: null }, vi.fn())).toBe(true);
    expect(submits[0]?.sub).toMatchObject({ identity: 'i1', holdFor: null, envelope: null });
    expect(ui.toast).toMatchObject({ text: 'Message sent', undo: false });
  });
});
