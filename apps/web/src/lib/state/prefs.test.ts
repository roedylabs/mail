import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, type Call } from './fetch-mock.ts';
import { LANG_KEY } from '#lib/locale.ts';
import { Prefs, RESET0, displayZone, knownSettings, type Settings } from './prefs.svelte.ts';

const stored = (version: number, patch: Partial<Settings> = {}) => ({ version, settings: { ...RESET0, ...patch } });

/** Response like the backend: takes over the sent fields and increments the version. */
const saved = (base: Partial<Settings>, version: number) => (call: Call) => ({
  body: stored(version, { ...base, ...(call.body as { settings: Partial<Settings> }).settings }),
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prefs', () => {
  it('has the developer settings', () => {
    expect(Object.keys(RESET0)).toEqual(expect.arrayContaining(['devDebug', 'devLevel', 'devOffline']));
  });

  it('falls back to the defaults for unknown values', async () => {
    const unknown = { mode: 'bright', accent: 'chartreuse', fontSize: 'huge', region: 'Atlantis', timeFmt: '12 hours' };
    mockApi({
      'GET settings': [
        { body: { version: 2, settings: { ...RESET0, ...unknown, tzAuto: false, numFmt: '1,234.56' } } },
      ],
    });
    const prefs = new Prefs();
    await prefs.load();
    expect(prefs.values).toMatchObject({
      mode: null,
      accent: null,
      fontSize: 'medium',
      region: 'GB',
      timeFmt: '24h',
      numFmt: '1,234.56',
    });
  });

  it('keeps known values and fields without a fixed choice', () => {
    const known = { mode: 'system', accent: 'sky', region: 'AT', devLevel: 'debug', tz: 'Asia/Tokyo' } as const;
    expect(knownSettings({ ...known, density: 'Compact' as Settings['density'] })).toEqual(known);
  });

  it('changes only locally for guests', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const prefs = new Prefs();
    prefs.set({ mode: 'light' });
    expect(prefs.values.mode).toBe('light');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('loads the settings and reports the time zone with tzAuto', async () => {
    const { calls } = mockApi({
      'GET settings': [{ body: stored(3, { tz: 'Europe/Berlin' }) }],
      'PUT settings': [saved({ tz: 'Europe/Berlin' }, 4)],
    });
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      timeZone: 'America/New_York',
    } as Intl.ResolvedDateTimeFormatOptions);
    const prefs = new Prefs();
    await prefs.load();
    await prefs.settled();
    expect(calls[1]).toMatchObject({ method: 'PUT', body: { version: 3, settings: { tz: 'America/New_York' } } });
    expect(prefs.version).toBe(4);
    expect(prefs.values.tz).toBe('America/New_York');
    vi.restoreAllMocks();
  });

  it('does not report the time zone without tzAuto or when it matches', async () => {
    const { calls } = mockApi({ 'GET settings': [{ body: stored(1, { tzAuto: false, tz: 'Asia/Tokyo' }) }] });
    const prefs = new Prefs();
    await prefs.load();
    prefs.reportTimeZone('Europe/Berlin');
    prefs.set({ tzAuto: false });
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { version: 1, settings: { tzAuto: false } },
    ]);
  });

  it('sends only changed fields with the version and collects changes during a request', async () => {
    const { calls } = mockApi({
      'GET settings': [{ body: stored(1, { tzAuto: false }) }],
      'PUT settings': [saved({ tzAuto: false }, 2), saved({ tzAuto: false, mode: 'light' }, 3)],
    });
    const prefs = new Prefs();
    await prefs.load();
    prefs.set({ mode: 'light' });
    prefs.set({ density: 'compact' });
    prefs.set({ animations: false });
    await prefs.settled();
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { version: 1, settings: { mode: 'light' } },
      { version: 2, settings: { density: 'compact', animations: false } },
    ]);
    expect(prefs.version).toBe(3);
    expect(prefs.values).toMatchObject({ mode: 'light', density: 'compact', animations: false });
  });

  it('applies the own change to the new state on version_conflict', async () => {
    const { calls } = mockApi({
      'GET settings': [{ body: stored(1, { tzAuto: false }) }],
      'PUT settings': [
        { status: 409, body: { error: 'version_conflict', ...stored(5, { tzAuto: false, accent: 'rose' }) } },
        saved({ tzAuto: false, accent: 'rose' }, 6),
      ],
    });
    const prefs = new Prefs();
    await prefs.load();
    prefs.set({ mode: 'dark' });
    await prefs.settled();
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { version: 1, settings: { mode: 'dark' } },
      { version: 5, settings: { mode: 'dark' } },
    ]);
    expect(prefs.version).toBe(6);
    expect(prefs.values).toMatchObject({ mode: 'dark', accent: 'rose' });
    expect(prefs.error).toBeNull();
  });

  it('resets the fields to the confirmed state on an error', async () => {
    mockApi({
      'GET settings': [{ body: stored(2, { tzAuto: false, density: 'comfortable' }) }],
      'PUT settings': [
        { status: 422, body: { error: 'invalid', fields: { settings: { density: { code: 'invalid' } } } } },
      ],
    });
    const prefs = new Prefs();
    await prefs.load();
    prefs.set({ density: 'compact' });
    expect(prefs.values.density).toBe('compact');
    await prefs.settled();
    expect(prefs.values.density).toBe('comfortable');
    expect(prefs.error).toMatchObject({ status: 422, code: 'invalid' });
  });

  it('gives up after repeated conflicts', async () => {
    const conflict = { status: 409, body: { error: 'version_conflict', ...stored(9, { tzAuto: false }) } };
    const { calls } = mockApi({
      'GET settings': [{ body: stored(1, { tzAuto: false }) }],
      'PUT settings': [conflict, conflict, conflict],
    });
    const prefs = new Prefs();
    await prefs.load();
    prefs.set({ greet: false });
    await prefs.settled();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(3);
    expect(prefs.values.greet).toBeNull();
    expect(prefs.error).toMatchObject({ status: 409 });
    // The newest server state applies anyway; the next change starts with its version.
    expect(prefs.version).toBe(9);
  });

  it('discards responses that arrive after reset()', async () => {
    let answer!: (reply: Response) => void;
    mockApi({ 'GET settings': [{ body: stored(1, { tzAuto: false, mode: 'light' }) }] });
    const prefs = new Prefs();
    await prefs.load();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => (answer = resolve))),
    );
    prefs.set({ mode: 'dark' });
    prefs.reset();
    answer(new Response(JSON.stringify(stored(2, { tzAuto: false, mode: 'dark' })), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prefs.values).toEqual(RESET0);
    expect(prefs.version).toBe(0);
    expect(prefs.error).toBeNull();
  });

  it('returns to the defaults with reset()', async () => {
    mockApi({ 'GET settings': [{ body: stored(4, { tzAuto: false, mode: 'light' }) }] });
    const prefs = new Prefs();
    await prefs.load();
    prefs.reset();
    expect(prefs.values).toEqual(RESET0);
    expect(prefs.remote).toBe(false);
  });
});

describe('Language', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('guests start with the device language, after sign-out with the remembered one', () => {
    vi.stubGlobal('navigator', { languages: ['en-US', 'de-DE'], language: 'en-US' });
    expect(new Prefs().values.lang).toBe('en');
    localStorage.setItem(LANG_KEY, 'de');
    const prefs = new Prefs();
    expect(prefs.values.lang).toBe('de');
    localStorage.setItem(LANG_KEY, 'en');
    prefs.reset();
    expect(prefs.values.lang).toBe('en');
  });

  it('a new account takes over the sign-in language, a saved one does not', async () => {
    localStorage.setItem(LANG_KEY, 'de');
    const fresh = mockApi({
      'GET settings': [{ body: stored(0, { tzAuto: false }) }],
      'PUT settings': [saved({ tzAuto: false }, 1)],
    });
    const first = new Prefs();
    await first.load();
    await first.settled();
    expect(fresh.calls[1]).toMatchObject({ method: 'PUT', body: { version: 0, settings: { lang: 'de' } } });
    expect(first.values.lang).toBe('de');

    const known = mockApi({ 'GET settings': [{ body: stored(2, { tzAuto: false, lang: 'en' }) }] });
    const later = new Prefs();
    await later.load();
    expect(later.values.lang).toBe('en');
    expect(known.calls.filter((c) => c.method === 'PUT')).toEqual([]);
  });
});

describe('Start without network', () => {
  it('takes over the copy like a server state', () => {
    const prefs = new Prefs();
    prefs.fromCopy({ version: 4, settings: { ...prefs.values, gStart: 'last' } });
    expect(prefs.loaded).toBe(true);
    expect(prefs.remote).toBe(true);
    expect(prefs.version).toBe(4);
    expect(prefs.values.gStart).toBe('last');
  });
});

describe('displayZone', () => {
  it('takes the device zone with tzAuto, without a usable one the stored one, otherwise tz', () => {
    expect(displayZone({ tzAuto: true, tz: 'Europe/Berlin' }, 'Asia/Tokyo')).toBe('Asia/Tokyo');
    expect(displayZone({ tzAuto: true, tz: 'Europe/Berlin' }, undefined)).toBe('Europe/Berlin');
    expect(displayZone({ tzAuto: false, tz: 'Europe/Berlin' }, 'Asia/Tokyo')).toBe('Europe/Berlin');
  });
});
