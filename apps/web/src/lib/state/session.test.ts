import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from './fetch-mock.ts';
import { prefs } from './prefs.svelte.ts';
import { CACHE_VERSION_KEY } from '#lib/client-cache.ts';
import { mkLogo } from '#lib/logo.ts';
import { m } from '#lib/paraglide/messages.js';
import { forgetStartCopy, saveStartCopy, type StartCopy } from '#lib/start-copy.ts';
import { network } from '#lib/state/network.svelte.ts';
import {
  BRAND0,
  CONFIG_POLL_MS,
  CONFIG_TIMEOUT_MS,
  Session,
  TAB_CHANNEL,
  initialsOf,
  loginTextOf,
  loginTitleOf,
  type PublicBanner,
  type PublicConfig,
} from './session.svelte.ts';

const CONFIG: PublicConfig = {
  name: 'Post',
  branding: { ...BRAND0, plate: 'dark', color: 'sage' },
  org: { name: null, website: null, help: null, email: null, imprint: null, privacy: null, terms: null, source: null },
  banner: null,
  maintenance: { on: false, message: null },
  version: '0.1.0',
  update: null,
  setup_required: false,
  client_cache_version: 0,
};

const ME = {
  id: '01J',
  username: 'max',
  email: 'max@example.org',
  display_name: 'Max Mustermann',
  role: 'admin',
  mfa_enabled: false,
  password_changed_at: '2026-10-25T10:00:00Z',
  email_change: null,
};

const BANNER: PublicBanner = {
  title: 'Moving',
  text: 'On Friday',
  link: '',
  linkLabel: '',
  tone: 'warning',
  icon: 'ti-speakerphone',
  closable: true,
  revision: 3,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  network.simulated = false;
});

describe('Texts of the sign-in page', () => {
  it("translates the backend's default, own texts stay", () => {
    expect(loginTitleOf(BRAND0)).toBe('Welcome back');
    expect(loginTextOf(BRAND0)).toBe('Sign in with your account.');
    prefs.set({ lang: 'de' });
    try {
      const german = { locale: 'de' } as const;
      expect(loginTitleOf(BRAND0)).toBe(m.branding_login_title_ph({}, german));
      expect(loginTitleOf({ loginTitle: '  ' })).toBe(m.branding_login_title_ph({}, german));
      expect(loginTextOf(BRAND0)).toBe(m.branding_login_text_ph({}, german));
      expect(loginTitleOf(BRAND0)).not.toBe('Welcome back');
      expect(loginTitleOf({ loginTitle: 'Hello team' })).toBe('Hello team');
      expect(loginTextOf({ loginText: '' })).toBe('');
      expect(loginTextOf({ loginText: 'Internal only' })).toBe('Internal only');
    } finally {
      prefs.set({ lang: 'en' });
    }
  });
});

describe('Start without network', () => {
  const offlineFetch = vi.fn(() => Promise.reject(new TypeError('offline')));
  const copy = () =>
    ({ config: CONFIG, user: ME, accounts: [], settings: { version: 1, settings: {} } }) as unknown as StartCopy;

  afterEach(() => {
    forgetStartCopy();
    localStorage.removeItem(CACHE_VERSION_KEY);
  });

  it('keeps showing the error page without a copy', async () => {
    vi.stubGlobal('fetch', offlineFetch);
    const session = new Session();
    await session.load();
    expect(session.status).toBe('error');
    expect(session.failure).toBe('offline');
    expect(session.fromCopy).toBe(false);
  });

  it('starts from the copy without a response and hands over the rest before the page is up', async () => {
    saveStartCopy(copy());
    vi.stubGlobal('fetch', offlineFetch);
    const session = new Session();
    const restore = vi.fn(() => expect(session.status).toBe('loading'));
    await session.load(restore);
    expect(restore).toHaveBeenCalledOnce();
    expect(session.status).toBe('ready');
    expect(session.fromCopy).toBe(true);
    expect(session.failure).toBeNull();
    expect(session.user?.id).toBe(ME.id);
    expect(session.appName).toBe(CONFIG.name);
  });

  it('does not repeat the copy while the server stays silent', async () => {
    saveStartCopy(copy());
    vi.stubGlobal('fetch', offlineFetch);
    const session = new Session();
    const restore = vi.fn();
    await session.load(restore);
    await session.load(restore);
    expect(restore).toHaveBeenCalledOnce();
    expect(session.fromCopy).toBe(true);
  });

  it('takes an error response of the server seriously instead of showing the copy', async () => {
    saveStartCopy(copy());
    mockApi({ 'GET public/config': [{ status: 500, body: { error: 'internal' } }] });
    const session = new Session();
    await session.load();
    expect(session.status).toBe('error');
    expect(session.failure).toBe('500');
  });

  it('stays with the copy if the server answers the follow-up with an error', async () => {
    saveStartCopy(copy());
    vi.stubGlobal('fetch', offlineFetch);
    const session = new Session();
    await session.load();
    vi.unstubAllGlobals();
    mockApi({ 'GET public/config': [{ status: 502, body: {} }] });
    await session.load();
    expect(session.status).toBe('ready');
    expect(session.fromCopy).toBe(true);
    expect(session.failure).toBeNull();
  });

  it("applies the server's state again as soon as it answers", async () => {
    saveStartCopy(copy());
    vi.stubGlobal('fetch', offlineFetch);
    const session = new Session();
    await session.load();
    vi.unstubAllGlobals();
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    await session.load();
    expect(session.fromCopy).toBe(false);
    expect(session.user).toBeNull();
    expect(session.authed).toBe(false);
  });

  it('remembers the cache version', async () => {
    mockApi({
      'GET public/config': [{ body: { ...CONFIG, client_cache_version: 7 } }],
      'GET auth/me': [{ status: 401, body: {} }],
    });
    await new Session().load();
    await vi.waitFor(() => expect(localStorage.getItem(CACHE_VERSION_KEY)).toBe('7'));
  });
});

describe('session', () => {
  it('loads configuration and account', async () => {
    const { calls } = mockApi({ 'GET public/config': [{ body: CONFIG }], 'GET auth/me': [{ body: ME }] });
    const session = new Session();
    await session.load();
    expect(session.status).toBe('ready');
    expect(session.appName).toBe('Post');
    expect(session.authed).toBe(true);
    expect(session.isAdmin).toBe(true);
    expect(session.initials).toBe('MM');
    expect(session.logo).toMatchObject({ isMark: true, text: 'P' });
    expect(calls[0]?.headers['X-Requested-With']).toBe('roedy-mail');
  });

  it('ends a hanging load at the given signal as offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: string, init: RequestInit = {}) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ),
    );
    const session = new Session();
    const ctrl = new AbortController();
    const pending = session.load(undefined, ctrl.signal);
    ctrl.abort();
    await pending;
    expect([session.status, session.failure]).toEqual(['error', 'offline']);
  });

  it('does not query the account without an administrator', async () => {
    const { calls } = mockApi({ 'GET public/config': [{ body: { ...CONFIG, setup_required: true } }] });
    const session = new Session();
    await session.load();
    expect(session.setupRequired).toBe(true);
    expect(session.authed).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('reloads after the setup and sets configuration and account at once', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { calls } = mockApi({
      'GET public/config': [{ body: { ...CONFIG, setup_required: true } }, { body: CONFIG }],
      'GET auth/me': [
        async () => {
          await gate;
          return { body: ME };
        },
      ],
    });
    const session = new Session();
    await session.load();
    expect(session.setupRequired).toBe(true);
    const reload = session.load();
    await vi.waitFor(() => expect(calls.map((c) => c.path)).toContain('auth/me'));
    // While `auth/me` is pending, the old state stays (otherwise the layout would redirect to sign-in).
    expect(session.status).toBe('ready');
    expect(session.setupRequired).toBe(true);
    release();
    await reload;
    expect(session.setupRequired).toBe(false);
    expect(session.authed).toBe(true);
  });

  it('counts as not signed in on 401', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    const session = new Session();
    await session.load();
    expect(session.status).toBe('ready');
    expect(session.authed).toBe(false);
    expect(session.isAdmin).toBe(false);
  });

  it('reports an error if the backend does not answer', async () => {
    mockApi({ 'GET public/config': [{ status: 500, body: { error: 'internal' } }] });
    const session = new Session();
    await session.load();
    expect(session.status).toBe('error');
    expect(session.appName).toBe('Roedy Mail');
  });
});

describe('Configuration of open pages', () => {
  /** Loaded session; `config` answers every further fetch. */
  async function loaded(...config: PublicConfig[]) {
    const { calls } = mockApi({
      'GET public/config': [CONFIG, ...config].map((body) => ({ body })),
      'GET auth/me': [{ body: ME }],
    });
    const session = new Session();
    await session.load();
    return { session, calls };
  }

  it('takes over banner and maintenance mode, other fields stay as loaded', async () => {
    const { session } = await loaded({
      ...CONFIG,
      name: 'Other',
      banner: BANNER,
      maintenance: { on: true, message: 'Until 6 pm' },
    });
    const { org, branding } = session.config!;
    await session.refreshConfig();
    expect(session.config?.banner).toEqual(BANNER);
    expect(session.config?.maintenance).toEqual({ on: true, message: 'Until 6 pm' });
    expect(session.appName).toBe('Post');
    expect(session.config?.org).toBe(org);
    expect(session.config?.branding).toBe(branding);
  });

  it('leaves the state untouched without a change at the server', async () => {
    const { session } = await loaded({ ...CONFIG });
    const { banner, maintenance } = session.config!;
    await session.refreshConfig();
    expect(session.config?.banner).toBe(banner);
    expect(session.config?.maintenance).toBe(maintenance);
  });

  it('does not overwrite an own change that is not saved yet (toast with undo)', async () => {
    const { session } = await loaded({ ...CONFIG });
    session.setBanner(BANNER);
    session.setMaintenance({ on: true, message: null });
    await session.refreshConfig();
    expect(session.config?.banner).toEqual(BANNER);
    expect(session.config?.maintenance.on).toBe(true);
  });

  it('takes over a change at the server even after an own one', async () => {
    const other = { ...BANNER, revision: 4, title: 'Other admin' };
    const { session } = await loaded({ ...CONFIG, banner: other });
    session.setBanner(BANNER);
    await session.refreshConfig();
    expect(session.config?.banner).toEqual(other);
  });

  it('loses the notice from a 503 when maintenance ends, without reloading', async () => {
    const running = { on: true, message: 'Until 6 pm' };
    const { session } = await loaded({ ...CONFIG, maintenance: running }, { ...CONFIG });
    session.noteMaintenance('Until 6 pm');
    expect(session.config?.maintenance).toEqual(running);

    await session.refreshConfig();
    expect(session.config?.maintenance).toEqual(running);
    await session.refreshConfig();
    expect(session.config?.maintenance).toEqual({ on: false, message: null });
  });

  it('notices the end even if `public/config` never reported the maintenance', async () => {
    const { session } = await loaded({ ...CONFIG });
    session.noteMaintenance(null);
    expect(session.config?.maintenance.on).toBe(true);
    await session.refreshConfig();
    expect(session.config?.maintenance.on).toBe(false);
  });

  it('shares a running fetch and keeps the last state without a response', async () => {
    const { calls } = mockApi({
      'GET public/config': [{ body: { ...CONFIG, banner: BANNER } }, { status: 500, body: { error: 'internal' } }],
      'GET auth/me': [{ body: ME }],
    });
    const session = new Session();
    await session.load();
    const before = calls.length;
    await Promise.all([session.refreshConfig(), session.refreshConfig()]);
    expect(calls).toHaveLength(before + 1);
    expect(session.config?.banner).toEqual(BANNER);
  });

  it('fetches nothing while the configuration is not loaded', async () => {
    const { calls } = mockApi({});
    await new Session().refreshConfig();
    expect(calls).toHaveLength(0);
  });

  it('fetches the configuration when the session ends from outside, and only then sets the account', async () => {
    const { calls } = mockApi({
      'GET public/config': [
        { body: CONFIG },
        { body: { ...CONFIG, maintenance: { on: true, message: 'Until 6 pm' } } },
      ],
      'GET auth/me': [{ body: ME }, { status: 401, body: { error: 'unauthorized' } }],
    });
    const session = new Session();
    await session.load();
    await session.refreshUser();
    expect(session.authed).toBe(false);
    expect(session.config?.maintenance.message).toBe('Until 6 pm');
    expect(calls.map((c) => c.path).at(-1)).toBe('public/config');
  });

  it('does not reload the configuration when only the account changes', async () => {
    const { calls } = mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [
        { status: 401, body: { error: 'unauthorized' } },
        { status: 401, body: { error: 'unauthorized' } },
        { body: ME },
      ],
    });
    const session = new Session();
    await session.load();
    await session.refreshUser();
    await session.refreshUser();
    expect(session.authed).toBe(true);
    expect(calls.filter((c) => c.path === 'public/config')).toHaveLength(1);
  });

  it('watchConfig() loads periodically while the page is visible, on returning and after an offline phase', async () => {
    const { session, calls } = await loaded(...Array.from({ length: 5 }, () => CONFIG));
    const count = () => calls.filter((c) => c.path === 'public/config').length;
    expect(count()).toBe(1);
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const stop = session.watchConfig();

    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);
    expect(count()).toBe(2);
    visibility.mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);
    expect(count()).toBe(2);
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(count()).toBe(3);
    network.simulate(true);
    network.simulate(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(count()).toBe(4);

    stop();
    network.simulate(true);
    network.simulate(false);
    await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS * 2);
    expect(count()).toBe(4);
  });

  it('does not hold up a session ended from outside on a hanging fetch', async () => {
    const { session } = await loaded();
    const limit = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(limit.signal);
    vi.stubGlobal('fetch', (input: string, init: RequestInit = {}) =>
      input.endsWith('auth/me')
        ? Promise.resolve(new Response('{"error":"unauthorized"}', { status: 401 }))
        : new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('Timeout')))),
    );

    const ended = session.refreshUser();
    await vi.waitFor(() => expect(timeout).toHaveBeenCalledWith(CONFIG_TIMEOUT_MS));
    expect(session.authed).toBe(true);
    limit.abort();
    await ended;

    expect(session.authed).toBe(false);
    expect(session.config?.maintenance.on).toBe(false);
  });
});

describe('End of the session and other tabs', () => {
  it('reports a different account or none, not the sign-in and not the same one', async () => {
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [
        { body: ME },
        { body: ME },
        { body: { ...ME, id: 'other' } },
        { status: 401, body: { error: 'unauthorized' } },
      ],
    });
    const session = new Session();
    const ended = vi.fn();
    session.onEnd(ended);
    await session.refreshUser();
    await session.refreshUser();
    expect(ended).not.toHaveBeenCalled();
    await session.refreshUser();
    expect(ended).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'other' }));
    await session.refreshUser();
    expect(ended).toHaveBeenLastCalledWith(null);
    expect(ended).toHaveBeenCalledTimes(2);
    expect(session.user).toBeNull();
  });

  it('asks the server when another tab names a different account, and does not hear its own announcement', async () => {
    const { calls } = mockApi({ 'GET public/config': [{ body: CONFIG }], 'GET auth/me': [{ body: ME }, { body: ME }] });
    const session = new Session();
    await session.load();
    const stop = session.watchTabs();
    const other = new BroadcastChannel(TAB_CHANNEL);
    const heard: unknown[] = [];
    other.onmessage = (event: MessageEvent<unknown>) => heard.push(event.data);
    const me = () => calls.filter((c) => c.path === 'auth/me');
    try {
      session.announce();
      other.postMessage(ME.id);
      other.postMessage(null);
      await vi.waitFor(() => expect(me()).toHaveLength(2));
      await vi.waitFor(() => expect(heard).toEqual([ME.id]));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(me()).toHaveLength(2);
      expect(session.user?.id).toBe(ME.id);
    } finally {
      other.close();
      stop();
    }
  });

  it('an older response of auth/me does not overwrite a newer one', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [
        async () => {
          await gate;
          return { status: 401, body: { error: 'unauthorized' } };
        },
        { body: ME },
      ],
    });
    const session = new Session();
    const ended = vi.fn();
    session.onEnd(ended);
    const stale = session.refreshUser();
    await session.refreshUser();
    release();
    await stale;
    expect(session.user?.id).toBe(ME.id);
    expect(ended).not.toHaveBeenCalled();
  });

  it('an older response of load() does not overwrite a newer one either', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { calls } = mockApi({
      'GET public/config': [{ body: CONFIG }],
      'GET auth/me': [
        async () => {
          await gate;
          return { status: 401, body: { error: 'unauthorized' } };
        },
        { body: ME },
      ],
    });
    const session = new Session();
    const ended = vi.fn();
    session.onEnd(ended);
    const stale = session.load();
    await vi.waitFor(() => expect(calls.some((c) => c.path === 'auth/me')).toBe(true));
    await session.refreshUser();
    release();
    await stale;
    expect(session.user?.id).toBe(ME.id);
    expect(session.status).toBe('ready');
    expect(ended).not.toHaveBeenCalled();
  });

  it("sets the server's state even if discarding fails", async () => {
    mockApi({ 'GET auth/me': [{ body: ME }, { body: { ...ME, id: 'other' } }] });
    const session = new Session();
    session.onEnd(() => {
      throw new Error('broken');
    });
    await session.refreshUser();
    await expect(session.refreshUser()).rejects.toThrow('broken');
    expect(session.user?.id).toBe('other');
  });
});

describe('mkLogo', () => {
  it('maps the kinds of branding', () => {
    expect(mkLogo(BRAND0, 'Roedy Mail')).toMatchObject({ isMark: true, isInit: false, text: 'R', fs: '50cqmin' });
    expect(mkLogo({ ...BRAND0, kind: 'Buchstabe', letter: 'RM' }, 'x')).toMatchObject({
      isInit: true,
      text: 'RM',
      fs: '38cqmin',
    });
    expect(mkLogo({ ...BRAND0, kind: 'icon', icon: 'ti-bug' }, 'x')).toMatchObject({ isIcon: true, icon: 'ti-bug' });
    expect(mkLogo({ ...BRAND0, kind: 'image', image: '/logo.png', fit: 'fill' }, 'x')).toMatchObject({
      isFill: true,
      isPad: false,
      src: '/logo.png',
    });
    expect(mkLogo({ ...BRAND0, kind: 'image', image: null }, 'post')).toMatchObject({
      isInit: true,
      isPad: false,
      text: 'P',
    });
  });
});

describe('initialsOf', () => {
  it('takes first and last word like ini()', () => {
    expect(initialsOf('Mustermann, Max')).toBe('MM');
    expect(initialsOf('Anna Maria Example')).toBe('AE');
    expect(initialsOf('lukas')).toBe('L');
    expect(initialsOf('')).toBe('?');
  });
});
