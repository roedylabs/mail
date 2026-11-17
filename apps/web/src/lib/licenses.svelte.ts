/**
 * All licenses: the third-party packages from `licenses.json` of the build
 * (plugin `vite/licenses.ts`) with their license texts, opened via the last row
 * under Settings › About › Licenses.
 *
 * `licenses` loads `/licenses.json` on the first open and keeps the list;
 * only after an error does the next open or "Try again" reload it.
 * `LicenseDialogState` holds search, origin and expanded row of the open
 * dialog, `licenseValues()` builds the values `lic` for the dialog from them.
 */
import type { IconName } from '#lib/icons.ts';
import { linkHref } from '#lib/links.ts';
import { m } from '#lib/paraglide/messages.js';
import { overlayClose, type OverlayEvent } from '#lib/shell.ts';
import { appFetch } from '#lib/state/network.svelte.ts';

export type LicenseOrigin = 'web' | 'server';

/** Package as in `licenses.json` (`LicensePackage` in `vite/licenses.ts`). */
export interface LicensePackage {
  name: string;
  version: string;
  /** SPDX expression as given in the package. */
  license: string;
  url?: string;
  origin: LicenseOrigin;
  /** Indices into `LicenseList.texts`; equal texts appear only once in the file. */
  texts: number[];
}

export interface LicenseList {
  packages: LicensePackage[];
  texts: string[];
}

/** Loading: never, running, loaded, failed (response without a list) or without a connection. */
export type LicenseStatus = 'idle' | 'busy' | 'ok' | 'fail' | 'offline';

/** Address of the list; the backend serves it like the web app (`web::static_files`). */
export const LICENSES_URL = '/licenses.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Checks the file (`version` 1); `null` if it does not fit. Packages with
 * wrong fields are dropped, as are references to missing texts; a package
 * that already occurs with origin, name and version counts only once (the
 * rows are keyed by it).
 */
export function parseLicenseList(data: unknown): LicenseList | null {
  if (!isRecord(data) || data.version !== 1 || !Array.isArray(data.packages) || !Array.isArray(data.texts)) return null;
  const texts = data.texts.map((t) => (typeof t === 'string' ? t : ''));
  const packages: LicensePackage[] = [];
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- only during the check, no state
  const seen = new Set<string>();
  for (const p of data.packages) {
    if (!isRecord(p)) continue;
    const { name, version, license, url, origin } = p;
    if (typeof name !== 'string' || typeof version !== 'string' || typeof license !== 'string') continue;
    if (origin !== 'web' && origin !== 'server') continue;
    const key = rowKey({ origin, name, version });
    if (seen.has(key)) continue;
    seen.add(key);
    const refs: unknown[] = Array.isArray(p.texts) ? p.texts : [];
    packages.push({
      name,
      version,
      license,
      ...(typeof url === 'string' && url ? { url } : {}),
      origin,
      texts: refs.filter(
        (i): i is number =>
          typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < texts.length && texts[i] !== '',
      ),
    });
  }
  return { packages, texts };
}

/** Key of a row, unique per list (`parseLicenseList`). */
function rowKey(p: Pick<LicensePackage, 'origin' | 'name' | 'version'>): string {
  return `${p.origin}:${p.name}@${p.version}`;
}

/** Loading including the body waits at most this long, then it counts as without a response. */
export const LICENSES_TIMEOUT_MS = 30_000;

/** Loaded list, once per app session. */
export class LicenseStore {
  status = $state<LicenseStatus>('idle');
  list = $state.raw<LicenseList | null>(null);

  private readonly fetcher: typeof fetch;
  /** Counts `reset()`; a load from before writes nothing any more. */
  private generation = 0;

  constructor(fetcher: typeof fetch = appFetch) {
    this.fetcher = fetcher;
  }

  /**
   * Loads while there is no list and no load is running. Without a response –
   * also if the body aborts or the timeout hits – "offline", a
   * response without a valid list "fail".
   */
  async load(): Promise<void> {
    if (this.status === 'ok' || this.status === 'busy') return;
    this.status = 'busy';
    const generation = this.generation;
    // As a function, not as a method: the native `fetch` requires `this` = window.
    const run = this.fetcher;
    let res: Response;
    let body: string;
    try {
      res = await run(LICENSES_URL, {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        signal: AbortSignal.timeout(LICENSES_TIMEOUT_MS),
      });
      body = res.ok ? await res.text() : '';
    } catch {
      if (generation === this.generation) this.status = 'offline';
      return;
    }
    let list: LicenseList | null;
    try {
      list = res.ok ? parseLicenseList(JSON.parse(body)) : null;
    } catch {
      list = null;
    }
    if (generation !== this.generation) return;
    this.list = list;
    this.status = list ? 'ok' : 'fail';
  }

  /** Forgets the list (tests). */
  reset(): void {
    this.generation++;
    this.status = 'idle';
    this.list = null;
  }
}

export const licenses = new LicenseStore();

/** Row of the list (`lic.rows[]`); `on` draws it expanded (surface, rotated chevron). */
export interface LicenseRow {
  key: string;
  name: string;
  version: string;
  /** SPDX expression; the tag shortens it with an ellipsis, the expanded row shows it in full. */
  lic: string;
  /** Project page, only `http(s)`; otherwise empty and `hasUrl` false. */
  url: string;
  hasUrl: boolean;
  site: string;
  /** "License:" before the full SPDX expression in the expanded row. */
  exprLabel: string;
  on: boolean;
  exp: 'true' | 'false';
  toggle: () => void;
  /** One scrollable, focusable field per license text (`label` as name); only for the expanded row. */
  texts: { t: string; label: string }[];
  noText: boolean;
  noTextLabel: string;
}

/** Option of the segment "Origin" (`lic.segs[]`, radio group). */
export interface LicenseSeg {
  id: LicenseOrigin;
  label: string;
  /** Packages of this origin that match the search. */
  n: string;
  on: 'true' | 'false';
  onClick: () => void;
}

/** Values `lic` of the licenses dialog; the component sets style values from `on`. */
export interface LicenseValues {
  title: string;
  /** Count and app name, while loading "Loading licenses …", otherwise empty. */
  sub: string;
  close: () => void;
  /** Click on the backdrop on desktop: only closes if it was hit itself (`overlayClose`). */
  overlay: (event: OverlayEvent) => void;
  /** List loaded: search field and segment visible. */
  ready: boolean;
  busy: boolean;
  busyAttr: 'true' | 'false';
  loading: string;
  skel: { w: string }[];
  fail: boolean;
  failTitle: string;
  failText: string;
  retry: () => void;
  /** Card instead of list: server list missing or no matches. */
  note: boolean;
  noteIcon: IconName;
  noteTitle: string;
  noteText: string;
  q: string;
  onQ: (q: string) => void;
  ph: string;
  segs: LicenseSeg[];
  rows: LicenseRow[];
}

export interface LicenseInput {
  status: LicenseStatus;
  list: LicenseList | null;
  appName: string;
  q: string;
  seg: LicenseOrigin;
  /** Key of the expanded row. */
  exp: string | null;
}

export interface LicenseContext {
  close: () => void;
  retry: () => void;
  setQ: (q: string) => void;
  setSeg: (seg: LicenseOrigin) => void;
  setExp: (key: string | null) => void;
}

/** Widths of the placeholder rows while loading. */
const SKEL = ['46%', '34%', '52%', '28%', '40%', '36%'];

export function licenseValues(input: LicenseInput, ctx: LicenseContext): LicenseValues {
  const { status, list, seg } = input;
  const ready = status === 'ok' && list !== null;
  const busy = status === 'busy' || status === 'idle';
  const all = ready ? list.packages : [];
  // Built without `cargo about` (`pnpm build` instead of `just web`): no server packages.
  const noSrv = ready && !all.some((p) => p.origin === 'server');
  const q = input.q.trim().toLowerCase();
  // Search once per computation; rows and origin counters take the matches.
  const hits = q ? all.filter((p) => `${p.name} ${p.version} ${p.license}`.toLowerCase().includes(q)) : all;
  const rows = hits
    .filter((p) => p.origin === seg)
    .map((p): LicenseRow => {
      const key = rowKey(p);
      const on = input.exp === key;
      const href = p.url ? linkHref(p.url) : null;
      return {
        key,
        name: p.name,
        version: p.version,
        lic: p.license,
        url: href ?? '',
        hasUrl: href !== null,
        site: m.lic_site(),
        exprLabel: m.lic_expr(),
        on,
        exp: on ? 'true' : 'false',
        toggle: () => ctx.setExp(on ? null : key),
        // Only the expanded row needs license texts.
        texts: (on ? p.texts : []).map((i, j) => ({
          t: list!.texts[i]!,
          label:
            p.texts.length > 1
              ? m.lic_text_label_of({ name: p.name, i: j + 1, n: p.texts.length })
              : m.lic_text_label({ name: p.name }),
        })),
        noText: p.texts.length === 0,
        noTextLabel: m.lic_no_text(),
      };
    });
  const segs = (
    [
      ['web', m.lic_web()],
      ['server', m.lic_server()],
    ] as const
  ).map(([id, label]): LicenseSeg => ({
    id,
    label,
    n: String(hits.filter((p) => p.origin === id).length),
    on: seg === id ? 'true' : 'false',
    onClick: () => {
      ctx.setSeg(id);
      ctx.setExp(null);
    },
  }));
  const srvGone = noSrv && seg === 'server';
  const none = ready && !srvGone && rows.length === 0;
  const count = all.length;

  return {
    title: m.lic_title(),
    sub: ready
      ? count === 1
        ? m.lic_sub_one({ app: input.appName })
        : m.lic_sub({ count, app: input.appName })
      : busy
        ? m.lic_loading()
        : '',
    close: ctx.close,
    overlay: overlayClose(ctx.close),
    ready,
    busy,
    busyAttr: busy ? 'true' : 'false',
    loading: m.lic_loading(),
    skel: SKEL.map((w) => ({ w })),
    fail: status === 'fail' || status === 'offline',
    failTitle: m.lic_fail_title(),
    failText: status === 'offline' ? m.error_offline() : m.error_act(),
    retry: ctx.retry,
    note: srvGone || none,
    noteIcon: srvGone ? 'ti-server-off' : 'ti-search-off',
    noteTitle: srvGone ? m.lic_no_server_title() : m.lic_empty_title(),
    noteText: srvGone ? m.lic_no_server_text() : m.lic_empty_text(),
    q: input.q,
    onQ: (value) => {
      ctx.setQ(value);
      ctx.setExp(null);
    },
    ph: m.lic_search(),
    segs,
    rows,
  };
}

/**
 * State of the open dialog: empty when opened, "Web app" chosen, nothing
 * expanded; loads the list if needed.
 */
export class LicenseDialogState {
  open = $state(false);
  q = $state('');
  seg = $state<LicenseOrigin>('web');
  exp = $state<string | null>(null);

  private readonly store: LicenseStore;

  constructor(store: LicenseStore = licenses) {
    this.store = store;
  }

  show = (): void => {
    this.q = '';
    this.seg = 'web';
    this.exp = null;
    this.open = true;
    void this.store.load();
  };

  close = (): void => {
    this.open = false;
    this.exp = null;
  };

  values(appName: string): LicenseValues {
    return licenseValues(
      { status: this.store.status, list: this.store.list, appName, q: this.q, seg: this.seg, exp: this.exp },
      {
        close: this.close,
        retry: () => void this.store.load(),
        setQ: (q) => (this.q = q),
        setSeg: (seg) => (this.seg = seg),
        setExp: (key) => (this.exp = key),
      },
    );
  }
}
