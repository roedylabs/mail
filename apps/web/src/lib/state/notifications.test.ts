import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import {
  Notifications,
  POLL_MS,
  shownInApp,
  type AppNotification,
  type NotificationsEnv,
} from '#lib/state/notifications.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { m } from '#lib/paraglide/messages.js';

function entry(id: string, over: Partial<AppNotification> = {}): AppNotification {
  return {
    id,
    topic: 'account',
    kind: 'account.profile',
    icon: 'ti-user-edit',
    title: 'Profile changed',
    text: 'Your display name is now Jana.',
    target: { view: 'settings', page: 'profile', path: '/account/profile' },
    created_at: '2026-11-04T10:00:00Z',
    read_at: null,
    ...over,
  };
}

const answer = (...items: AppNotification[]) => ({
  body: { notifications: items, unread: items.filter((n) => !n.read_at).length },
});

let n: Notifications;
let chime: Mock<() => void>;
let disarm: Mock<() => void>;
let visible: boolean;

beforeEach(() => {
  prefs.reset();
  ui.reset();
  visible = true;
  chime = vi.fn();
  disarm = vi.fn();
  const env: NotificationsEnv = { chime: () => chime(), arm: () => () => disarm(), visible: () => visible };
  n = new Notifications();
  n.env = env;
});

afterEach(() => {
  ui.toasts.discard();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('shownInApp', () => {
  it('hides topics without app, never security', () => {
    const topics = {
      account: { app: false, mail: true, push: false },
      security: { app: false, mail: true, push: false },
    };
    expect(shownInApp('account', topics)).toBe(false);
    expect(shownInApp('security', topics)).toBe(true);
    expect(shownInApp('news', topics)).toBe(true);
  });
});

describe('Fetch', () => {
  it('loads the list and shares a running fetch', async () => {
    const { calls } = mockApi({ 'GET notifications': [answer(entry('a'), entry('b'))] });
    await Promise.all([n.load(), n.load()]);
    expect(calls).toHaveLength(1);
    expect(n.list?.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('keeps the last state on an error', async () => {
    mockApi({ 'GET notifications': [answer(entry('a')), { status: 500 }] });
    await n.load();
    await n.load();
    expect(n.list?.map((x) => x.id)).toEqual(['a']);
  });

  it('reloads the account after an ended session (401)', async () => {
    const refresh = vi.spyOn(session, 'refreshUser').mockResolvedValue();
    mockApi({ 'GET notifications': [{ status: 500 }, { status: 401, body: { error: 'unauthorized' } }] });
    await n.load();
    expect(refresh).not.toHaveBeenCalled();
    await n.load();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('shares the new fetch after reset(), not the old one', async () => {
    let release!: () => void;
    const { calls } = mockApi({
      'GET notifications': [
        () => new Promise((resolve) => (release = () => resolve(answer(entry('old'))))),
        () => new Promise(() => {}),
      ],
    });
    const old = n.load();
    n.reset();
    void n.load();
    release();
    await old;
    void n.load();
    expect(calls).toHaveLength(2);
  });

  it('discards responses after reset()', async () => {
    let release!: () => void;
    mockApi({
      'GET notifications': [() => new Promise((resolve) => (release = () => resolve(answer(entry('a')))))],
    });
    const loading = n.load();
    n.reset();
    release();
    await loading;
    expect(n.list).toBeNull();
  });

  it('watch() fetches at start, periodically while the page is visible and on returning', async () => {
    vi.useFakeTimers();
    const { calls } = mockApi({ 'GET notifications': [answer(), answer(), answer(), answer()] });
    const stop = n.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls).toHaveLength(2);
    visible = false;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(calls).toHaveLength(2);
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(3);
    stop();
    expect(disarm).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(calls).toHaveLength(3);
  });

  it('watch() fetches after an offline phase, also after the simulation', async () => {
    vi.useFakeTimers();
    const { calls } = mockApi({ 'GET notifications': [answer(), answer()] });
    const stop = n.watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    network.simulate(true);
    network.simulate(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    stop();
  });
});

describe('Sound', () => {
  it('plays on new unread entries after the first fetch', async () => {
    mockApi({
      'GET notifications': [
        answer(entry('a')),
        answer(entry('a')),
        answer(entry('b'), entry('a')),
        answer(entry('c', { read_at: '2026-11-04T11:00:00Z' }), entry('b'), entry('a')),
      ],
    });
    await n.load();
    await n.load();
    expect(chime).not.toHaveBeenCalled();
    await n.load();
    expect(chime).toHaveBeenCalledTimes(1);
    await n.load();
    expect(chime).toHaveBeenCalledTimes(1);
  });

  it('stays silent without sound, without the channel "In the app" and for deselected topics', async () => {
    mockApi({
      'GET notifications': [answer(), answer(entry('a')), answer(entry('b'), entry('a')), answer(entry('c'))],
    });
    await n.load();
    prefs.values.nSound = false;
    await n.load();
    prefs.values.nSound = true;
    prefs.values.nCh = { ...prefs.values.nCh, app: false };
    await n.load();
    prefs.values.nCh = { ...prefs.values.nCh, app: true };
    prefs.values.nMx = { ...prefs.values.nMx, account: { app: false, mail: true, push: false } };
    await n.load();
    expect(chime).not.toHaveBeenCalled();
  });
});

describe('Read', () => {
  it('marks an entry on opening', async () => {
    const { calls } = mockApi({
      'GET notifications': [answer(entry('a'), entry('b'))],
      'POST notifications/read': [{ body: { unread: 1 } }],
    });
    await n.load();
    const reading = n.read('a');
    expect(n.list?.find((x) => x.id === 'a')?.read_at).not.toBeNull();
    await reading;
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { ids: ['a'] } });
    await n.read('a');
    expect(calls).toHaveLength(2);
  });

  it('reverts the read state if the call fails', async () => {
    const error = vi.spyOn(ui.toasts, 'error');
    mockApi({ 'GET notifications': [answer(entry('a'))], 'POST notifications/read': [{ status: 500 }] });
    await n.load();
    await n.read('a');
    expect(n.list?.[0]?.read_at).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('"Mark all as read" sends only the loaded unread ones', async () => {
    const error = vi.spyOn(ui.toasts, 'error');
    const { calls } = mockApi({
      'GET notifications': [
        answer(entry('a'), entry('b', { read_at: '2026-11-04T09:00:00Z' }), entry('c', { topic: 'news' })),
      ],
      'POST notifications/read': [{ body: { unread: 0 } }, { status: 500 }],
    });
    await n.load();
    await n.readAll();
    // Not `all`: entries created since the fetch stay unread.
    expect(calls.at(-1)).toMatchObject({ body: { ids: ['a', 'c'] } });
    expect(n.list?.every((x) => x.read_at)).toBe(true);
    await n.readAll();
    expect(calls).toHaveLength(2);
    expect(error).not.toHaveBeenCalled();
  });

  it('reverts "Alle als gelesen" on an error', async () => {
    const error = vi.spyOn(ui.toasts, 'error');
    mockApi({ 'GET notifications': [answer(entry('a'))], 'POST notifications/read': [{ status: 500 }] });
    await n.load();
    await n.readAll();
    expect(n.list?.[0]?.read_at).toBeNull();
    expect(error).toHaveBeenCalledWith(m.error_act());
  });

  it('discards a fetch that began before marking', async () => {
    let release!: () => void;
    mockApi({
      'GET notifications': [
        answer(entry('a')),
        () => new Promise((resolve) => (release = () => resolve(answer(entry('a'))))),
      ],
      'POST notifications/read': [{ body: { unread: 0 } }],
    });
    await n.load();
    const loading = n.load();
    await n.read('a');
    release();
    await loading;
    expect(n.list?.[0]?.read_at).not.toBeNull();
  });
});

describe('Remove', () => {
  it('removes immediately and sends DELETE after the toast', async () => {
    const { calls } = mockApi({
      'GET notifications': [answer(entry('a'), entry('b')), answer(entry('a'), entry('b'))],
      'DELETE notifications/a': [{ status: 204 }],
    });
    await n.load();
    n.remove('a');
    expect(n.list?.map((x) => x.id)).toEqual(['b']);
    expect(ui.toast).toMatchObject({ text: 'Notification removed', undo: true });
    // A fetch during the toast does not bring the entry back.
    await n.load();
    expect(n.list?.map((x) => x.id)).toEqual(['b']);
    await ui.toasts.flush();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: 'notifications/a' });
    expect(n.list?.map((x) => x.id)).toEqual(['b']);
  });

  it('"undo" puts the entry back in its place', async () => {
    const { calls } = mockApi({
      'GET notifications': [
        answer(
          entry('a', { created_at: '2026-11-04T12:00:00Z' }),
          entry('b'),
          entry('c', { created_at: '2026-11-03T10:00:00Z' }),
        ),
      ],
    });
    await n.load();
    n.remove('b');
    ui.toasts.undo();
    expect(n.list?.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(1);
  });

  it('counts as done on 404', async () => {
    const error = vi.spyOn(ui.toasts, 'error');
    mockApi({
      'GET notifications': [answer(entry('a'))],
      'DELETE notifications/a': [{ status: 404, body: { error: 'not_found' } }],
    });
    await n.load();
    n.remove('a');
    await ui.toasts.flush();
    expect(n.list).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  it('brings the entry back on an error and reports it', async () => {
    mockApi({
      'GET notifications': [answer(entry('a'))],
      'DELETE notifications/a': [{ status: 500 }],
    });
    await n.load();
    n.remove('a');
    await ui.toasts.flush();
    expect(n.list?.map((x) => x.id)).toEqual(['a']);
    expect(ui.toast).toMatchObject({ error: true });
  });
});
