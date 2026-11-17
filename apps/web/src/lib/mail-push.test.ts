import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JmapClient, type Invocation, type JmapPushSubscription } from '@roedy/jmap';
import {
  createEntry,
  deviceClientId,
  isExpired,
  mailPushAccount,
  mailPushScope,
  ownEntries,
  renewIfDue,
  serverKey,
  VERIFIED_MESSAGE,
} from '#lib/mail-push-subscription.ts';
import { handleMailPush, handleSubscriptionChange, workerClient, type LoadClient } from '#lib/mail-push-worker.ts';
import type { MailPushCopy, MailPushStore } from '#lib/mail-push-store.ts';
import { MAIL_PUSH_KEY, MailPush, type MailPushEnv } from '#lib/mail-push.svelte.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { base64UrlBytes } from '#lib/push-keys.ts';

const CORE = 'urn:ietf:params:jmap:core';
const MAIL = 'urn:ietf:params:jmap:mail';
const VAPID = 'urn:ietf:params:jmap:webpush-vapid';
const EMAIL_PUSH = 'urn:ietf:params:jmap:emailpush';
const SERVER = 'https://mail.example.com';
const KEY = 'BAECAwQ';
const OTHER_KEY = 'BAUGBwg';
const NOW = Date.parse('2026-11-06T12:00:00Z');
const DAY = 86_400_000;

interface Entry {
  id: string;
  deviceClientId: string;
  url: string;
  verificationCode: null;
  expires: string;
  types: string[];
  emailPush?: unknown;
}

function sessionJson(
  capabilities: Record<string, unknown> = { [VAPID]: { applicationServerKey: KEY }, [EMAIL_PUSH]: {} },
) {
  return {
    capabilities: { [CORE]: {}, [MAIL]: {}, ...capabilities },
    accounts: { a1: { name: 'user@example.com', isPersonal: true, isReadOnly: false, accountCapabilities: {} } },
    primaryAccounts: { [MAIL]: 'a1' },
    username: 'user@example.com',
    apiUrl: `${SERVER}/jmap/`,
    downloadUrl: `${SERVER}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
    uploadUrl: `${SERVER}/jmap/upload/{accountId}/`,
    eventSourceUrl: `${SERVER}/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}`,
    state: 's1',
  };
}

function readable(entry: Entry): Partial<Entry> {
  const copy: Partial<Entry> = { ...entry };
  delete copy.url;
  return copy;
}

/** Mail server behind `fetch`, as Stalwart shows it for `PushSubscription` (`url` only internally). */
function fakeMailServer(capabilities?: Record<string, unknown>) {
  const entries = new Map<string, Entry>();
  const seen: [string, Record<string, unknown>][] = [];
  const server = {
    entries,
    seen,
    down: false,
    /** After creating, before the response. */
    onCreate: null as ((id: string) => void) | null,
    names: () => seen.map(([name]) => name),
    client: null as unknown as JmapClient,
  };
  let next = 1;
  const answer = (name: string, args: Record<string, unknown>): Record<string, unknown> => {
    switch (name) {
      case 'Mailbox/query':
        return { accountId: 'a1', ids: ['inbox'] };
      case 'PushSubscription/get':
        // `url` and `keys` are not readable.
        return { list: [...entries.values()].map(readable), notFound: [] };
      default: {
        const created: Record<string, { id: string; expires: string }> = {};
        for (const [key, value] of Object.entries((args.create ?? {}) as Record<string, Entry>)) {
          const id = `p${next++}`;
          entries.set(id, { ...value, id, verificationCode: null });
          created[key] = { id, expires: value.expires };
          server.onCreate?.(id);
        }
        const updated: Record<string, null> = {};
        for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Partial<Entry>>)) {
          const entry = entries.get(id);
          if (entry) entries.set(id, { ...entry, ...patch, verificationCode: null });
          updated[id] = null;
        }
        const destroyed = (args.destroy ?? []) as string[];
        destroyed.forEach((id) => entries.delete(id));
        return { created, updated, destroyed };
      }
    }
  };
  const fetchImpl = (_input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    if (server.down) return Promise.reject(new TypeError('offline'));
    const { methodCalls } = JSON.parse(init.body as string) as { methodCalls: Invocation[] };
    const methodResponses = methodCalls.map(([name, args, id]) => {
      seen.push([name, args]);
      return [name, answer(name, args), id];
    });
    return Promise.resolve(Response.json({ methodResponses, sessionState: 's1' }));
  };
  server.client = new JmapClient({
    url: SERVER,
    tokens: { token: () => Promise.resolve('t1') },
    session: sessionJson(capabilities),
    fetch: fetchImpl,
  });
  return server;
}

function fakeSubscription(endpoint: string, key: string, onGone: () => void = () => {}) {
  return {
    endpoint,
    options: { applicationServerKey: base64UrlBytes(key).buffer, userVisibleOnly: true },
    toJSON: () => ({ endpoint, keys: { p256dh: 'p256', auth: 'secret' } }),
    unsubscribe: vi.fn(() => {
      onGone();
      return Promise.resolve(true);
    }),
  } as unknown as PushSubscription;
}

function fakeManager(endpoint: string, existing?: string) {
  const state: { subscription: PushSubscription | null; unsubscribed: number } = {
    subscription: null,
    unsubscribed: 0,
  };
  const gone = () => {
    state.subscription = null;
    state.unsubscribed++;
  };
  if (existing) state.subscription = fakeSubscription(endpoint, existing, gone);
  const subscribe = vi.fn((options: PushSubscriptionOptionsInit) => {
    const bytes = options.applicationServerKey as Uint8Array;
    const key = btoa(String.fromCharCode(...bytes))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    state.subscription = fakeSubscription(endpoint, key, gone);
    return Promise.resolve(state.subscription);
  });
  const manager = {
    getSubscription: () => Promise.resolve(state.subscription),
    subscribe,
  } as unknown as PushManager;
  return { manager, subscribe, state };
}

type FakeRegistration = ServiceWorkerRegistration & { unregister: ReturnType<typeof vi.fn> };

type FakeStore = MailPushStore & { copy: MailPushCopy | null; writes: number; clearFails: boolean };

/** Service worker storage in memory. */
function fakeStore(): FakeStore {
  const store: FakeStore = {
    copy: null,
    writes: 0,
    clearFails: false,
    read: () => Promise.resolve(store.copy),
    write: (copy) => {
      store.copy = copy;
      store.writes++;
      return Promise.resolve();
    },
    renewedAt: () => Promise.resolve(0),
    markRenewed: () => Promise.resolve(),
    clear: () => {
      if (store.clearFails) return Promise.resolve(false);
      store.copy = null;
      return Promise.resolve(true);
    },
  };
  return store;
}

interface FakeBrowser {
  allowed: boolean;
  /** Signed-in app user. */
  user: string | null;
  subscribed: boolean;
  updates: number;
  store: FakeStore;
  registrations: Map<string, FakeRegistration>;
  managers: Map<string, ReturnType<typeof fakeManager>>;
  add(scope: string, existing?: string): FakeRegistration;
  verified(accountId: string, subscriptionId: string): void;
  env: MailPushEnv;
}

/** Browser with registrations per scope and the messages of the service worker. */
function fakeBrowser(): FakeBrowser {
  const registrations = new Map<string, FakeRegistration>();
  const managers = new Map<string, ReturnType<typeof fakeManager>>();
  const handlers = new Set<(accountId: string, subscriptionId: string) => void>();
  // Like Web Locks: one account after the other, also across several tabs (`mailPushWith`).
  let lock: Promise<unknown> = Promise.resolve();
  const store = fakeStore();
  const browser: FakeBrowser = {
    allowed: true,
    user: 'u1',
    subscribed: true,
    updates: 0,
    store,
    registrations,
    managers,
    add(scope: string, existing?: string) {
      const manager = fakeManager(`https://push.test${scope}`, existing);
      const registration = {
        scope: `https://app.test${scope}`,
        pushManager: manager.manager,
        unregister: vi.fn(() => {
          registrations.delete(scope);
          return Promise.resolve(true);
        }),
        update: () => {
          browser.updates++;
          return Promise.resolve();
        },
      } as unknown as FakeRegistration;
      registrations.set(scope, registration);
      managers.set(scope, manager);
      return registration;
    },
    verified(accountId: string, subscriptionId: string) {
      for (const handler of handlers) handler(accountId, subscriptionId);
    },
    env: {
      allowed: () => browser.allowed,
      subscribed: () => Promise.resolve(browser.subscribed),
      register: (scope) => Promise.resolve(registrations.get(scope) ?? browser.add(scope)),
      registrations: () => Promise.resolve([...registrations.values()]),
      listen: (next) => {
        handlers.add(next);
        return () => handlers.delete(next);
      },
      exclusive: <T>(_name: string, task: () => Promise<T>) => {
        const run = lock.then(task, task);
        lock = run.catch(() => undefined);
        return run;
      },
      store,
      user: () => browser.user,
    },
  };
  return browser;
}

function mailPushWith(browser: FakeBrowser, wait = 20) {
  const module = new MailPush();
  module.env = browser.env;
  module.verifyWait = wait;
  return module;
}

const verified = () => JSON.parse(localStorage.getItem(MAIL_PUSH_KEY) ?? '{}') as Record<string, string | null>;

describe('scope of the registration', () => {
  it('leads from the mail account to the scope and back', () => {
    expect(mailPushScope('01H')).toBe('/mail-account-push/01H/');
    expect(mailPushAccount(mailPushScope('a/b c'))).toBe('a/b c');
    expect(mailPushAccount('https://app.test/mail-account-push/01H/')).toBe('01H');
  });

  it('does not know the app registration and foreign paths', () => {
    for (const scope of [
      'https://app.test/',
      'https://app.test/mail-account-push/',
      'https://app.test/mail-account-push/a/b/',
    ]) {
      expect(mailPushAccount(scope)).toBeNull();
    }
  });
});

describe('deviceClientId', () => {
  it('is stable, different per endpoint and does not reveal it', async () => {
    const id = await deviceClientId('https://push.test/abc');
    expect(id).toMatch(/^roedy-mail-[0-9a-f]{32}$/);
    expect(await deviceClientId('https://push.test/abc')).toBe(id);
    expect(await deviceClientId('https://push.test/abd')).not.toBe(id);
  });
});

describe('entry at the mail server', () => {
  it('names the key only with VAPID and emailPush', async () => {
    expect(await serverKey(fakeMailServer().client)).toBe(KEY);
    expect(await serverKey(fakeMailServer({ [VAPID]: { applicationServerKey: KEY } }).client)).toBeNull();
    expect(await serverKey(fakeMailServer({ [EMAIL_PUSH]: {} }).client)).toBeNull();
  });

  it('subscribes only to new mails in the inbox and only their IDs', async () => {
    const server = fakeMailServer();
    const id = await createEntry(server.client, fakeSubscription('https://push.test/a', KEY), NOW);
    expect(server.entries.get(id)).toMatchObject({
      deviceClientId: await deviceClientId('https://push.test/a'),
      url: 'https://push.test/a',
      keys: { p256dh: 'p256', auth: 'secret' },
      types: ['EmailDelivery'],
      emailPush: { a1: { filter: { inMailbox: 'inbox' }, properties: ['id', 'threadId'] } },
      expires: '2026-11-13T12:00:00Z',
    });
  });

  it('finds only entries of this subscription', async () => {
    const server = fakeMailServer();
    const id = await createEntry(server.client, fakeSubscription('https://push.test/a', KEY));
    await createEntry(server.client, fakeSubscription('https://push.test/b', KEY));
    expect((await ownEntries(server.client, 'https://push.test/a')).map((entry) => entry.id)).toEqual([id]);
  });

  it('recognizes expired entries', () => {
    const at = (expires: string | null) => ({ expires }) as JmapPushSubscription;
    expect(isExpired(at('2026-11-06T11:59:59Z'), NOW)).toBe(true);
    expect(isExpired(at('2026-11-06T12:00:01Z'), NOW)).toBe(false);
    expect(isExpired(at(null), NOW)).toBe(false);
  });

  it('renews only when less than six days remain', async () => {
    const server = fakeMailServer();
    const fresh = { expires: new Date(NOW + 6 * DAY + 1000).toISOString() };
    await renewIfDue(server.client, { id: 'p1', ...fresh } as never, NOW);
    expect(server.names()).toEqual([]);
    await renewIfDue(server.client, { id: 'p1', expires: new Date(NOW + DAY).toISOString() } as never, NOW);
    expect(server.seen).toEqual([['PushSubscription/set', { update: { p1: { expires: '2026-11-13T12:00:00Z' } } }]]);
  });
});

describe('service worker', () => {
  const windows = () => {
    const post = vi.fn();
    return {
      post,
      clients: { matchAll: vi.fn(() => Promise.resolve([{ visibilityState: 'hidden' as const, postMessage: post }])) },
    };
  };
  const worker = (clients: ReturnType<typeof windows>['clients'], load: LoadClient) => ({
    clients,
    registration: {} as ServiceWorkerRegistration,
    appName: 'app.test',
    everyNotice: false,
    load,
    store: fakeStore(),
  });

  it('confirms with the code from the push and reports it to the windows', async () => {
    const server = fakeMailServer();
    const { post, clients } = windows();
    const raw = JSON.stringify({ '@type': 'PushVerification', pushSubscriptionId: 'p1', verificationCode: 'c' });
    await handleMailPush(
      'm1',
      raw,
      worker(clients, () => Promise.resolve(server.client)),
    );
    expect(server.seen).toEqual([['PushSubscription/set', { update: { p1: { verificationCode: 'c' } } }]]);
    expect(clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true });
    expect(post).toHaveBeenCalledWith({ type: VERIFIED_MESSAGE, accountId: 'm1', subscriptionId: 'p1' });
  });

  it('reports nothing if the confirmation fails', async () => {
    const server = fakeMailServer();
    server.down = true;
    const { post, clients } = windows();
    const raw = JSON.stringify({ '@type': 'PushVerification', pushSubscriptionId: 'p1', verificationCode: 'c' });
    await expect(
      handleMailPush(
        'm1',
        raw,
        worker(clients, () => Promise.resolve(server.client)),
      ),
    ).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it('replaces the old entry after pushsubscriptionchange', async () => {
    const server = fakeMailServer();
    const old = await createEntry(server.client, fakeSubscription('https://push.test/old', KEY));
    const { manager } = fakeManager('https://push.test/new');
    const subscription = fakeSubscription('https://push.test/new', KEY);
    const load = () => Promise.resolve(server.client);
    await handleSubscriptionChange('m1', manager, { oldEndpoint: 'https://push.test/old', subscription }, load);
    expect(server.entries.has(old)).toBe(false);
    expect([...server.entries.values()].map((entry) => entry.url)).toEqual(['https://push.test/new']);
  });

  it('subscribes itself if the event names no new subscription', async () => {
    const server = fakeMailServer();
    const { manager, subscribe } = fakeManager('https://push.test/new');
    await handleSubscriptionChange('m1', manager, { oldEndpoint: null, subscription: null }, () =>
      Promise.resolve(server.client),
    );
    expect(subscribe).toHaveBeenCalledOnce();
    expect(server.entries.size).toBe(1);
  });

  it('leaves an account without a key alone', async () => {
    const server = fakeMailServer({});
    const { manager, subscribe } = fakeManager('https://push.test/new');
    await handleSubscriptionChange('m1', manager, { oldEndpoint: null, subscription: null }, () =>
      Promise.resolve(server.client),
    );
    expect(subscribe).not.toHaveBeenCalled();
    expect(server.names()).toEqual([]);
  });

  describe('workerClient', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('fetches token and session from the backend', async () => {
      const calls: [string, RequestInit | undefined][] = [];
      vi.stubGlobal('fetch', (path: string, init?: RequestInit) => {
        calls.push([path, init]);
        return Promise.resolve(Response.json({ accessToken: 't', expiresAt: null, session: sessionJson() }));
      });
      const client = await workerClient('m 1');
      expect(client.url).toBe(`${SERVER}/`);
      expect(client.currentSession?.apiUrl).toBe(`${SERVER}/jmap/`);
      const [path, init] = calls[0] ?? [];
      expect(path).toBe('/api/v1/mail-accounts/m%201/token');
      expect(init).toMatchObject({ credentials: 'same-origin', headers: { 'X-Requested-With': 'roedy-mail' } });
    });

    it('fails without a backend session', async () => {
      vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 })));
      await expect(workerClient('m1')).rejects.toThrow('401');
    });

    it('fails if the response contains no JMAP session', async () => {
      vi.stubGlobal('fetch', () => Promise.resolve(Response.json({ accessToken: 't', expiresAt: null })));
      await expect(workerClient('m1')).rejects.toThrow('session');
    });
  });
});

describe('mailPush', () => {
  const SCOPE = mailPushScope('m1');
  let server: ReturnType<typeof fakeMailServer>;
  let browser: FakeBrowser;
  let clientSpy: ReturnType<typeof vi.fn>;
  let ensureSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    server = fakeMailServer();
    browser = fakeBrowser();
    clientSpy = vi.spyOn(accounts, 'client').mockImplementation(() => Promise.resolve(server.client));
    ensureSpy = vi.spyOn(accounts, 'ensure').mockResolvedValue();
    vi.spyOn(accounts, 'get').mockImplementation((id) => (id === 'm1' ? ({ id } as MailAccount) : undefined));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Turning on with a service worker that confirms immediately. */
  async function enabled(module: MailPush) {
    server.onCreate = (id) => browser.verified('m1', id);
    const status = await module.enable('m1');
    server.onCreate = null;
    server.seen.length = 0;
    return status;
  }

  it('sets up registration, subscription and entry and waits for the confirmation', async () => {
    const module = mailPushWith(browser, 1000);
    const pending = module.enable('m1');
    await vi.waitFor(() => expect(server.entries.size).toBe(1));
    expect(module.of('m1')).toBe('pending');
    const [id] = [...server.entries.keys()];
    browser.verified('m1', id as string);
    expect(await pending).toBe('on');
    expect(module.of('m1')).toBe('on');
    expect(verified()).toEqual({ m1: id });
    expect(browser.registrations.has(SCOPE)).toBe(true);
  });

  it('accepts a confirmation that arrives before the response to create', async () => {
    expect(await enabled(mailPushWith(browser, 1000))).toBe('on');
  });

  it('cleans up if no confirmation arrives', async () => {
    const module = mailPushWith(browser);
    expect(await module.enable('m1')).toBe('failed');
    expect(module.of('m1')).toBe('failed');
    expect(server.entries.size).toBe(0);
    expect(browser.registrations.size).toBe(0);
    expect(verified()).toEqual({});
  });

  it('cleans up if the mail server rejects', async () => {
    const module = mailPushWith(browser);
    server.down = true;
    clientSpy.mockRejectedValueOnce(new Error('needs_reauth'));
    expect(await module.enable('m1')).toBe('failed');
    expect(browser.registrations.size).toBe(0);
  });

  it('reports a mail server without a key', async () => {
    server = fakeMailServer({});
    const module = mailPushWith(browser);
    expect(await module.enable('m1')).toBe('unsupported');
    expect(browser.registrations.size).toBe(0);
    expect(server.names()).toEqual([]);
  });

  it('does not ask the mail server without permission', async () => {
    browser.allowed = false;
    const module = mailPushWith(browser);
    expect(await module.enable('m1')).toBe('off');
    expect(clientSpy).not.toHaveBeenCalled();
  });

  it('starts only one setup per account', async () => {
    const module = mailPushWith(browser, 1000);
    server.onCreate = (id) => browser.verified('m1', id);
    const [first, second] = await Promise.all([module.enable('m1'), module.enable('m1')]);
    expect([first, second]).toEqual(['on', 'on']);
    expect(server.entries.size).toBe(1);
  });

  it('replaces a browser subscription with a different key', async () => {
    browser.add(SCOPE, OTHER_KEY);
    await enabled(mailPushWith(browser, 1000));
    expect(browser.managers.get(SCOPE)?.state.unsubscribed).toBe(1);
    expect(browser.managers.get(SCOPE)?.subscribe).toHaveBeenCalledOnce();
  });

  describe('resume', () => {
    it('does nothing without registrations', async () => {
      await mailPushWith(browser).resume();
      expect(ensureSpy).not.toHaveBeenCalled();
    });

    it('leaves a fresh entry alone', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      await mailPushWith(browser).resume();
      expect(server.names()).toEqual(['PushSubscription/get']);
    });

    it('renews an entry that expires soon', async () => {
      await enabled(mailPushWith(browser, 1000));
      const [id, entry] = [...server.entries.entries()][0] ?? [];
      server.entries.set(id as string, { ...(entry as Entry), expires: new Date(Date.now() + DAY).toISOString() });
      const later = mailPushWith(browser);
      await later.resume();
      expect(later.of('m1')).toBe('on');
      expect(server.names()).toEqual(['PushSubscription/get', 'PushSubscription/set']);
      expect(Date.parse(server.entries.get(id as string)?.expires ?? '')).toBeGreaterThan(Date.now() + 6 * DAY);
    });

    it('replaces an expired entry that get still shows', async () => {
      await enabled(mailPushWith(browser, 1000));
      const [id, entry] = [...server.entries.entries()][0] ?? [];
      server.entries.set(id as string, { ...(entry as Entry), expires: new Date(Date.now() - 1000).toISOString() });
      const later = mailPushWith(browser, 1000);
      server.onCreate = (created) => browser.verified('m1', created);
      await later.resume();
      expect(later.of('m1')).toBe('on');
      expect(server.entries.has(id as string)).toBe(false);
      expect(server.entries.size).toBe(1);
    });

    it('checks at start whether there is a new service worker', async () => {
      await enabled(mailPushWith(browser, 1000));
      await mailPushWith(browser).resume();
      expect(browser.updates).toBe(1);
    });

    it('leaves a hidden account alone, undo is still running', async () => {
      browser.add(SCOPE, KEY);
      vi.spyOn(accounts, 'isHidden').mockReturnValue(true);
      await mailPushWith(browser).resume();
      expect(browser.registrations.size).toBe(1);
      expect(clientSpy).not.toHaveBeenCalled();
    });

    it('creates an expired entry anew', async () => {
      await enabled(mailPushWith(browser, 1000));
      server.entries.clear();
      const later = mailPushWith(browser, 1000);
      server.onCreate = (id) => browser.verified('m1', id);
      await later.resume();
      expect(later.of('m1')).toBe('on');
      expect(server.entries.size).toBe(1);
    });

    it('replaces an entry without a record', async () => {
      await enabled(mailPushWith(browser, 1000));
      const [old] = [...server.entries.keys()];
      localStorage.removeItem(MAIL_PUSH_KEY);
      const later = mailPushWith(browser, 1000);
      server.onCreate = (id) => browser.verified('m1', id);
      await later.resume();
      expect(server.entries.has(old as string)).toBe(false);
      expect(server.entries.size).toBe(1);
    });

    it('counts a confirmation without anyone waiting, but only for selected accounts', async () => {
      const module = mailPushWith(browser);
      await module.resume();
      localStorage.setItem(MAIL_PUSH_KEY, JSON.stringify({ m2: null }));
      browser.verified('m2', 'p9');
      browser.verified('m3', 'p8');
      expect(verified()).toEqual({ m2: 'p9' });
    });

    it('removes registrations of unknown accounts only on the device', async () => {
      browser.add(mailPushScope('foreign'), KEY);
      localStorage.setItem(MAIL_PUSH_KEY, '{"foreign":"p1"}');
      await mailPushWith(browser).resume();
      expect(browser.registrations.size).toBe(0);
      expect(verified()).toEqual({});
      expect(clientSpy).not.toHaveBeenCalled();
    });

    it('unsubscribes if the permission is missing', async () => {
      await enabled(mailPushWith(browser, 1000));
      browser.allowed = false;
      const later = mailPushWith(browser);
      await later.resume();
      expect(server.entries.size).toBe(0);
      expect(browser.registrations.size).toBe(0);
      expect(later.of('m1')).toBe('off');
    });

    it('stays silent if the accounts do not load', async () => {
      browser.add(SCOPE, KEY);
      ensureSpy.mockRejectedValue(new Error('offline'));
      await expect(mailPushWith(browser).resume()).resolves.toBeUndefined();
      expect(browser.registrations.size).toBe(1);
    });

    it('keeps the registration if the mail server is currently missing', async () => {
      await enabled(mailPushWith(browser, 1000));
      server.down = true;
      const later = mailPushWith(browser);
      await later.resume();
      expect(later.of('m1')).toBe('expired');
      expect(browser.registrations.size).toBe(1);
      expect(Object.keys(verified())).toEqual(['m1']);
    });
  });

  describe('selection and channel', () => {
    it('remembers the selection when turning on, loses it when turning off', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      expect(Object.keys(verified())).toEqual(['m1']);
      await module.disable('m1');
      expect(verified()).toEqual({});
    });

    it('shows turning off as a state of its own', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      const done = module.disable('m1');
      expect(module.of('m1')).toBe('stopping');
      await done;
      expect(module.of('m1')).toBe('off');
    });

    it('unsubscribes everything with the channel off, the selection stays', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      await module.pause();
      expect(server.entries.size).toBe(0);
      expect(browser.registrations.size).toBe(0);
      expect(module.of('m1')).toBe('off');
      expect(verified()).toEqual({ m1: null });
    });

    it('turns the selection on again when the channel is back', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      await module.pause();
      server.onCreate = (id) => browser.verified('m1', id);
      await module.restore();
      expect(module.of('m1')).toBe('on');
      expect(server.entries.size).toBe(1);
      expect(browser.registrations.size).toBe(1);
    });

    it('waits for the list of accounts when restoring', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      await module.pause();
      let loaded = false;
      vi.spyOn(accounts, 'ensure').mockImplementation(() => {
        loaded = true;
        return Promise.resolve();
      });
      vi.spyOn(accounts, 'get').mockImplementation((id) =>
        loaded && id === 'm1' ? ({ id } as MailAccount) : undefined,
      );
      server.onCreate = (id) => browser.verified('m1', id);
      await module.restore();
      expect(module.of('m1')).toBe('on');
    });

    it('waits for a running turn-off when restoring', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      const pausing = module.pause();
      server.onCreate = (id) => browser.verified('m1', id);
      const restoring = module.restore();
      await Promise.all([pausing, restoring]);
      expect(module.of('m1')).toBe('on');
      expect(browser.registrations.size).toBe(1);
      expect(server.entries.size).toBe(1);
    });

    it('also stops a setup that has no registration yet when turning off', async () => {
      const module = mailPushWith(browser, 1000);
      let release = () => {};
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(accounts, 'client').mockImplementation(() => waiting.then(() => server.client));
      const enabling = module.enable('m1');
      expect(module.of('m1')).toBe('pending');
      const pausing = module.pause();
      release();
      await Promise.all([enabling, pausing]);
      expect(server.entries.size).toBe(0);
      expect(browser.registrations.size).toBe(0);
      expect(module.of('m1')).toBe('off');
      expect(verified()).toEqual({ m1: null });
    });

    it('leaves running accounts alone when restoring', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      const created = server.seen.length;
      await module.restore();
      expect(server.seen).toHaveLength(created);
    });

    it('rebuilds a selection without a registration at start', async () => {
      localStorage.setItem(MAIL_PUSH_KEY, JSON.stringify({ m1: null }));
      server.onCreate = (id) => browser.verified('m1', id);
      const module = mailPushWith(browser, 1000);
      await module.resume();
      expect(module.of('m1')).toBe('on');
      expect(browser.registrations.size).toBe(1);
    });

    it('unsubscribes at start if the channel is off, and keeps the selection', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      browser.allowed = false;
      const later = mailPushWith(browser, 1000);
      await later.resume();
      expect(browser.registrations.size).toBe(0);
      expect(later.of('m1')).toBe('off');
      expect(verified()).toEqual({ m1: null });
    });

    it('unsubscribes at start if this device has turned off push', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      browser.subscribed = false;
      await mailPushWith(browser, 1000).resume();
      expect(browser.registrations.size).toBe(0);
      expect(verified()).toEqual({ m1: null });
    });

    it('tears nothing down if it is unclear whether the device is still subscribed', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      browser.env.subscribed = () => Promise.reject(new Error('locked'));
      await mailPushWith(browser, 1000).resume();
      expect(browser.registrations.size).toBe(1);
    });

    it('forgets the selection of unknown accounts', async () => {
      localStorage.setItem(MAIL_PUSH_KEY, JSON.stringify({ foreign: null }));
      await mailPushWith(browser, 1000).resume();
      expect(verified()).toEqual({});
    });

    it('stays expired if turning on again fails', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      server.down = true;
      const later = mailPushWith(browser, 5);
      await later.resume();
      expect(later.of('m1')).toBe('expired');
      expect(await later.enable('m1')).toBe('failed');
      expect(later.of('m1')).toBe('expired');
      expect(Object.keys(verified())).toEqual(['m1']);
      server.down = false;
      server.onCreate = (id) => browser.verified('m1', id);
      expect(await mailPushWith(browser, 1000).enable('m1')).toBe('on');
    });

    it('turns nothing on without permission and remembers nothing', async () => {
      browser.allowed = false;
      const module = mailPushWith(browser, 1000);
      expect(await module.enable('m1')).toBe('off');
      expect(verified()).toEqual({});
    });
  });

  describe('server without push', () => {
    it('shows it when opening the page without creating anything', async () => {
      const module = mailPushWith(browser);
      server = fakeMailServer({});
      await module.inspect(['m1']);
      expect(module.of('m1')).toBe('unsupported');
      expect(browser.registrations.size).toBe(0);
    });

    it('notices when the server has added push', async () => {
      const module = mailPushWith(browser);
      server = fakeMailServer({});
      await module.inspect(['m1']);
      server = fakeMailServer();
      await module.inspect(['m1']);
      expect(module.of('m1')).toBe('off');
    });

    it('leaves running accounts and silent servers alone', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      server = fakeMailServer({});
      await module.inspect(['m1']);
      expect(module.of('m1')).toBe('on');
      clientSpy.mockRejectedValue(new Error('offline'));
      await module.inspect(['m2']);
      expect(module.of('m2')).toBe('off');
    });
  });

  describe('copy for the service worker', () => {
    const copy = {
      user: 'u1',
      quiet: { on: true, from: '22:00', to: '07:00', tz: 'UTC' },
      accounts: { m1: 'user@example.com' },
      appName: 'Roedy Mail',
      lang: 'en',
    };

    it('writes only once an account has push, and only changes', async () => {
      const module = mailPushWith(browser, 1000);
      module.share(copy);
      expect(browser.store.writes).toBe(0);
      await enabled(module);
      module.share(copy);
      module.share({ ...copy });
      expect(browser.store.writes).toBe(1);
      module.share({ ...copy, appName: 'Other Mail' });
      expect(browser.store.writes).toBe(2);
    });

    it('disappears as soon as no account has push anymore', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      module.share(copy);
      await module.disable('m1');
      module.share(copy);
      expect(browser.store.copy).toBeNull();
      await enabled(module);
      module.share(copy);
      expect(browser.store.copy).toEqual(copy);
    });

    it('disappears with the data of the device', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      module.share(copy);
      await module.clearDevice();
      expect(browser.store.copy).toBeNull();
    });

    it('stays for the notice without content when the session expires', async () => {
      const module = mailPushWith(browser, 1000);
      await enabled(module);
      module.share(copy);
      module.reset();
      expect(browser.store.copy).toEqual(copy);
    });

    it('removes the copy of the previous app user when the next one has no push', async () => {
      browser.store.copy = copy;
      browser.user = 'u2';
      const module = mailPushWith(browser, 1000);
      module.share({ ...copy, user: 'u2', accounts: { m2: 'other@example.com' } });
      await vi.waitFor(() => expect(browser.store.copy).toBeNull());
      expect(browser.store.writes).toBe(0);
    });

    it('removes the copy of the previous app user at start, also one without a user', async () => {
      browser.store.copy = copy;
      browser.user = 'u2';
      await mailPushWith(browser, 1000).resume();
      expect(browser.store.copy).toBeNull();
      const unbound: Partial<MailPushCopy> = { ...copy };
      delete unbound.user;
      browser.store.copy = unbound as MailPushCopy;
      await mailPushWith(browser, 1000).resume();
      expect(browser.store.copy).toBeNull();
    });

    it('tries again to remove the copy of the previous app user if deleting it failed', async () => {
      browser.store.copy = copy;
      browser.store.clearFails = true;
      browser.user = 'u2';
      const module = mailPushWith(browser, 1000);
      await module.resume();
      expect(browser.store.copy).toEqual(copy);
      browser.store.clearFails = false;
      await module.resume();
      expect(browser.store.copy).toBeNull();
    });

    it('keeps the copy of the same app user', async () => {
      browser.store.copy = copy;
      const module = mailPushWith(browser, 1000);
      await module.resume();
      module.share(copy);
      await Promise.resolve();
      expect(browser.store.copy).toEqual(copy);
    });
  });

  it('turns off: entry, subscription, registration, record', async () => {
    const module = mailPushWith(browser, 1000);
    await enabled(module);
    await module.disable('m1');
    expect(server.entries.size).toBe(0);
    expect(browser.managers.get(SCOPE)?.state.unsubscribed).toBe(1);
    expect(browser.registrations.size).toBe(0);
    expect(module.of('m1')).toBe('off');
    expect(verified()).toEqual({});
  });

  it('turns off even without a mail server', async () => {
    const module = mailPushWith(browser, 1000);
    await enabled(module);
    server.down = true;
    await module.disable('m1');
    expect(browser.registrations.size).toBe(0);
    expect(server.entries.size).toBe(1);
  });

  describe('browser', () => {
    function stubContainer(container: unknown) {
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container });
    }

    afterEach(() => {
      Reflect.deleteProperty(navigator, 'serviceWorker');
    });

    function installing() {
      const worker = new EventTarget() as ServiceWorker & { state: ServiceWorkerState };
      const registration = { active: null, installing: worker, waiting: null } as unknown as ServiceWorkerRegistration;
      stubContainer({ register: () => Promise.resolve(registration) });
      const env = new MailPush().env;
      const step = (state: ServiceWorkerState) => {
        worker.state = state;
        worker.dispatchEvent(new Event('statechange'));
      };
      return { env, registration, step };
    }

    it('waits for the active worker', async () => {
      const { env, registration, step } = installing();
      const done = env.register('/s/');
      await new Promise((resolve) => setTimeout(resolve));
      step('installed');
      step('activated');
      expect(await done).toBe(registration);
    });

    it('reports a worker that does not install', async () => {
      const { env, step } = installing();
      const done = env.register('/s/');
      await new Promise((resolve) => setTimeout(resolve));
      step('redundant');
      await expect(done).rejects.toThrow('not installed');
    });

    it('returns an already active registration immediately', async () => {
      const registration = { active: {} } as unknown as ServiceWorkerRegistration;
      stubContainer({ register: () => Promise.resolve(registration) });
      expect(await new MailPush().env.register('/s/')).toBe(registration);
    });

    it('accepts only complete messages of the service worker', () => {
      const container = new EventTarget();
      stubContainer(container);
      const handler = vi.fn();
      const stop = new MailPush().env.listen(handler);
      const send = (data: unknown) => container.dispatchEvent(new MessageEvent('message', { data }));
      send({ type: VERIFIED_MESSAGE, accountId: 'm1', subscriptionId: 'p1' });
      send({ type: VERIFIED_MESSAGE, accountId: 'm1' });
      send({ type: 'other', accountId: 'm1', subscriptionId: 'p1' });
      send('text');
      expect(handler.mock.calls).toEqual([['m1', 'p1']]);
      stop();
      send({ type: VERIFIED_MESSAGE, accountId: 'm2', subscriptionId: 'p2' });
      expect(handler).toHaveBeenCalledOnce();
    });

    it('works without a service worker and without Web Locks', async () => {
      const env = new MailPush().env;
      expect(await env.registrations()).toEqual([]);
      expect(env.listen(() => {})).toBeTypeOf('function');
      expect(await env.exclusive('x', () => Promise.resolve(1))).toBe(1);
    });
  });

  it('removes the entries before signing out and the rest afterwards', async () => {
    const module = mailPushWith(browser, 1000);
    await enabled(module);
    await module.withdraw();
    expect(server.entries.size).toBe(0);
    expect(browser.registrations.size).toBe(1);
    await module.clearDevice();
    expect(browser.registrations.size).toBe(0);
    expect(localStorage.getItem(MAIL_PUSH_KEY)).toBeNull();
    expect(module.of('m1')).toBe('off');
  });

  it('does not wait forever for the mail server when signing out', async () => {
    const module = mailPushWith(browser, 1000);
    await enabled(module);
    vi.useFakeTimers();
    try {
      clientSpy.mockReturnValue(new Promise(() => {}));
      const done = module.withdraw();
      await vi.advanceTimersByTimeAsync(3000);
      await expect(done).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards a late response after reset and does not clean up for the new session', async () => {
    const module = mailPushWith(browser, 60_000);
    const pending = module.enable('m1');
    await vi.waitFor(() => expect(server.entries.size).toBe(1));
    module.reset();
    expect(module.of('m1')).toBe('off');
    expect(await pending).toBe('off');
    expect(module.of('m1')).toBe('off');
    expect(server.entries.size).toBe(1);
    expect(browser.registrations.size).toBe(1);
  });

  it('waits for the new confirmation after reset and a new sign-in', async () => {
    const module = mailPushWith(browser, 60_000);
    const old = module.enable('m1');
    await vi.waitFor(() => expect(server.entries.size).toBe(1));
    module.reset();
    await old;
    const next = module.enable('m1');
    await vi.waitFor(() => expect(server.entries.size).toBe(1));
    await vi.waitFor(() => expect(module.of('m1')).toBe('pending'));
    await vi.waitFor(() => expect([...server.entries.keys()][0]).not.toBe('p1'));
    browser.verified('m1', [...server.entries.keys()][0] as string);
    expect(await next).toBe('on');
  });

  it('is not disturbed by the message of another entry', async () => {
    const module = mailPushWith(browser, 1000);
    const pending = module.enable('m1');
    await vi.waitFor(() => expect(server.entries.size).toBe(1));
    browser.verified('m1', 'old');
    const [id] = [...server.entries.keys()];
    await vi.waitFor(() => expect(module.of('m1')).toBe('pending'));
    expect(server.entries.has(id as string)).toBe(true);
    browser.verified('m1', id as string);
    expect(await pending).toBe('on');
  });

  it('aborts a running setup when turning off', async () => {
    const module = mailPushWith(browser, 60_000);
    const pending = module.enable('m1');
    await vi.waitFor(() => expect(server.entries.size).toBe(1));
    await module.disable('m1');
    expect(await pending).toBe('off');
    expect(module.of('m1')).toBe('off');
    expect(server.entries.size).toBe(0);
    expect(browser.registrations.size).toBe(0);
  });

  it('sets up an account across two tabs only once', async () => {
    const first = mailPushWith(browser, 1000);
    const second = mailPushWith(browser, 1000);
    server.onCreate = (id) => browser.verified('m1', id);
    expect(await Promise.all([first.enable('m1'), second.enable('m1')])).toEqual(['on', 'on']);
    expect(server.entries.size).toBe(1);
    expect(server.names().filter((name) => name === 'PushSubscription/set')).toHaveLength(1);
  });

  it('does not wait forever for the push service when turning off', async () => {
    const module = mailPushWith(browser, 1000);
    await enabled(module);
    const subscription = browser.managers.get(SCOPE)?.state.subscription;
    if (subscription) subscription.unsubscribe = () => new Promise(() => {});
    vi.useFakeTimers();
    try {
      const done = module.clearDevice();
      await vi.advanceTimersByTimeAsync(3000);
      await expect(done).resolves.toBeUndefined();
      expect(browser.registrations.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
