/**
 * Administration › Banner against `GET/PUT admin/banner`: switch with status,
 * content (title, text, link with label), appearance (tone, icon, dismissible),
 * preview and the bar "Unsaved changes".
 *
 * One source counts as saved: `banner` in `session.config` (from
 * `public/config`) while it is on – the notice bar reads the same. When
 * switched off `public/config` does not name it; `stored` from `admin/banner`
 * then holds the content. The page only holds the inputs on top and reloads
 * `admin/banner` when opened. As with the organisation, a change applies at once
 * in the display: saving and switching off only send after the toast
 * (`ui.toasts.defer`), switching on right after the confirmation. The app counts
 * the revision ahead like the backend (every change +1), so that a banner closed
 * by a user appears again after saving; the response replaces it.
 */
import { api, fieldsOf, isApiError } from '#lib/api.ts';
import { failText } from '#lib/errors.ts';
import { urlOk } from '#lib/links.ts';
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import { ANN_TONES, bannerIconOf, toneOf, type ToneName } from '#lib/shell.ts';
import { onForget } from '#lib/state/forget.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session, type BannerContent, type PublicBanner } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

export type BannerKey = keyof BannerContent;
export type BannerSection = 'status' | 'content' | 'look';

/** Response of `admin/banner`: content with display (`on`) and revision. */
export interface AdminBanner extends BannerContent {
  on: boolean;
  revision: number;
}

/** Empty banner content. */
export const ANN0: Readonly<BannerContent> = Object.freeze({
  title: '',
  text: '',
  link: '',
  linkLabel: '',
  tone: 'accent',
  icon: 'ti-speakerphone',
  closable: true,
});

export const BANNER_KEYS = [
  'title',
  'text',
  'link',
  'linkLabel',
  'tone',
  'icon',
  'closable',
] as const satisfies readonly BannerKey[];

/** Without a row: `ANN0`, switched off, revision 0. */
const OFF0: Readonly<AdminBanner> = Object.freeze({ ...ANN0, on: false, revision: 0 });

/** Icons to choose from for the banner. */
export const ANN_ICONS: readonly [IconName, () => string][] = [
  ['ti-speakerphone', m.banner_icon_speakerphone],
  ['ti-info-circle', m.banner_icon_info],
  ['ti-alert-triangle', m.banner_icon_warning],
  ['ti-calendar-event', m.banner_icon_event],
  ['ti-sparkles', m.banner_icon_new],
  ['ti-tool', m.banner_icon_tool],
  ['ti-gift', m.banner_icon_gift],
  ['ti-heart', m.banner_icon_heart],
];

/** Names of the tones (`ANN_TONES`); the key is also the stored value. */
const TONE_LABELS: Record<ToneName, () => string> = {
  accent: m.banner_tone_accent,
  soft: m.banner_tone_soft,
  dark: m.banner_tone_dark,
  warning: m.banner_tone_warning,
};

/** Section tabs (`annTabs`). */
const ANN_TABS: readonly [BannerSection, () => string][] = [
  ['status', m.banner_tab_status],
  ['content', m.banner_tab_content],
  ['look', m.banner_tab_look],
];

/** `aNorm`: texts trimmed. */
export function normalized(d: BannerContent): BannerContent {
  return {
    ...d,
    title: d.title.trim(),
    text: d.text.trim(),
    link: d.link.trim(),
    linkLabel: d.linkLabel.trim(),
  };
}

/** Equal values; texts are compared trimmed. */
function same(a: string | boolean, b: string | boolean): boolean {
  return typeof a === 'string' && typeof b === 'string' ? a.trim() === b.trim() : a === b;
}

function contentOf(b: BannerContent): BannerContent {
  return Object.fromEntries(BANNER_KEYS.map((k) => [k, b[k]])) as unknown as BannerContent;
}

/** `banner` in `public/config`: the content with revision while it is on. */
export function publicOf(b: AdminBanner): PublicBanner | null {
  return b.on ? { ...contentOf(b), revision: b.revision } : null;
}

/** Content of the switched-off banner from `admin/banner`; when shown, `session.config.banner` applies. */
class Stored {
  off = $state.raw<AdminBanner | null>(null);
}
const stored = new Stored();

/** Is a save running (toast or request)? Then an older response of `admin/banner` does not apply. */
let pending = 0;
/** Counts own changes; a later one wins (undo and the response of an earlier one then change nothing). */
let generation = 0;

/**
 * Is the saved content known – shown from `public/config` or switched
 * off from `admin/banner`? Otherwise `OFF0` is only an assumption.
 */
function known(): boolean {
  return !!session.config?.banner || stored.off !== null;
}

/** Sign-out: forget the content of the switched-off banner; later responses no longer apply. */
export function forgetBanner(): void {
  stored.off = null;
  generation++;
}
// `forgetAccount()` does not know the module, it only loads with its pages.
onForget(forgetBanner);

/** Take over a state: notice bar and page follow. */
function accept(b: AdminBanner): number {
  stored.off = b.on ? null : b;
  session.setBanner(publicOf(b));
  return ++generation;
}

function savedBanner(): AdminBanner {
  const shown = session.config?.banner;
  return shown ? { ...contentOf(shown), on: true, revision: shown.revision } : (stored.off ?? OFF0);
}

/** Error when sending: without a session or role reload the account, otherwise the general error notice. */
function failed(error: unknown): void {
  if (isApiError(error, 401) || isApiError(error, 403)) {
    void session.refreshUser().catch(() => {});
    return;
  }
  const fields = isApiError(error, 422) ? fieldsOf(error) : {};
  const text = fields.title
    ? m.banner_title_missing()
    : fields.link
      ? m.banner_link_bad()
      : failText(error, m.error_act());
  ui.toasts.error(text);
}

export interface BannerContext {
  scrollTo: (section: BannerSection) => void;
}

export class BannerPage {
  /** Saved state (until the response of `admin/banner` the one from `public/config`). */
  saved = $derived(savedBanner());
  /** Inputs on top of the saved state; fields not named show it. */
  edits = $state.raw<Partial<BannerContent>>({});
  draft = $derived<BannerContent>({ ...contentOf(this.saved), ...this.edits });
  dirty = $derived(BANNER_KEYS.some((k) => !same(this.draft[k], this.saved[k])));
  /** Active, but closed for me (`annHiddenMe`). */
  hidden = $derived(this.saved.on && prefs.values.bannerDismissedRev === this.saved.revision);
  linkBad = $derived(!!this.draft.link.trim() && !urlOk(this.draft.link));

  #ctx: BannerContext;
  #seq = 0;
  #disposed = false;

  constructor(ctx: BannerContext) {
    this.#ctx = ctx;
  }

  /** Loads `admin/banner`; without a response the state from `public/config` stays. */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    const before = generation;
    try {
      const banner = await api<AdminBanner>('GET', 'admin/banner');
      // Saved or reverted meanwhile: the own state is newer.
      if (seq !== this.#seq || this.#disposed || pending > 0 || generation !== before) return;
      accept(banner);
    } catch (error) {
      if (seq !== this.#seq || this.#disposed) return;
      // Without a session or role: reload the account, the layout then shows sign-in or "Access denied".
      // Otherwise the state from `public/config` stays – the page has no error state.
      if (isApiError(error, 401) || isApiError(error, 403)) void session.refreshUser().catch(() => {});
    }
  }

  /** Input (`onAnnTitle`, `annTones[].onClick` etc.). */
  set<K extends BannerKey>(key: K, value: BannerContent[K]): void {
    this.edits = { ...this.edits, [key]: value };
  }

  /** "Discard" (`annDiscard`). */
  discard(): void {
    this.edits = {};
  }

  /** "Show again" (`annUnhide`): show a banner closed for me again. */
  unhide(): void {
    prefs.set({ bannerDismissedRev: null });
  }

  /** `aCheck`: title and link before saving and switching on. */
  #check(d: BannerContent): boolean {
    if (!d.title.trim()) {
      ui.toasts.show(m.banner_title_missing());
      this.#ctx.scrollTo('content');
      return false;
    }
    if (d.link.trim() && !urlOk(d.link)) {
      ui.toasts.show(m.banner_link_bad());
      this.#ctx.scrollTo('content');
      return false;
    }
    return true;
  }

  /**
   * Changed fields of the draft compared to `prev`, trimmed. If the saved
   * content is not known (`admin/banner` still without a response or
   * failed), all fields: otherwise what is on the server but not shown on the
   * page would go along.
   */
  #changes(prev: AdminBanner): { next: BannerContent; body: Partial<BannerContent> } {
    const next = normalized(this.draft);
    const all = !known();
    const body: Partial<BannerContent> = {};
    for (const k of BANNER_KEYS) if (all || !same(next[k], prev[k])) Object.assign(body, { [k]: next[k] });
    return { next, body };
  }

  /** Unsaved fields back as inputs; later inputs win. */
  #restore(draft: BannerContent, body: Partial<BannerContent>): void {
    const back: Partial<BannerContent> = {};
    for (const k of BANNER_KEYS) if (k in body) Object.assign(back, { [k]: draft[k] });
    this.edits = { ...back, ...this.edits };
  }

  /** Switch `tgAnn`: off at once with undo, on after a check and confirmation. */
  toggle(): void {
    if (this.saved.on) {
      this.#disable();
      return;
    }
    if (!this.#check(this.draft)) return;
    ui.ask({
      title: m.banner_on_title(),
      text: this.dirty ? m.banner_on_text_save() : m.banner_on_text(),
      icon: 'ti-speakerphone',
      ok: m.banner_on_ok(),
      run: () => void this.#enable(),
    });
  }

  #disable(): void {
    const prev = this.saved;
    const mine = accept({ ...prev, on: false, revision: prev.revision + 1 });
    pending++;
    let open = true;
    const done = (): void => {
      if (open) pending--;
      open = false;
    };
    ui.toasts.defer({
      text: m.banner_off_toast(),
      revert: () => {
        done();
        if (generation === mine) accept(prev);
      },
      commit: async (keepalive: boolean) => {
        const banner = await api<AdminBanner>('PUT', 'admin/banner', { on: false }, { keepalive });
        done();
        if (generation === mine) accept(banner);
      },
      onError: failed,
    });
  }

  /** Switching on with the draft (`tgAnn` › `run`): at once, errors revert it. */
  async #enable(): Promise<void> {
    // A pending save or switch-off goes out first; if it came afterwards, it would overtake the switch-on.
    await ui.toasts.flush();
    const prev = this.saved;
    const draft = this.draft;
    const { next, body } = this.#changes(prev);
    const mine = accept({ ...next, on: true, revision: prev.revision + 1 });
    this.edits = {};
    pending++;
    try {
      const banner = await api<AdminBanner>('PUT', 'admin/banner', { ...body, on: true });
      if (generation !== mine) return;
      accept(banner);
      ui.toasts.show(m.banner_on_toast());
    } catch (error) {
      if (generation === mine) {
        accept(prev);
        this.#restore(draft, body);
      }
      failed(error);
    } finally {
      pending--;
    }
  }

  /** "Save" (`annSave`) with toast and undo; switched off it stays off. */
  save(): void {
    if (!this.dirty) return;
    const draft = this.draft;
    if (!this.#check(draft)) return;
    const prev = this.saved;
    const { next, body } = this.#changes(prev);
    const mine = accept({ ...prev, ...next, revision: prev.revision + 1 });
    this.edits = {};
    pending++;
    let open = true;
    const done = (): void => {
      if (open) pending--;
      open = false;
    };
    ui.toasts.defer({
      text: m.banner_saved(),
      revert: () => {
        done();
        // A later save stays.
        if (generation === mine) accept(prev);
      },
      commit: async (keepalive: boolean) => {
        const banner = await api<AdminBanner>('PUT', 'admin/banner', body, { keepalive });
        done();
        if (generation === mine) accept(banner);
      },
      onError: (error) => {
        this.#restore(draft, body);
        failed(error);
      },
      // "Undo": the inputs also go back to the previous state.
      onUndo: () => {
        this.edits = {};
      },
    });
  }

  dispose(): void {
    this.#disposed = true;
  }
}

export interface Toggle {
  on: boolean;
  onClick: () => void;
}

/** Preview (`annPrev`): colours of the tone, placeholder "Title" faded, "Learn more" without a label. */
export interface BannerPreview {
  bg: string;
  ink: string;
  sub: string;
  actBg: string;
  actHov: string;
  icon: IconName;
  title: string;
  /** Opacity of the title (`op`): 0.55 without a title. */
  op: number;
  text: string;
  hasAct: boolean;
  act: string;
  hasClose: boolean;
}

export interface BannerToneChoice {
  name: ToneName;
  label: string;
  bg: string;
  ink: string;
  pressed: boolean;
  onClick: () => void;
}

export interface BannerIcon {
  icon: IconName;
  label: string;
  pressed: boolean;
  onClick: () => void;
}

/** Values of the banner page. */
export interface BannerValues {
  annTabs: { label: string; onClick: () => void }[];
  annPrev: BannerPreview;
  tgAnn: Toggle;
  annStatus: string;
  annHiddenMe: boolean;
  annUnhide: () => void;
  tgAnnClose: Toggle;
  annTitle: string;
  onAnnTitle: (value: string) => void;
  annText: string;
  onAnnText: (value: string) => void;
  annLink: string;
  onAnnLink: (value: string) => void;
  annHasLink: boolean;
  annLinkBad: boolean;
  annLinkLabel: string;
  onAnnLinkLabel: (value: string) => void;
  annTones: BannerToneChoice[];
  annIcons: BannerIcon[];
  annDirty: boolean;
  annDirtyText: string;
  annSave: () => void;
  annDiscard: () => void;
}

export function bannerValues(p: BannerPage, ctx: BannerContext): BannerValues {
  const d = p.draft;
  const on = p.saved.on;
  const title = d.title.trim();
  return {
    annTabs: ANN_TABS.map(([section, label]) => ({ label: label(), onClick: () => ctx.scrollTo(section) })),
    annPrev: {
      ...toneOf(d.tone),
      icon: bannerIconOf(d.icon),
      title: title || m.banner_prev_title(),
      op: title ? 1 : 0.55,
      text: d.text.trim(),
      hasAct: !!d.link.trim(),
      act: d.linkLabel.trim() || m.banner_more(),
      hasClose: d.closable,
    },
    tgAnn: { on, onClick: () => p.toggle() },
    annStatus: !on ? m.banner_status_off() : p.hidden ? m.banner_status_hidden() : m.banner_status_on(),
    annHiddenMe: p.hidden,
    annUnhide: () => p.unhide(),
    tgAnnClose: { on: d.closable, onClick: () => p.set('closable', !p.draft.closable) },
    annTitle: d.title,
    onAnnTitle: (value) => p.set('title', value),
    annText: d.text,
    onAnnText: (value) => p.set('text', value),
    annLink: d.link,
    onAnnLink: (value) => p.set('link', value),
    annHasLink: !!d.link.trim(),
    annLinkBad: p.linkBad,
    annLinkLabel: d.linkLabel,
    onAnnLinkLabel: (value) => p.set('linkLabel', value),
    annTones: (Object.keys(ANN_TONES) as ToneName[]).map((name) => ({
      name,
      label: TONE_LABELS[name](),
      bg: ANN_TONES[name].bg,
      ink: ANN_TONES[name].ink,
      pressed: d.tone === name,
      onClick: () => p.set('tone', name),
    })),
    annIcons: ANN_ICONS.map(([icon, label]) => ({
      icon,
      label: label(),
      pressed: d.icon === icon,
      onClick: () => p.set('icon', icon),
    })),
    annDirty: p.dirty,
    annDirtyText: on ? m.banner_unsaved_on() : m.dirty_unsaved(),
    annSave: () => p.save(),
    annDiscard: () => p.discard(),
  };
}
