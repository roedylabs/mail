import { describe, expect, it, vi } from 'vitest';
import {
  LicenseDialogState,
  LicenseStore,
  licenseValues,
  parseLicenseList,
  type LicenseInput,
  type LicenseList,
} from '#lib/licenses.svelte.ts';

/** Like `licenses.json` (format `vite/licenses.ts`), packages made up for the test. */
const FILE = {
  version: 1,
  generated: '2026-11-12T00:00:00.000Z',
  packages: [
    {
      name: '@fontsource-variable/nunito-sans',
      version: '5.3.0',
      license: 'OFL-1.1',
      url: 'https://fontsource.org/fonts/nunito-sans',
      origin: 'web',
      texts: [0],
    },
    { name: 'svelte', version: '5.40.0', license: 'MIT', url: 'https://svelte.dev', origin: 'web', texts: [1] },
    { name: 'no-text', version: '1.0.0', license: 'ISC', url: 'javascript:alert(1)', origin: 'web', texts: [] },
    {
      name: 'axum',
      version: '0.8.6',
      license: 'MIT',
      url: 'https://github.com/tokio-rs/axum',
      origin: 'server',
      texts: [1],
    },
    {
      name: 'ring',
      version: '0.17.14',
      license: 'Apache-2.0 AND ISC',
      origin: 'server',
      texts: [2, 1],
    },
  ],
  texts: ['Copyright 2016 The Nunito Sans Project Authors', 'MIT License …', 'Apache License 2.0 …'],
};

const LIST = parseLicenseList(FILE)!;

function values(patch: Partial<LicenseInput> = {}) {
  const ctx = { close: vi.fn(), retry: vi.fn(), setQ: vi.fn(), setSeg: vi.fn(), setExp: vi.fn() };
  const input: LicenseInput = {
    status: 'ok',
    list: LIST,
    appName: 'Roedy Mail',
    q: '',
    seg: 'web',
    exp: null,
    ...patch,
  };
  return { ctx, lic: licenseValues(input, ctx) };
}

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

describe('parseLicenseList', () => {
  it('reads packages and texts in the format of the build', () => {
    expect(LIST.packages).toHaveLength(5);
    expect(LIST.packages[0]).toEqual(FILE.packages[0]);
    expect(LIST.texts).toEqual(FILE.texts);
  });

  it('rejects another version or missing lists', () => {
    expect(parseLicenseList({ ...FILE, version: 2 })).toBeNull();
    expect(parseLicenseList({ version: 1, packages: [] })).toBeNull();
    expect(parseLicenseList('<!doctype html>')).toBeNull();
    expect(parseLicenseList(null)).toBeNull();
  });

  it('counts duplicate packages only once', () => {
    const list = parseLicenseList({ ...FILE, packages: [...FILE.packages, { ...FILE.packages[1], license: 'ISC' }] })!;
    expect(list.packages.map((p) => `${p.origin}:${p.name}@${p.version}`)).toEqual([
      'web:@fontsource-variable/nunito-sans@5.3.0',
      'web:svelte@5.40.0',
      'web:no-text@1.0.0',
      'server:axum@0.8.6',
      'server:ring@0.17.14',
    ]);
    expect(list.packages[1]!.license).toBe('MIT');
  });

  it('leaves out broken packages and references to missing texts', () => {
    const list = parseLicenseList({
      ...FILE,
      packages: [
        { name: 'a', version: '1', license: 'MIT', origin: 'web', texts: [0, 7, -1, 1.5, '0'] },
        { name: 'b', version: '1', license: 'MIT', origin: 'cli', texts: [] },
        { name: 'c', version: 1, license: 'MIT', origin: 'web', texts: [] },
        { name: 'd', version: '1', license: 'MIT', url: '', origin: 'server' },
      ],
    })!;
    expect(list.packages).toEqual([
      { name: 'a', version: '1', license: 'MIT', origin: 'web', texts: [0] },
      { name: 'd', version: '1', license: 'MIT', origin: 'server', texts: [] },
    ]);
  });
});

describe('licenseValues', () => {
  it('shows the web packages in file order when loaded, with the count of all packages', () => {
    const { lic } = values();
    expect(lic.title).toBe('All licenses');
    expect(lic.sub).toBe('5 packages that Roedy Mail ships');
    expect(lic).toMatchObject({ ready: true, busy: false, busyAttr: 'false', fail: false, note: false });
    expect(lic.ph).toBe('Search packages or licenses');
    expect(lic.rows.map((r) => [r.name, r.version, r.lic])).toEqual([
      ['@fontsource-variable/nunito-sans', '5.3.0', 'OFL-1.1'],
      ['svelte', '5.40.0', 'MIT'],
      ['no-text', '1.0.0', 'ISC'],
    ]);
    expect(lic.segs.map((s) => [s.label, s.n, s.on])).toEqual([
      ['Web app', '3', 'true'],
      ['Server', '2', 'false'],
    ]);
  });

  it('names a single package in the singular', () => {
    const list: LicenseList = { packages: LIST.packages.slice(3, 4), texts: LIST.texts };
    expect(values({ list, seg: 'server' }).lic.sub).toBe('1 package that Roedy Mail ships');
  });

  it('expands a row with project page and license texts', () => {
    const { lic, ctx } = values({ seg: 'server', exp: 'server:ring@0.17.14' });
    const [axum, ring] = lic.rows;
    expect(axum).toMatchObject({ on: false, exp: 'false', hasUrl: true, url: 'https://github.com/tokio-rs/axum' });
    expect(ring).toMatchObject({ on: true, exp: 'true', hasUrl: false, url: '', site: 'Project page', noText: false });
    expect(ring!.texts).toEqual([
      { t: 'Apache License 2.0 …', label: 'License text of ring (1 of 2)' },
      { t: 'MIT License …', label: 'License text of ring (2 of 2)' },
    ]);
    // Collapsed without texts (only the expanded row needs them).
    expect(axum).toMatchObject({ texts: [], noText: false });
    expect(values({ seg: 'server', exp: 'server:axum@0.8.6' }).lic.rows[0]!.texts).toEqual([
      { t: 'MIT License …', label: 'License text of axum' },
    ]);
    ring!.toggle();
    expect(ctx.setExp).toHaveBeenLastCalledWith(null);
    axum!.toggle();
    expect(ctx.setExp).toHaveBeenLastCalledWith('server:axum@0.8.6');
  });

  it('links only http(s) and names packages without a license text', () => {
    const row = values().lic.rows[2]!;
    expect(row).toMatchObject({ hasUrl: false, url: '', noText: true, texts: [] });
    expect(row.noTextLabel).toBe('This package has no license text of its own.');
  });

  it('searches name, version and license case-insensitively and counts per origin', () => {
    expect(values({ q: '  mit ' }).lic.rows.map((r) => r.name)).toEqual(['svelte']);
    expect(values({ q: 'mit' }).lic.segs.map((s) => s.n)).toEqual(['1', '1']);
    expect(values({ q: 'isc' }).lic.segs.map((s) => s.n)).toEqual(['1', '1']);
    expect(values({ q: '0.17', seg: 'server' }).lic.rows.map((r) => r.name)).toEqual(['ring']);
    expect(values({ q: 'NUNITO' }).lic.rows).toHaveLength(1);
  });

  it('shows the card “No packages found” without matches', () => {
    const { lic } = values({ q: 'does-not-exist' });
    expect(lic).toMatchObject({ ready: true, note: true, noteIcon: 'ti-search-off', rows: [] });
    expect(lic.noteTitle).toBe('No packages found');
    expect(lic.noteText).toBe('Check the spelling or try a different search term.');
  });

  it('reports a build without a server list under “Server”', () => {
    const list: LicenseList = { packages: LIST.packages.filter((p) => p.origin === 'web'), texts: LIST.texts };
    expect(values({ list }).lic.note).toBe(false);
    const { lic } = values({ list, seg: 'server' });
    expect(lic.segs.map((s) => s.n)).toEqual(['3', '0']);
    expect(lic).toMatchObject({ note: true, noteIcon: 'ti-server-off', rows: [] });
    expect(lic.noteTitle).toBe('The list of server packages is missing');
    // Even with a search term it stays the card of the missing list.
    expect(values({ list, seg: 'server', q: 'x' }).lic.noteIcon).toBe('ti-server-off');
  });

  it('shows placeholders while loading and the status as subtitle', () => {
    const { lic } = values({ status: 'busy', list: null });
    expect(lic).toMatchObject({ ready: false, busy: true, busyAttr: 'true', fail: false, note: false, rows: [] });
    expect(lic.sub).toBe('Loading licenses …');
    expect(lic.loading).toBe('Loading licenses …');
    expect(lic.skel.map((s) => s.w)).toEqual(['46%', '34%', '52%', '28%', '40%', '36%']);
  });

  it('shows the error card on failure, without a connection with the offline text', () => {
    const fail = values({ status: 'fail', list: null });
    expect(fail.lic).toMatchObject({ ready: false, busy: false, fail: true, note: false, sub: '' });
    expect(fail.lic.failTitle).toBe('Couldn’t load the license list');
    expect(fail.lic.failText).toBe('That didn’t work. Please try again.');
    fail.lic.retry();
    expect(fail.ctx.retry).toHaveBeenCalledOnce();
    expect(values({ status: 'offline', list: null }).lic.failText).toBe('No connection. Please try again.');
  });

  it('collapses when searching and when changing the origin', () => {
    const { lic, ctx } = values({ exp: 'web:svelte@5.40.0' });
    lic.onQ('svel');
    expect(ctx.setQ).toHaveBeenCalledWith('svel');
    expect(ctx.setExp).toHaveBeenLastCalledWith(null);
    ctx.setExp.mockClear();
    lic.segs[1]!.onClick();
    expect(ctx.setSeg).toHaveBeenCalledWith('server');
    expect(ctx.setExp).toHaveBeenCalledWith(null);
  });

  it('closes via the backdrop only if it was hit itself', () => {
    const { lic, ctx } = values();
    const scrim = document.createElement('div');
    const dialog = scrim.appendChild(document.createElement('div'));
    scrim.addEventListener('mousedown', lic.overlay);
    dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(ctx.close).not.toHaveBeenCalled();
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    scrim.dispatchEvent(down);
    expect(ctx.close).toHaveBeenCalledOnce();
    // Otherwise the click of the row would take back the focus that the focus trap returns.
    expect(down.defaultPrevented).toBe(true);
  });
});

describe('LicenseStore', () => {
  it('loads the first time and keeps the list', async () => {
    const fetcher = vi.fn(() => Promise.resolve(response(JSON.stringify(FILE))));
    const store = new LicenseStore(fetcher);
    expect(store.status).toBe('idle');
    const first = store.load();
    expect(store.status).toBe('busy');
    // A second open during loading does not ask again.
    await store.load();
    await first;
    expect(store.status).toBe('ok');
    expect(store.list?.packages).toHaveLength(5);
    await store.load();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('/licenses.json', expect.objectContaining({ credentials: 'same-origin' }));
  });

  it('reports a response without a list as failed and reloads next time', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response('', 404))
      .mockResolvedValueOnce(response('<!doctype html><title>Roedy Mail</title>'))
      .mockResolvedValueOnce(response(JSON.stringify(FILE)));
    const store = new LicenseStore(fetcher);
    await store.load();
    expect(store.status).toBe('fail');
    await store.load();
    expect(store.status).toBe('fail');
    expect(store.list).toBeNull();
    await store.load();
    expect(store.status).toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('reports "offline" without a response, even if the body aborts', async () => {
    const store = new LicenseStore(() => Promise.reject(new TypeError('Failed to fetch')));
    await store.load();
    expect(store.status).toBe('offline');

    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('network error'));
        },
      }),
    );
    const cut = new LicenseStore(() => Promise.resolve(broken));
    await cut.load();
    expect(cut.status).toBe('offline');
  });

  it('calls fetch as a function with a timeout and forgets the list with reset()', async () => {
    let signal: AbortSignal | null | undefined;
    // Like the native fetch: fails when it runs as a method of another object.
    function strictFetch(this: unknown, _url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      signal = init?.signal;
      return Promise.resolve(response(JSON.stringify(FILE)));
    }
    const store = new LicenseStore(strictFetch);
    await store.load();
    expect(store.status).toBe('ok');
    expect(signal).toBeInstanceOf(AbortSignal);
    store.reset();
    expect(store).toMatchObject({ status: 'idle', list: null });
  });

  it('lets a load from before reset() write nothing any more', async () => {
    let answer: (res: Response) => void = () => {};
    const store = new LicenseStore(() => new Promise<Response>((resolve) => (answer = resolve)));
    const pending = store.load();
    store.reset();
    answer(response(JSON.stringify(FILE)));
    await pending;
    expect(store).toMatchObject({ status: 'idle', list: null });
  });
});

describe('LicenseDialogState', () => {
  it('opens empty with “Web app”, loads and closes collapsed', async () => {
    const store = new LicenseStore(() => Promise.resolve(response(JSON.stringify(FILE))));
    const dialog = new LicenseDialogState(store);
    dialog.q = 'old';
    dialog.seg = 'server';
    dialog.exp = 'server:axum@0.8.6';
    dialog.show();
    expect(dialog).toMatchObject({ open: true, q: '', seg: 'web', exp: null });
    expect(dialog.values('Roedy Mail').busy).toBe(true);
    await vi.waitFor(() => expect(store.status).toBe('ok'));

    const lic = dialog.values('Roedy Mail');
    lic.rows[1]!.toggle();
    expect(dialog.exp).toBe('web:svelte@5.40.0');
    lic.onQ('svelte');
    expect(dialog).toMatchObject({ q: 'svelte', exp: null });
    lic.segs[1]!.onClick();
    expect(dialog.seg).toBe('server');
    lic.close();
    expect(dialog).toMatchObject({ open: false, exp: null });
  });

  it('reloads after an error via “Try again”', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(response(JSON.stringify(FILE)));
    const store = new LicenseStore(fetcher);
    const dialog = new LicenseDialogState(store);
    dialog.show();
    await vi.waitFor(() => expect(store.status).toBe('offline'));
    dialog.values('Roedy Mail').retry();
    await vi.waitFor(() => expect(store.status).toBe('ok'));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
