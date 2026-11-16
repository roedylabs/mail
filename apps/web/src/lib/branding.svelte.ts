/**
 * Administration › Branding against `GET/PUT admin/branding`: app name, logo
 * with upload, brand colour with `userAccent` and sign-in page, preview
 * (`brPrev`) and the bar "Unsaved changes" (`brDirty`, `brSave`, `brDiscard`,
 * `brReset` of the shell).
 *
 * One source counts as saved: `name` and `branding` in `session.config`
 * (from `public/config`); only the name and details of the logo file
 * (`imageName`, `imageMeta`) are known solely to `admin/branding`. The page
 * holds the inputs on top and reloads `admin/branding` when opened. Saving takes
 * over the draft at once – logo, colours and sign-in page follow – and only
 * sends it after the toast "Changes saved" has run out (`ui.toasts.defer`), only
 * the changed fields; a new logo as a data URL with name and details, otherwise
 * the previous address stays. "Undo" resets state and inputs. If sending fails,
 * the draft is back with the bar; the page shows logo errors in `brErr`, all
 * others in the error toast.
 */
import { ACCENTS, DEFAULT_ACCENT, PLATES, type AccentName } from '@roedy/tokens';
import { ApiError, api, fieldsOf, isApiError } from '#lib/api.ts';
import { accentLabel, type SegOption } from '#lib/appearance.ts';
import type { Toggle } from '#lib/banner.svelte.ts';
import { failText } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import { mkLogo, type LogoValues } from '#lib/logo.ts';
import { m } from '#lib/paraglide/messages.js';
import { onForget } from '#lib/state/forget.ts';
import { BRAND0, session, type Branding, type PlateName } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { intlLocale } from '#lib/locale.ts';

export type BrandingSection = 'name' | 'logo' | 'color' | 'login';

/** Kinds of logo (`brKindOpts`); the values are those of the API. */
export const KINDS = ['standard', 'initial', 'icon', 'image'] as const;
export type KindName = (typeof KINDS)[number];
/** Display of an image (`brFitOpts`). */
export const FITS = ['padded', 'fill'] as const;
export type FitName = (typeof FITS)[number];

/** `GET/PUT admin/branding`: `name` `null` means the default app name. */
export interface AdminBranding extends Branding {
  name: string | null;
  imageName: string;
  imageMeta: string;
}

/** Inputs of the branding form: `name` is the shown name (`bNm`), `image` the address or a data URL. */
export interface BrandingDraft extends Branding {
  name: string;
  imageName: string;
  imageMeta: string;
}

/** Fields of `public/config` › `branding`. */
const BRANDING_KEYS = [
  'kind',
  'letter',
  'icon',
  'image',
  'fit',
  'plate',
  'tilt',
  'color',
  'userAccent',
  'loginTitle',
  'loginText',
  'loginArt',
] as const satisfies readonly (keyof Branding)[];

/** Fields of the draft (the keys of `BRAND0`). */
export const DRAFT_KEYS = [
  'name',
  ...BRANDING_KEYS,
  'imageName',
  'imageMeta',
] as const satisfies readonly (keyof BrandingDraft)[];

/** Maximum lengths of the text inputs. */
export const BRANDING_MAX = { name: 32, letter: 2, loginTitle: 48, loginText: 120 } as const;

/** Largest logo file in bytes (1 MiB). */
export const MAX_FILE = 1_048_576;

/** Accepted logo formats. */
const FILE_TYPES = /^image\/(png|jpeg|webp|svg\+xml)$/;

/** Icons to choose from for the logo. */
export const BRAND_ICONS: readonly [IconName, () => string][] = [
  ['ti-mountain', m.branding_icon_mountain],
  ['ti-leaf', m.branding_icon_leaf],
  ['ti-bolt', m.branding_icon_bolt],
  ['ti-flame', m.branding_icon_flame],
  ['ti-star', m.branding_icon_star],
  ['ti-heart', m.branding_icon_heart],
  ['ti-cloud', m.branding_icon_cloud],
  ['ti-compass', m.branding_icon_compass],
  ['ti-diamond', m.branding_icon_diamond],
  ['ti-rocket', m.branding_icon_rocket],
  ['ti-feather', m.branding_icon_feather],
  ['ti-planet', m.branding_icon_planet],
];

const KIND_LABELS: Record<KindName, () => string> = {
  standard: m.branding_kind_standard,
  initial: m.branding_kind_initial,
  icon: m.branding_kind_icon,
  image: m.branding_kind_image,
};

const FIT_LABELS: Record<FitName, () => string> = {
  padded: m.branding_fit_pad,
  fill: m.branding_fit_fill,
};

const PLATE_LABELS: Record<PlateName, () => string> = {
  accent: m.branding_plate_accent,
  light: m.branding_plate_light,
  dark: m.branding_plate_dark,
};

/** Section tabs (`brTabs`). */
const BR_TABS: readonly [BrandingSection, () => string][] = [
  ['name', m.branding_tab_name],
  ['logo', m.branding_tab_logo],
  ['color', m.branding_tab_color],
  ['login', m.branding_tab_login],
];

/**
 * Logo errors from `fields.image` or from the check in the browser
 * (`readFile`) with their texts.
 */
const IMAGE_ERRORS = {
  unsupported: m.branding_file_unsupported,
  too_large: m.branding_file_too_large,
  unreadable: m.branding_file_unreadable,
  svg_text: m.branding_file_svg_text,
  dimensions: m.branding_file_dimensions,
} as const;
export type ImageError = keyof typeof IMAGE_ERRORS;

export function imageErrorText(code: ImageError): string {
  return IMAGE_ERRORS[code]();
}

/** Code at `fields.image` from 422 `invalid`, if the page shows it in `brErr`. */
export function imageErrorOf(error: unknown): ImageError | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const code = fieldsOf(error).image?.code;
  return code !== undefined && Object.hasOwn(IMAGE_ERRORS, code) ? (code as ImageError) : null;
}

/** File details: "PNG · 12 KB". */
export function fileMeta(file: Pick<File, 'type' | 'size'>): string {
  const type =
    file.type === 'image/svg+xml'
      ? 'SVG'
      : file.type === 'image/jpeg'
        ? 'JPG'
        : (file.type.split('/')[1] ?? '').toUpperCase();
  const kb = Math.max(1, Math.round(file.size / 1024));
  return m.branding_file_meta({ type, kb: kb.toLocaleString(intlLocale()) });
}

/** Checks format and size of a file before reading it. */
export function checkFile(file: Pick<File, 'type' | 'size'>): ImageError | null {
  if (!FILE_TYPES.test(file.type)) return 'unsupported';
  if (file.size > MAX_FILE) return 'too_large';
  return null;
}

/** Largest pixel size of a logo in width and height. */
export const MAX_PIXELS = 4096;

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Fallback without a parser: `<text` or `<svg:text`. */
const SVG_TEXT = /<(svg:)?text[\s/>]/i;

/**
 * Element `<text>` in an SVG; the server does not draw
 * text and rejects it. Checked on the parsed document so that `<text` in
 * comments, CDATA or `<style>` does not count: in the SVG namespace (also as
 * `<svg:text>`) and without a namespace, in case the SVG declares none. If
 * the SVG cannot be read as XML or `DOMParser` is missing, the regex applies.
 */
export function svgHasText(svg: string): boolean {
  if (typeof DOMParser !== 'function') return SVG_TEXT.test(svg);
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return SVG_TEXT.test(svg);
  return doc.getElementsByTagNameNS(SVG_NS, 'text').length > 0 || doc.getElementsByTagNameNS(null, 'text').length > 0;
}

/**
 * Pixel size of an image via an `Image` from the data URL: `naturalWidth` and
 * `naturalHeight` are set after `onload` from the file header, without fully
 * decoding the image (`createImageBitmap` took about 1.6 GB for 20,000 × 20,000
 * pixels). `createImageBitmap` only if there is no `Image`.
 */
export async function imageSize(file: Blob, url: string): Promise<{ width: number; height: number }> {
  if (typeof Image !== 'function') {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error('unreadable'));
    img.src = url;
  });
}

/** Default as a draft (`BRAND0`; "Reset", `brNotDefault`). */
export function defaultDraft(): BrandingDraft {
  return { ...BRAND0, name: m.app_name(), imageName: '', imageMeta: '' };
}

/** Do two states differ? The name counts trimmed. */
export function differs(a: BrandingDraft, b: BrandingDraft): boolean {
  return DRAFT_KEYS.some((k) => (k === 'name' ? a.name.trim() !== b.name.trim() : a[k] !== b[k]));
}

/** Saved shape: texts trimmed, an empty heading becomes the default one. */
export function normalized(d: BrandingDraft): BrandingDraft {
  return {
    ...d,
    name: d.name.trim(),
    letter: d.letter.trim(),
    loginTitle: d.loginTitle.trim() || BRAND0.loginTitle,
    loginText: d.loginText.trim(),
  };
}

/** Fields of `public/config` › `branding` from a draft or a response. */
export function brandingOf(b: Branding): Branding {
  return Object.fromEntries(BRANDING_KEYS.map((k) => [k, b[k]])) as unknown as Branding;
}

/**
 * Request for `PUT admin/branding`: only changed fields; the own app name
 * becomes `null`. A new logo goes as a data URL with name and details, a
 * removed one as `null`; an unchanged one is missing (stays).
 */
export function bodyOf(next: BrandingDraft, prev: BrandingDraft): Partial<AdminBranding> {
  const body: Partial<Record<keyof AdminBranding, unknown>> = {};
  for (const k of BRANDING_KEYS) if (k !== 'image' && next[k] !== prev[k]) body[k] = next[k];
  if (next.name !== prev.name) body.name = next.name === m.app_name() ? null : next.name;
  if (next.image !== prev.image) {
    body.image = next.image;
    if (next.image) {
      body.imageName = next.imageName;
      body.imageMeta = next.imageMeta;
    }
  }
  return body as Partial<AdminBranding>;
}

/** Name and details of the saved file, only from `admin/branding`; they apply to the logo under `image`. */
interface FileInfo {
  image: string | null;
  name: string;
  meta: string;
}

let file = $state<FileInfo>({ image: null, name: '', meta: '' });
/** Is a save running (toast or request)? Then an older response of `admin/branding` does not apply. */
let pending = 0;

/** Sign-out: forget the name and details of the logo file (only for administrators). */
export function forgetBranding(): void {
  file = { image: null, name: '', meta: '' };
}
// `forgetAccount()` does not know the module, it only loads with its pages.
onForget(forgetBranding);

/** Saved state as a draft: `session` and the file details if they match the logo. */
function savedDraft(): BrandingDraft {
  const b = session.branding;
  const known = file.image !== null && file.image === b.image;
  return {
    ...brandingOf(b),
    name: session.appName,
    imageName: known ? file.name : '',
    imageMeta: known ? file.meta : '',
  };
}

/** Take over the response of `admin/branding`. */
function accept(b: AdminBranding): void {
  session.setBranding(b.name ?? m.app_name(), brandingOf(b));
  file = { image: b.image, name: b.imageName, meta: b.imageMeta };
}

export interface BrandingContext {
  scrollTo: (section: BrandingSection) => void;
}

export class BrandingPage {
  /** Saved state (until the response of `admin/branding` the one from `public/config`). */
  saved = $derived(savedDraft());
  /** Inputs on top of the saved state; fields not named show it. */
  edits = $state.raw<Partial<BrandingDraft>>({});
  draft = $derived<BrandingDraft>({ ...this.saved, ...this.edits });
  dirty = $derived(differs(this.draft, this.saved));
  notDefault = $derived(differs(this.draft, defaultDraft()));
  /** Logo error (`brandErr`). */
  error = $state<string | null>(null);
  /** File over the drop zone (`brandDrag`). */
  drag = $state(false);

  #ctx: BrandingContext;
  #seq = 0;
  #read = 0;
  #disposed = false;

  constructor(ctx: BrandingContext) {
    this.#ctx = ctx;
  }

  /** Loads `admin/branding`; without a response the state from `public/config` stays (without file details). */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    const before = session.config?.branding;
    try {
      const b = await api<AdminBranding>('GET', 'admin/branding');
      // Saved or reverted meanwhile: the state of the session is newer.
      if (seq !== this.#seq || this.#disposed || pending > 0 || session.config?.branding !== before) return;
      accept(b);
    } catch (error) {
      if (seq !== this.#seq || this.#disposed) return;
      // Without a session or role: reload the account, the layout then shows sign-in or "Access denied".
      // Otherwise the state from `public/config` stays; the page has no error state.
      if (isApiError(error, 401) || isApiError(error, 403)) void session.refreshUser().catch(() => {});
    }
  }

  /** Input into a field (`bSet`). */
  set<K extends keyof BrandingDraft>(key: K, value: BrandingDraft[K]): void {
    this.edits = { ...this.edits, [key]: value };
  }

  /** Kind of logo (`brKindOpts`); clears the logo error. */
  setKind(kind: KindName): void {
    this.#read++;
    this.set('kind', kind);
    this.error = null;
  }

  /** Initials (`onBrLetter`): at most two characters, without splitting surrogate pairs (emoji). */
  setLetter(value: string): void {
    this.set('letter', Array.from(value).slice(0, BRANDING_MAX.letter).join(''));
  }

  /**
   * Choose or drop a file: checks format and size, then
   * text in the SVG or the pixel size, reads it as a data URL and switches to "Image".
   */
  async readFile(f: File | null | undefined): Promise<void> {
    if (!f) return;
    const seq = ++this.#read;
    const bad = checkFile(f);
    if (bad) {
      this.error = imageErrorText(bad);
      return;
    }
    const svg = f.type === 'image/svg+xml';
    let url = '';
    let content: ImageError | null = null;
    try {
      // An SVG without text, an image at most 4096 × 4096 pixels.
      if (svg && svgHasText(await f.text())) content = 'svg_text';
      else url = await readAsDataUrl(f);
      if (!svg) {
        const size = await imageSize(f, url);
        if (size.width > MAX_PIXELS || size.height > MAX_PIXELS) content = 'dimensions';
      }
    } catch {
      if (seq === this.#read && !this.#disposed) this.error = imageErrorText('unreadable');
      return;
    }
    // A later file, Discard, Remove, Reset or another kind win.
    if (seq !== this.#read || this.#disposed) return;
    if (content) {
      this.error = imageErrorText(content);
      return;
    }
    this.edits = { ...this.edits, kind: 'image', image: url, imageName: f.name, imageMeta: fileMeta(f) };
    this.error = null;
  }

  /** "Remove" (`brImgRemove`). */
  removeImage(): void {
    this.#read++;
    this.edits = { ...this.edits, image: null, imageName: '', imageMeta: '' };
    this.error = null;
  }

  /** "Discard" (`brDiscard`). */
  discard(): void {
    this.#read++;
    this.edits = {};
    this.error = null;
  }

  /** "Reset" (`brReset`): default as a draft, saved only with "Save". */
  reset(): void {
    this.#read++;
    this.edits = defaultDraft();
    this.error = null;
  }

  /** "Save" (`brSave`) with toast and undo. */
  save(): void {
    const draft = this.draft;
    if (!draft.name.trim()) {
      ui.toasts.show(m.branding_name_required());
      this.#ctx.scrollTo('name');
      return;
    }
    if (draft.kind === 'image' && !draft.image) {
      ui.toasts.show(m.branding_image_required());
      this.#ctx.scrollTo('logo');
      return;
    }
    if (!this.dirty) return;
    const prev = this.saved;
    const prevFile = file;
    const next = normalized(draft);
    const body = bodyOf(next, prev);
    const changed = Object.keys(body).length > 0;
    session.setBranding(next.name, brandingOf(next));
    file = { image: next.image, name: next.imageName, meta: next.imageMeta };
    const shown = session.config?.branding;
    this.edits = {};
    this.error = null;
    if (changed) pending++;
    let open = changed;
    const done = (): void => {
      if (open) pending--;
      open = false;
    };
    ui.toasts.defer({
      text: m.branding_saved(),
      revert: () => {
        done();
        // A later save stays.
        if (session.config?.branding !== shown) return;
        session.setBranding(prev.name, brandingOf(prev));
        file = prevFile;
      },
      // Only whitespace changed: nothing to send.
      ...(changed && {
        commit: async (keepalive: boolean) => {
          // A new logo is larger than the `keepalive` limit; `api()` then sends it without.
          const saved = await api<AdminBranding>('PUT', 'admin/branding', body, { keepalive });
          done();
          if (session.config?.branding === shown) accept(saved);
        },
      }),
      onError: (error) => {
        // Show the unsaved fields again as inputs with the bar; later inputs win.
        // The file name and details belong to the logo.
        const back: Partial<Record<keyof BrandingDraft, unknown>> = {};
        for (const k of DRAFT_KEYS) if (k in body) back[k] = draft[k];
        if ('image' in body) {
          back.imageName = draft.imageName;
          back.imageMeta = draft.imageMeta;
        }
        this.edits = { ...(back as Partial<BrandingDraft>), ...this.edits };
        if (isApiError(error, 401) || isApiError(error, 403)) {
          void session.refreshUser().catch(() => {});
          return;
        }
        const code = imageErrorOf(error);
        // Page already left: the logo error would not arrive there any more, so as a toast.
        if (code && !this.#disposed) {
          this.error = imageErrorText(code);
          this.#ctx.scrollTo('logo');
          return;
        }
        if (code) {
          ui.toasts.error(imageErrorText(code));
          return;
        }
        // Other 422s (lengths, values): the inputs limit them already, so there are no texts per field.
        ui.toasts.error(failText(error, m.error_act()));
      },
      // "Undo": the inputs also go back to the previous state.
      onUndo: () => {
        this.edits = {};
        this.error = null;
      },
    });
  }

  dispose(): void {
    this.#disposed = true;
  }
}

function readAsDataUrl(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('empty')));
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsDataURL(f);
  });
}

/** Preview (`brPrev`): logo on a plate or brand colour, name, tilt. */
export interface BrandingPreview {
  logo: LogoValues;
  name: string;
  bg: string;
  ink: string;
  /** `rotate(-4deg)` or `none`. */
  tilt: string;
}

export interface BrandingIcon {
  icon: IconName;
  label: string;
  pressed: boolean;
  onClick: () => void;
}

export interface BrandingColor {
  name: AccentName;
  label: string;
  base: string;
  ink: string;
  on: boolean;
  onClick: () => void;
}

/** Values of the branding page. */
export interface BrandingValues {
  brTabs: { label: string; onClick: () => void }[];
  brPrev: BrandingPreview;
  brName: string;
  onBrName: (value: string) => void;
  brKindOpts: SegOption<KindName>[];
  brKindExtra: boolean;
  brIsInit: boolean;
  brIsIcon: boolean;
  brIsImg: boolean;
  brLetter: string;
  brLetterPh: string;
  onBrLetter: (value: string) => void;
  brIcons: BrandingIcon[];
  /** File from the picker or dropped (`onBrFile`, `brDrop`). */
  onBrFile: (file: File | null | undefined) => void;
  /** File over the drop zone (`brDropBg`, `brDropBd`). */
  brDrag: boolean;
  onBrDrag: (on: boolean) => void;
  brHasImg: boolean;
  brNoImg: boolean;
  brImgName: string;
  brImgMeta: string;
  brImgRemove: () => void;
  brErr: string;
  brHasErr: boolean;
  brFitOpts: SegOption<FitName>[];
  brPlateOpts: SegOption<PlateName>[];
  tgBrTilt: Toggle;
  brColors: BrandingColor[];
  tgBrUserAcc: Toggle;
  brLoginTitle: string;
  onBrLoginTitle: (value: string) => void;
  brLoginText: string;
  onBrLoginText: (value: string) => void;
  tgBrLoginArt: Toggle;
  brDirty: boolean;
  brNotDefault: boolean;
  brSave: () => void;
  brDiscard: () => void;
  brReset: () => void;
}

export function brandingValues(p: BrandingPage, ctx: BrandingContext): BrandingValues {
  const d = p.draft;
  const appName = m.app_name();
  const prevName = d.name.trim() || appName;
  const plate = PLATES[d.plate] ?? null;
  const accent = ACCENTS[d.color] ?? ACCENTS[DEFAULT_ACCENT];
  const seg = <T extends string>(
    values: readonly T[],
    current: string,
    labels: Record<T, () => string>,
    pick: (v: T) => void,
  ) => values.map((value) => ({ value, label: labels[value](), on: current === value, onClick: () => pick(value) }));
  return {
    brTabs: BR_TABS.map(([section, label]) => ({ label: label(), onClick: () => ctx.scrollTo(section) })),
    brPrev: {
      logo: mkLogo(d, prevName),
      name: prevName,
      bg: plate ? plate[0] : accent.base,
      ink: plate ? plate[1] : accent.ink,
      tilt: d.tilt ? 'rotate(-4deg)' : 'none',
    },
    brName: d.name,
    onBrName: (value) => p.set('name', value),
    brKindOpts: seg(KINDS, d.kind, KIND_LABELS, (v) => p.setKind(v)),
    brKindExtra: d.kind !== 'standard',
    brIsInit: d.kind === 'initial',
    brIsIcon: d.kind === 'icon',
    brIsImg: d.kind === 'image',
    brLetter: d.letter,
    brLetterPh: (prevName[0] ?? 'A').toUpperCase(),
    onBrLetter: (value) => p.setLetter(value),
    brIcons: BRAND_ICONS.map(([icon, label]) => ({
      icon,
      label: label(),
      pressed: d.icon === icon,
      onClick: () => p.set('icon', icon),
    })),
    onBrFile: (f) => void p.readFile(f),
    brDrag: p.drag,
    onBrDrag: (on) => {
      p.drag = on;
    },
    brHasImg: !!d.image,
    brNoImg: !d.image,
    brImgName: d.imageName || m.branding_file_name(),
    brImgMeta: d.imageMeta,
    brImgRemove: () => p.removeImage(),
    brErr: p.error ?? '',
    brHasErr: p.error !== null,
    brFitOpts: seg(FITS, d.fit, FIT_LABELS, (v) => p.set('fit', v)),
    brPlateOpts: seg(Object.keys(PLATES) as PlateName[], d.plate, PLATE_LABELS, (v) => p.set('plate', v)),
    tgBrTilt: { on: d.tilt, onClick: () => p.set('tilt', !p.draft.tilt) },
    brColors: (Object.keys(ACCENTS) as AccentName[]).map((name) => ({
      name,
      label: accentLabel(name),
      base: ACCENTS[name].base,
      ink: ACCENTS[name].ink,
      on: d.color === name,
      onClick: () => p.set('color', name),
    })),
    tgBrUserAcc: { on: d.userAccent, onClick: () => p.set('userAccent', !p.draft.userAccent) },
    brLoginTitle: d.loginTitle,
    onBrLoginTitle: (value) => p.set('loginTitle', value),
    brLoginText: d.loginText,
    onBrLoginText: (value) => p.set('loginText', value),
    tgBrLoginArt: { on: d.loginArt, onClick: () => p.set('loginArt', !p.draft.loginArt) },
    brDirty: p.dirty,
    brNotDefault: p.notDefault,
    brSave: () => p.save(),
    brDiscard: () => p.discard(),
    brReset: () => p.reset(),
  };
}
