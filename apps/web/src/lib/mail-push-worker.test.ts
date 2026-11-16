import { describe, expect, it, vi } from 'vitest';
import type { JmapClient } from '@roedy/jmap';
import { deviceClientId } from '#lib/mail-push-subscription.ts';
import { handleMailPush, workerClient, type MailWorker } from '#lib/mail-push-worker.ts';
import type { MailPushCopy, MailPushStore } from '#lib/mail-push-store.ts';
import { m } from '#lib/paraglide/messages.js';
import { MAIL_MESSAGE } from '#lib/push-message.ts';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const DAY = 86_400_000;
const ENDPOINT = 'https://push.test/m1';

const COPY: MailPushCopy = {
  quiet: { on: false, from: '22:00', to: '07:00', tz: 'Europe/Berlin' },
  accounts: { m1: 'user@example.com' },
  appName: 'Roedy Mail',
  lang: 'en',
};

const push = (ids: string[]) =>
  JSON.stringify({ '@type': 'EmailPush', accountId: 'a1', emails: ids.map((id) => ({ id, threadId: `t-${id}` })) });

interface Shown {
  title: string;
  options: NotificationOptions & { renotify?: boolean };
  closed?: boolean;
}

interface Setup {
  copy?: MailPushCopy | null;
  visible?: boolean;
  everyNotice?: boolean;
  renewedAt?: number;
  expires?: string;
  emails?: Record<string, unknown>[];
  load?: MailWorker['load'];
}

function setup(options: Setup = {}) {
  const shown: Shown[] = [];
  const post = vi.fn();
  const calls: string[] = [];
  const entry = {
    id: 'p1',
    deviceClientId: '',
    expires: options.expires ?? new Date(NOW + 6.5 * DAY).toISOString(),
  };
  const client = {
    call: vi.fn(async (method: string, args: Record<string, unknown>) => {
      calls.push(method);
      if (method === 'Email/get') {
        const ids = args.ids as string[];
        const emails =
          options.emails ?? ids.map((id) => ({ id, threadId: `t-${id}`, from: [{ name: `Sender ${id}` }] }));
        return { list: emails.filter((email) => ids.includes(email.id as string)) };
      }
      if (method === 'PushSubscription/get') {
        entry.deviceClientId = await deviceClientId(ENDPOINT);
        return { list: [entry] };
      }
      return {};
    }),
  } as unknown as JmapClient;
  const load = options.load ?? vi.fn(() => Promise.resolve(client));
  const markRenewed = vi.fn(() => Promise.resolve());
  const store: MailPushStore = {
    read: () => Promise.resolve(options.copy === undefined ? COPY : options.copy),
    write: () => Promise.resolve(),
    renewedAt: () => Promise.resolve(options.renewedAt ?? NOW),
    markRenewed,
    clear: () => Promise.resolve(),
  };
  const show = vi.fn((title: string, shownOptions: Shown['options']) => {
    const index = shown.findIndex((item) => item.options.tag === shownOptions.tag);
    if (index >= 0) shown.splice(index, 1);
    shown.push({ title, options: shownOptions });
    return Promise.resolve();
  });
  const registration = {
    pushManager: { getSubscription: () => Promise.resolve({ endpoint: ENDPOINT }) },
    showNotification: show,
    getNotifications: vi.fn(({ tag }: { tag: string }) =>
      Promise.resolve(
        shown
          .filter((item) => item.options.tag === tag)
          .map((item) => ({
            data: item.options.data as unknown,
            close: () => {
              shown.splice(shown.indexOf(item), 1);
            },
          })),
      ),
    ),
  } as unknown as MailWorker['registration'];
  const worker: MailWorker = {
    clients: {
      matchAll: () => Promise.resolve([{ visibilityState: options.visible ? 'visible' : 'hidden', postMessage: post }]),
    },
    registration,
    appName: 'app.test',
    everyNotice: options.everyNotice ?? false,
    load,
    store,
    now: NOW,
  };
  return { worker, shown, show, post, calls, load, markRenewed };
}

describe('new mail in the service worker', () => {
  it('fetches sender and subject and shows the mail', async () => {
    const { worker, shown, calls } = setup({
      emails: [{ id: 'e1', threadId: 't1', from: [{ name: ' ', email: 'anna@example.com' }], subject: 'Hello' }],
    });
    await handleMailPush('m1', push(['e1']), worker);
    expect(calls).toEqual(['Email/get']);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      title: 'anna@example.com',
      options: { body: 'Hello', tag: 'mail-m1', data: { url: '/mailbox/m1/inbox/t1' } },
    });
  });

  it('shows several mails of a push, newest first', async () => {
    const { worker, shown } = setup({
      emails: [
        { id: 'e1', threadId: 't1', from: [{ name: 'Otto' }], receivedAt: '2026-11-06T10:00:00Z' },
        { id: 'e2', threadId: 't2', from: [{ name: 'Nina' }], receivedAt: '2026-11-06T11:00:00Z' },
      ],
    });
    await handleMailPush('m1', push(['e1', 'e2']), worker);
    expect(shown[0]).toMatchObject({ title: '2 new emails', options: { body: 'From Nina and Otto' } });
  });

  it('includes the notification still open, also with closely following pushes', async () => {
    const { worker, shown } = setup();
    await handleMailPush('m1', push(['e1']), worker);
    await Promise.all([handleMailPush('m1', push(['e2']), worker), handleMailPush('m1', push(['e3']), worker)]);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.title).toBe('3 new emails');
    expect(shown[0]?.options.body).toBe('From Sender e3, Sender e2, and one other');
  });

  it('reports the new mail to open windows', async () => {
    const { worker, post } = setup();
    await handleMailPush('m1', push(['e1']), worker);
    expect(post).toHaveBeenCalledWith({ type: MAIL_MESSAGE, accountId: 'm1' });
  });

  it('stays silent during quiet hours', async () => {
    const quiet = { on: true, from: '10:00', to: '14:00', tz: 'UTC' };
    const { worker, shown } = setup({ copy: { ...COPY, quiet } });
    await handleMailPush('m1', push(['e1']), worker);
    expect(shown[0]?.options.silent).toBe(true);
  });

  it('names the account with several accounts', async () => {
    const accounts = { m1: 'user@example.com', m2: 'second@example.com' };
    const { worker, shown } = setup({ copy: { ...COPY, accounts } });
    await handleMailPush('m1', push(['e1']), worker);
    expect(shown[0]?.options.body).toContain('\nuser@example.com');
  });
});

describe('without fetching', () => {
  it('shows only the account without a session', async () => {
    const { worker, shown } = setup({ load: () => Promise.reject(new Error('401')) });
    await handleMailPush('m1', push(['e1']), worker);
    expect(shown[0]).toMatchObject({ title: 'New email', options: { body: 'user@example.com' } });
  });

  it('writes in the app language, otherwise in the base language', async () => {
    const reject = () => Promise.reject(new Error('401'));
    const de = setup({ copy: { ...COPY, lang: 'de' }, load: reject });
    await handleMailPush('m1', push(['e1']), de.worker);
    expect(de.shown[0]).toMatchObject({
      title: m.mailpush_one({}, { locale: 'de' }),
      options: { body: 'user@example.com' },
    });
    expect(de.shown[0]?.title).not.toBe('New email');
    const unknown = setup({ copy: { ...COPY, lang: 'fr' }, load: reject });
    await handleMailPush('m1', push(['e1']), unknown.worker);
    expect(unknown.shown[0]?.title).toBe('New email');
  });

  it('works without a copy from the app', async () => {
    const { worker, shown } = setup({ copy: null, load: () => Promise.reject(new Error('401')) });
    await handleMailPush('m1', push(['e1']), worker);
    expect(shown[0]).toMatchObject({ title: 'New email', options: { body: 'app.test', silent: false } });
  });

  it('shows something even if the mail is already gone or the push unreadable', async () => {
    const empty = setup({ emails: [] });
    await handleMailPush('m1', push(['e1']), empty.worker);
    expect(empty.shown[0]?.title).toBe('New email');
    const unread = setup();
    await handleMailPush('m1', null, unread.worker);
    expect(unread.shown[0]?.title).toBe('New email');
    expect(unread.calls).toEqual([]);
  });

  it('keeps the open notification on an empty fetch', async () => {
    const { worker, shown } = setup();
    await handleMailPush('m1', push(['e1']), worker);
    await handleMailPush('m1', push([]), worker);
    expect(shown[0]?.title).toBe('Sender e1');
  });
});

describe('sign-in required', () => {
  it('leads to the connection after `needs_reauth` from the broker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{"error":"needs_reauth"}', { status: 409 }))),
    );
    const { worker, shown } = setup({ load: workerClient });
    await handleMailPush('m1', push(['e1']), worker);
    vi.unstubAllGlobals();
    expect(shown[0]).toMatchObject({
      title: 'Sign-in required',
      options: { tag: 'mail-auth-m1', data: { url: '/account/mail-accounts/m1/connection' } },
    });
  });

  it('stays without content on other rejections by the broker', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{"error":"blocked"}', { status: 409 }))),
    );
    const { worker, shown } = setup({ load: workerClient });
    await handleMailPush('m1', push(['e1']), worker);
    vi.unstubAllGlobals();
    expect(shown[0]?.title).toBe('New email');
  });
});

describe('visible app', () => {
  it('shows nothing and fetches nothing, the windows sync themselves', async () => {
    const { worker, shown, post, load } = setup({ visible: true });
    await handleMailPush('m1', push(['e1']), worker);
    expect(shown).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith({ type: MAIL_MESSAGE, accountId: 'm1' });
  });

  it('briefly shows a silent notification under WebKit, otherwise it would revoke the subscription', async () => {
    const { worker, shown, show } = setup({ visible: true, everyNotice: true });
    await handleMailPush('m1', push(['e1']), worker);
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0]?.[1]).toMatchObject({ tag: 'mail-m1-seen', silent: true });
    expect(shown).toEqual([]);
  });
});

describe('renewing the expiry', () => {
  const OLD = NOW - 2 * DAY;

  it('renews at most once a day and only when needed', async () => {
    const today = setup();
    await handleMailPush('m1', push(['e1']), today.worker);
    expect(today.calls).not.toContain('PushSubscription/get');

    const fresh = setup({ renewedAt: OLD });
    await handleMailPush('m1', push(['e1']), fresh.worker);
    expect(fresh.calls).toContain('PushSubscription/get');
    expect(fresh.calls).not.toContain('PushSubscription/set');
    expect(fresh.markRenewed).toHaveBeenCalledWith('m1', NOW);

    const due = setup({ renewedAt: OLD, expires: new Date(NOW + DAY).toISOString() });
    await handleMailPush('m1', push(['e1']), due.worker);
    expect(due.calls).toContain('PushSubscription/set');
  });

  it('renews even with the app visible', async () => {
    const { worker, calls } = setup({ visible: true, renewedAt: OLD, expires: new Date(NOW + DAY).toISOString() });
    await handleMailPush('m1', push(['e1']), worker);
    expect(calls).toContain('PushSubscription/set');
  });

  it('leaves expired entries alone and fetches the token only once', async () => {
    const { worker, calls, load } = setup({ renewedAt: OLD, expires: new Date(NOW - 1000).toISOString() });
    await handleMailPush('m1', push(['e1']), worker);
    expect(calls).not.toContain('PushSubscription/set');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('shows the mail even if renewing fails', async () => {
    const { worker, shown } = setup({ renewedAt: OLD });
    worker.registration.pushManager.getSubscription = () => Promise.reject(new Error('gone'));
    await handleMailPush('m1', push(['e1']), worker);
    expect(shown[0]?.title).toBe('Sender e1');
  });
});
