import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64UrlBytes } from '#lib/push-keys.ts';
import { BELL_MESSAGE, MAIL_MESSAGE, OPEN_MESSAGE } from '#lib/push-message.ts';
import {
  isAppleMobile,
  listenForPushClicks,
  listenForPushNews,
  Push,
  pushSupport,
  type PushEnv,
} from '#lib/push.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

const KEY = 'BAECAwQ'; // Bytes 4, 1, 2, 3, 4
const OTHER_KEY = 'BAUGBwg';
const ENDPOINT = 'https://push.example.test/abc';

function entry(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    endpoint: ENDPOINT,
    device: 'Firefox on Linux',
    created_at: '2026-11-04T10:00:00Z',
    expires_at: null,
    current: true,
    ...over,
  };
}

/** Browser with a service worker and a (initially missing) subscription. */
function fakeBrowser(
  opts: { permission?: NotificationPermission; answer?: NotificationPermission; key?: string } = {},
) {
  let subscription: PushSubscription | null = null;
  const unsubscribe = vi.fn(() => {
    subscription = null;
    return Promise.resolve(true);
  });
  const make = (key: string) =>
    ({
      endpoint: ENDPOINT,
      options: { applicationServerKey: base64UrlBytes(key).buffer, userVisibleOnly: true },
      toJSON: () => ({ endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe,
    }) as unknown as PushSubscription;
  if (opts.key) subscription = make(opts.key);
  const subscribe = vi.fn((options: PushSubscriptionOptionsInit) => {
    const bytes = options.applicationServerKey as Uint8Array;
    subscription = make(
      btoa(String.fromCharCode(...bytes))
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_'),
    );
    return Promise.resolve(subscription);
  });
  let permission: NotificationPermission = opts.permission ?? 'default';
  const requestPermission = vi.fn(() => {
    permission = opts.answer ?? 'granted';
    return Promise.resolve(permission);
  });
  const registration = {
    pushManager: { getSubscription: () => Promise.resolve(subscription), subscribe },
  } as unknown as ServiceWorkerRegistration;
  const env: PushEnv = {
    support: () => 'yes',
    permission: () => permission,
    requestPermission,
    registration: () => Promise.resolve(registration),
  };
  return { env, subscribe, unsubscribe, requestPermission, current: () => subscription };
}

let push: Push;
let show: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  prefs.reset();
  push = new Push();
  show = vi.spyOn(ui.toasts, 'show').mockImplementation(() => {});
  error = vi.spyOn(ui.toasts, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('support', () => {
  const nav = (userAgent: string, extra: Record<string, unknown> = {}, maxTouchPoints = 0) =>
    ({ navigator: { userAgent, maxTouchPoints, ...extra }, ...extra }) as unknown as Window & typeof globalThis;
  const full = { serviceWorker: {}, PushManager: {}, Notification: {} };

  it('recognizes browsers with and without push', () => {
    expect(pushSupport(nav('Mozilla/5.0 (X11; Linux x86_64) Firefox/150.0', full))).toBe('yes');
    expect(pushSupport(nav('Mozilla/5.0 (X11; Linux x86_64) Firefox/150.0'))).toBe('none');
  });

  it('iPhone and iPad without home screen: notice ios', () => {
    expect(pushSupport(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', { standalone: false }))).toBe(
      'ios',
    );
    expect(pushSupport(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', { standalone: false }, 5))).toBe('ios');
    expect(
      pushSupport(nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', { ...full, standalone: true })),
    ).toBe('yes');
    expect(isAppleMobile({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 })).toBe(
      false,
    );
  });

  it('states none, ios and denied', () => {
    push.env = { ...fakeBrowser().env, support: () => 'none' };
    push.readEnv();
    expect(push.status).toBe('none');
    push.env = { ...fakeBrowser().env, support: () => 'ios' };
    push.readEnv();
    expect(push.status).toBe('ios');
    push.env = fakeBrowser({ permission: 'denied' }).env;
    push.readEnv();
    expect(push.status).toBe('denied');
  });
});

describe('turning on', () => {
  it('asks, registers, turns on the channel and is then active', async () => {
    const browser = fakeBrowser();
    push.env = browser.env;
    const { calls } = mockApi({
      'GET push/vapid-public-key': [{ body: { key: KEY } }],
      'POST push/subscriptions': [{ status: 201, body: entry() }],
    });
    push.readEnv();
    expect(push.status).toBe('ask');
    const done = push.request();
    expect(push.status).toBe('busy');
    await done;
    expect(browser.requestPermission).toHaveBeenCalledOnce();
    expect(browser.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(calls.at(-1)?.body).toEqual({ endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } });
    expect(prefs.values.nCh.push).toBe(true);
    expect(push.status).toBe('active');
    expect(push.current?.device).toBe('Firefox on Linux');
    expect(show).toHaveBeenCalledWith('Push notifications on');
  });

  it('denied: denied, without registration', async () => {
    const browser = fakeBrowser({ answer: 'denied' });
    push.env = browser.env;
    const { calls } = mockApi({});
    await push.request();
    expect(push.status).toBe('denied');
    expect(calls).toHaveLength(0);
    expect(prefs.values.nCh.push).toBe(false);
  });

  it('without a decision: notice, still ask', async () => {
    push.env = fakeBrowser({ answer: 'default' }).env;
    mockApi({});
    await push.request();
    expect(push.status).toBe('ask');
    expect(show).toHaveBeenCalledWith('No decision was made in the browser');
  });

  it('with permission without asking again; errors as a toast', async () => {
    const browser = fakeBrowser({ permission: 'granted' });
    push.env = browser.env;
    mockApi({ 'GET push/vapid-public-key': [{ status: 500, body: { error: 'internal' } }] });
    await push.request();
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(push.status).toBe('ask');
  });
});

/** Settings loaded with the push channel on (for example turned on on another device). */
function channelOn() {
  prefs.fromCopy({ version: 1, settings: { ...prefs.values, nCh: { app: true, mail: true, push: true } } });
}

describe('silent subscription', () => {
  it('permission and channel on count as active, also before the registration', () => {
    push.env = fakeBrowser({ permission: 'granted' }).env;
    push.readEnv();
    expect(push.status).toBe('ask');
    prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
    expect(push.status).toBe('active');
    expect(push.current).toBeNull();
  });

  it('channel on without a subscription in this browser: subscribes without a toast', async () => {
    const browser = fakeBrowser({ permission: 'granted' });
    push.env = browser.env;
    channelOn();
    const { calls } = mockApi({
      'GET push/vapid-public-key': [{ body: { key: KEY } }],
      'POST push/subscriptions': [{ status: 201, body: entry() }],
    });
    await push.resume();
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(browser.subscribe).toHaveBeenCalledOnce();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET push/vapid-public-key', 'POST push/subscriptions']);
    expect(push.status).toBe('active');
    expect(push.missing).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('opening the page subscribes the same way', async () => {
    const browser = fakeBrowser({ permission: 'granted' });
    push.env = browser.env;
    channelOn();
    mockApi({
      'GET push/vapid-public-key': [{ body: { key: KEY } }],
      'POST push/subscriptions': [{ status: 201, body: entry() }],
    });
    await push.refresh();
    expect(browser.subscribe).toHaveBeenCalledOnce();
    expect(push.current?.id).toBe('s1');
  });

  it('fails: this device counts as off, without a toast; turning on here subscribes', async () => {
    const browser = fakeBrowser({ permission: 'granted' });
    push.env = browser.env;
    channelOn();
    mockApi({
      'GET push/vapid-public-key': [{ status: 500, body: { error: 'internal' } }, { body: { key: KEY } }],
      'POST push/subscriptions': [{ status: 201, body: entry() }],
    });
    await push.resume();
    expect(push.missing).toBe(true);
    expect(push.status).toBe('ask');
    expect(show).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    await push.request();
    expect(push.missing).toBe(false);
    expect(push.status).toBe('active');
    expect(show).toHaveBeenCalledWith('Push notifications on');
  });

  it('a failed check on opening keeps a registration of this session', async () => {
    push.env = fakeBrowser({ permission: 'granted', key: KEY }).env;
    channelOn();
    push.current = entry();
    mockApi({ 'GET push/vapid-public-key': [{ status: 500, body: { error: 'internal' } }] });
    await push.refresh();
    expect(push.missing).toBe(false);
    expect(push.status).toBe('active');
  });

  it('a new key whose replacement fails: the old entry no longer counts', async () => {
    const browser = fakeBrowser({ permission: 'granted', key: OTHER_KEY });
    push.env = browser.env;
    channelOn();
    push.current = entry();
    mockApi({
      'GET push/vapid-public-key': [{ body: { key: KEY } }],
      'POST push/subscriptions': [{ status: 500, body: { error: 'internal' } }],
    });
    // The old subscription is gone, the new one is not registered either.
    browser.subscribe.mockImplementationOnce(() => Promise.reject(new Error('no subscription')));
    await push.refresh();
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(push.current).toBeNull();
    expect(push.missing).toBe(true);
    expect(push.status).toBe('ask');
  });

  it('turning off waits for a running silent registration and removes what it created', async () => {
    const browser = fakeBrowser({ permission: 'granted' });
    push.env = browser.env;
    channelOn();
    let key: ((value: { body: unknown }) => void) | undefined;
    const { calls } = mockApi({
      'GET push/vapid-public-key': [() => new Promise((resolve) => (key = resolve))],
      'POST push/subscriptions': [{ status: 201, body: entry() }],
      'DELETE push/subscriptions/s1': [{ status: 204 }],
    });
    const silent = push.resume();
    await vi.waitFor(() => expect(key).toBeDefined());
    const off = push.off();
    key?.({ body: { key: KEY } });
    await Promise.all([silent, off]);
    expect(calls.filter((c) => c.path.startsWith('push/')).map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET push/vapid-public-key',
      'POST push/subscriptions',
      'DELETE push/subscriptions/s1',
    ]);
    expect(browser.current()).toBeNull();
    expect(push.current).toBeNull();
    expect(prefs.values.nCh.push).toBe(false);
  });

  it('settings not loaded yet: no new subscription', async () => {
    const browser = fakeBrowser({ permission: 'granted' });
    push.env = browser.env;
    prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
    const { calls } = mockApi({});
    await push.resume();
    expect(calls).toHaveLength(0);
    expect(browser.subscribe).not.toHaveBeenCalled();
  });

  it('reset forgets that this device was off', () => {
    push.missing = true;
    push.reset();
    expect(push.missing).toBe(false);
  });
});

describe('after sign-in', () => {
  it('registers an existing browser for the new session', async () => {
    const browser = fakeBrowser({ permission: 'granted', key: KEY });
    push.env = browser.env;
    prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
    const { calls } = mockApi({
      'GET push/vapid-public-key': [{ body: { key: KEY } }],
      'POST push/subscriptions': [{ status: 200, body: entry() }],
    });
    await push.resume();
    expect(browser.subscribe).not.toHaveBeenCalled();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET push/vapid-public-key', 'POST push/subscriptions']);
    expect(push.status).toBe('active');
  });

  it('new key of the instance: new subscription', async () => {
    const browser = fakeBrowser({ permission: 'granted', key: OTHER_KEY });
    push.env = browser.env;
    mockApi({
      'GET push/vapid-public-key': [{ body: { key: KEY } }],
      'POST push/subscriptions': [{ status: 201, body: entry() }],
    });
    await push.resume();
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(browser.subscribe).toHaveBeenCalledOnce();
  });

  it('without permission or subscription: nothing', async () => {
    push.env = fakeBrowser({ permission: 'granted' }).env;
    const { calls } = mockApi({});
    await push.resume();
    push.env = fakeBrowser({ key: KEY }).env;
    await push.resume();
    expect(calls).toHaveLength(0);
  });

  it('refresh: registers a browser with a subscription and is then active', async () => {
    push.env = fakeBrowser({ permission: 'granted', key: KEY }).env;
    prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
    const { calls } = mockApi({
      'GET push/vapid-public-key': [{ body: { key: KEY } }],
      'POST push/subscriptions': [{ status: 200, body: entry() }],
    });
    await push.refresh();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET push/vapid-public-key', 'POST push/subscriptions']);
    expect(push.status).toBe('active');
  });

  it('refresh without permission: no service worker, not active', async () => {
    const browser = fakeBrowser({ key: KEY });
    const registration = vi.spyOn(browser.env, 'registration');
    push.env = browser.env;
    push.current = entry();
    const { calls } = mockApi({});
    await push.refresh();
    expect(registration).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(push.current).toBeNull();
  });

  it('without a key in the subscription it stays', async () => {
    const browser = fakeBrowser({ permission: 'granted', key: KEY });
    const subscription = await (await browser.env.registration()).pushManager.getSubscription();
    Object.defineProperty(subscription, 'options', { value: { applicationServerKey: null, userVisibleOnly: true } });
    push.env = browser.env;
    mockApi({
      'GET push/vapid-public-key': [{ body: { key: OTHER_KEY } }],
      'POST push/subscriptions': [{ status: 200, body: entry() }],
    });
    await push.resume();
    expect(browser.unsubscribe).not.toHaveBeenCalled();
    expect(browser.subscribe).not.toHaveBeenCalled();
  });

  it('reset discards the response of an earlier session', async () => {
    push.env = fakeBrowser({ permission: 'granted', key: KEY }).env;
    let answer: ((value: { body: unknown }) => void) | undefined;
    mockApi({
      'GET push/vapid-public-key': [{ body: { key: KEY } }],
      'POST push/subscriptions': [() => new Promise((resolve) => (answer = resolve))],
    });
    const done = push.refresh();
    await vi.waitFor(() => expect(answer).toBeDefined());
    push.reset();
    answer?.({ body: entry() });
    await done;
    expect(push.current).toBeNull();
  });
});

describe('test and turning off', () => {
  it('test notification; 409 no_subscription registers again', async () => {
    push.env = fakeBrowser({ permission: 'granted', key: KEY }).env;
    push.readEnv();
    const { calls } = mockApi({
      'POST push/test': [{ status: 409, body: { error: 'no_subscription' } }, { body: { sent: 1 } }],
      'GET push/vapid-public-key': [{ body: { key: KEY } }],
      'POST push/subscriptions': [{ status: 201, body: entry() }],
    });
    await push.test();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST push/test',
      'GET push/vapid-public-key',
      'POST push/subscriptions',
      'POST push/test',
    ]);
    expect(show).toHaveBeenCalledWith('Test notification sent');
  });

  it('test fails: error toast', async () => {
    mockApi({ 'POST push/test': [{ status: 502, body: { error: 'push_failed' } }] });
    await push.test();
    expect(error).toHaveBeenCalledOnce();
    expect(show).not.toHaveBeenCalled();
  });

  it('turning off deletes the subscription and turns off the channel', async () => {
    const browser = fakeBrowser({ permission: 'granted', key: KEY });
    push.env = browser.env;
    push.readEnv();
    push.current = entry();
    prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
    const { calls } = mockApi({ 'DELETE push/subscriptions/s1': [{ status: 204 }] });
    await push.off();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['DELETE push/subscriptions/s1']);
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
    expect(push.current).toBeNull();
    expect(prefs.values.nCh.push).toBe(false);
    expect(push.status).toBe('ask');
    expect(show).toHaveBeenCalledWith('Push turned off on this device');
  });

  it('the channel turns off for all devices, also when the subscription is already gone', async () => {
    push.env = fakeBrowser({ permission: 'granted', key: KEY }).env;
    push.readEnv();
    push.current = entry();
    prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
    const { calls } = mockApi({ 'DELETE push/subscriptions/s1': [{ status: 404, body: { error: 'not_found' } }] });
    await push.off();
    expect(calls).toHaveLength(1);
    expect(prefs.values.nCh.push).toBe(false);
    expect(push.status).toBe('ask');
    expect(show).toHaveBeenCalledWith('Push turned off on this device');
  });

  it('turning off fails: error toast, the channel stays', async () => {
    push.env = fakeBrowser({ permission: 'granted', key: KEY }).env;
    push.readEnv();
    push.current = entry();
    prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
    mockApi({ 'DELETE push/subscriptions/s1': [{ status: 500, body: { error: 'internal' } }] });
    await push.off();
    expect(error).toHaveBeenCalledOnce();
    expect(prefs.values.nCh.push).toBe(true);
  });
});

describe('click on a notification', () => {
  it('opens the path from the service worker message, only app paths', () => {
    const container = new EventTarget();
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: container });
    const open = vi.fn();
    const stop = listenForPushClicks(open);
    const send = (data: unknown) => container.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: OPEN_MESSAGE, url: '/account/security' });
    send({ type: OPEN_MESSAGE, url: 'https://example.test/' });
    send({ type: 'other', url: '/x' });
    send('text');
    expect(open.mock.calls).toEqual([['/account/security'], ['/start']]);
    stop();
    send({ type: OPEN_MESSAGE, url: '/start' });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('reports bell and new mails until it is unsubscribed', () => {
    const container = new EventTarget();
    vi.stubGlobal('navigator', { ...navigator, serviceWorker: container });
    const bell = vi.fn();
    const mail = vi.fn();
    const stop = listenForPushNews(bell, mail);
    const send = (data: unknown) => container.dispatchEvent(new MessageEvent('message', { data }));
    send({ type: BELL_MESSAGE });
    send({ type: MAIL_MESSAGE, accountId: 'm1' });
    send({ type: MAIL_MESSAGE });
    send({ type: OPEN_MESSAGE, url: '/start' });
    send('text');
    expect(bell).toHaveBeenCalledTimes(1);
    expect(mail.mock.calls).toEqual([['m1']]);
    stop();
    send({ type: BELL_MESSAGE });
    expect(bell).toHaveBeenCalledTimes(1);
  });
});
