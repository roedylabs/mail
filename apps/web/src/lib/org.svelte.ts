/**
 * Administration › Organization against `GET/PUT admin/org`: company, support,
 * legal and source code, with the "Unsaved changes" bar with save and discard.
 *
 * The saved state has one source: `org` in `session.config` (from
 * `public/config`, the same fields). The page only keeps the inputs on
 * top and loads `admin/org` on opening. Saving applies the draft right
 * away – About and the sign-in footers follow – and only sends it after
 * the "Changes saved" toast expires (`ui.toasts.defer`), only the changed
 * fields. "Undo" resets state and inputs. If sending fails, the draft is
 * back with the bar.
 *
 * Field errors: the page checks live per the backend's rules (`orgError`) and
 * shows the text at the field. Saving with an error shows the toast "Please
 * check the highlighted fields", jumps to the section of the first field and
 * sends nothing. A 422 from the server (`fields.<field>` with
 * `invalid`/`too_long`) shows the same texts at the field instead of the error
 * toast until the field is changed; the page does not add `https://`.
 */
import { api, fieldsOf, isApiError } from '#lib/api.ts';
import { failText } from '#lib/errors.ts';
import { m } from '#lib/paraglide/messages.js';
import { session, type Org } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

export type OrgKey = keyof Org;
export type OrgSection = 'firm' | 'support' | 'legal' | 'source';
/** Inputs per field; `''` means "not given". */
export type OrgDraft = Record<OrgKey, string>;

export const ORG_KEYS = [
  'name',
  'website',
  'help',
  'email',
  'imprint',
  'privacy',
  'terms',
  'source',
] as const satisfies readonly OrgKey[];

const NO_ORG: Org = {
  name: null,
  website: null,
  help: null,
  email: null,
  imprint: null,
  privacy: null,
  terms: null,
  source: null,
};

/** Reasons of a field error like `fields.<field>.code` of `PUT admin/org`. */
export type OrgError = 'invalid' | 'too_long';
export type OrgErrors = Partial<Record<OrgKey, OrgError>>;

/** Maximum lengths in characters like the backend (`MAX_NAME`, `MAX_EMAIL`, `MAX_LINK`). */
export const ORG_MAX = { name: 120, email: 254, link: 2048 } as const;

/** Control characters like Rust `char::is_control` (category Cc). */
const CONTROL = /\p{Cc}/u;
/** Whitespace like Rust `char::is_whitespace`. */
const SPACE = /\p{White_Space}/u;

function hasHost(value: string): boolean {
  try {
    return new URL(value).hostname !== '';
  } catch {
    return false;
  }
}

/**
 * Error of a field, like `org_error` in the backend: the value
 * is trimmed, empty is never an error; characters count like Rust `chars()`.
 * Name: over 120 characters `too_long`, control characters `invalid`. Email: over 254
 * `too_long`, `invalid` without `local@domain` at the first `@` or with whitespace,
 * `?` or control characters. Links: over 2048 `too_long`, `invalid` without `http://`
 * or `https://`, with whitespace or control characters or without a host.
 */
export function orgError(key: OrgKey, value: string): OrgError | null {
  const t = value.trim();
  if (!t) return null;
  const n = Array.from(t).length;
  const ctl = CONTROL.test(t);
  if (key === 'name') return n > ORG_MAX.name ? 'too_long' : ctl ? 'invalid' : null;
  if (key === 'email') {
    if (n > ORG_MAX.email) return 'too_long';
    const at = t.indexOf('@');
    return at < 1 || at === t.length - 1 || SPACE.test(t) || t.includes('?') || ctl ? 'invalid' : null;
  }
  if (n > ORG_MAX.link) return 'too_long';
  return /^https?:\/\//i.test(t) && !SPACE.test(t) && !ctl && hasHost(t) ? null : 'invalid';
}

/** Text of a field error. */
export function orgErrorText(key: OrgKey, code: OrgError): string {
  if (key === 'name') return code === 'too_long' ? m.org_err_name_long() : m.org_err_name_invalid();
  if (key === 'email') return code === 'too_long' ? m.org_err_email_long() : m.org_err_email();
  return code === 'too_long' ? m.org_err_link_long() : m.org_err_link();
}

/** Field errors from a 422 of `PUT admin/org`; unknown fields and reasons do not count. */
export function orgErrorsOf(error: unknown): OrgErrors {
  if (!isApiError(error, 422)) return {};
  const out: OrgErrors = {};
  for (const [key, detail] of Object.entries(fieldsOf(error))) {
    if ((ORG_KEYS as readonly string[]).includes(key) && (detail.code === 'invalid' || detail.code === 'too_long'))
      out[key as OrgKey] = detail.code;
  }
  return out;
}

/** Placeholder of the links; not text, hence not in `messages`. */
const URL_PH = (): string => 'https://';

interface FieldDef {
  k: OrgKey;
  label: () => string;
  desc: () => string;
  type: 'text' | 'url' | 'email';
  ph: () => string;
}

/** Fields per section. */
export const ORG_FIELDS: Record<OrgSection, readonly FieldDef[]> = {
  firm: [
    { k: 'name', label: m.org_name, desc: m.org_name_desc, type: 'text', ph: m.org_name_ph },
    { k: 'website', label: m.org_website, desc: m.org_website_desc, type: 'url', ph: URL_PH },
  ],
  support: [
    { k: 'help', label: m.org_help, desc: m.org_help_desc, type: 'url', ph: URL_PH },
    { k: 'email', label: m.org_email, desc: m.org_email_desc, type: 'email', ph: m.org_email_ph },
  ],
  legal: [
    { k: 'imprint', label: m.org_imprint, desc: m.org_imprint_desc, type: 'url', ph: URL_PH },
    { k: 'privacy', label: m.org_privacy, desc: m.org_privacy_desc, type: 'url', ph: URL_PH },
    { k: 'terms', label: m.org_terms, desc: m.org_terms_desc, type: 'url', ph: URL_PH },
  ],
  source: [{ k: 'source', label: m.org_source, desc: m.org_source_desc_field, type: 'url', ph: URL_PH }],
};

/** Section tabs. */
const ORG_TABS: readonly [OrgSection, () => string][] = [
  ['firm', m.org_tab_firm],
  ['support', m.org_tab_support],
  ['legal', m.org_tab_legal],
  ['source', m.org_tab_source],
];

/** Inputs from a saved organization (`null` → `''`). */
export function draftOf(org: Org): OrgDraft {
  return Object.fromEntries(ORG_KEYS.map((k) => [k, org[k] ?? ''])) as OrgDraft;
}

/** Saved form: trimmed, empty means `null` (like the backend). */
export function orgOf(draft: OrgDraft): Org {
  const org = { ...NO_ORG };
  for (const k of ORG_KEYS) org[k] = draft[k].trim() || null;
  return org;
}

/** Section of the first field with an error in page order. */
export function firstBadSection(errors: OrgErrors): OrgSection | null {
  for (const [section] of ORG_TABS) if (ORG_FIELDS[section].some((f) => errors[f.k])) return section;
  return null;
}

/** Is a save running (toast or request)? Then an older response of `admin/org` does not apply. */
let pending = 0;

export class OrgPage {
  /** Saved state: `org` of `session.config` (until the response of `admin/org` the one from `public/config`). */
  saved = $derived(session.config?.org ?? NO_ORG);
  /** Inputs on top of the saved state; fields not named show it. */
  edits = $state.raw<Partial<OrgDraft>>({});
  draft = $derived({ ...draftOf(this.saved), ...this.edits });
  dirty = $derived(ORG_KEYS.some((k) => this.draft[k] !== (this.saved[k] ?? '')));
  /** Errors from a 422 of the server; a field loses its error with the next input. */
  serverErrors = $state.raw<OrgErrors>({});
  /** Error per field: the check in the browser, otherwise the server's. */
  errors = $derived.by((): OrgErrors => {
    const out: OrgErrors = {};
    for (const k of ORG_KEYS) {
      const code = orgError(k, this.draft[k]) ?? this.serverErrors[k];
      if (code) out[k] = code;
    }
    return out;
  });

  #ctx: Pick<OrgContext, 'scrollTo'>;
  #seq = 0;
  #disposed = false;

  constructor(ctx: Pick<OrgContext, 'scrollTo'>) {
    this.#ctx = ctx;
  }

  /** Loads `admin/org`; without a response the state from `public/config` stays. */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    const before = session.config?.org;
    try {
      const org = await api<Org>('GET', 'admin/org');
      // Saved or reverted in the meantime: the session state is newer.
      if (seq !== this.#seq || this.#disposed || pending > 0 || session.config?.org !== before) return;
      session.setOrg(org);
    } catch (error) {
      if (seq !== this.#seq || this.#disposed) return;
      // Without a session or role: reload the account, the layout then shows the sign-in or "Access denied".
      // Otherwise the state from `public/config` stays – the same details, the page has no error state.
      if (isApiError(error, 401) || isApiError(error, 403)) void session.refreshUser().catch(() => {});
    }
  }

  /** Input into a field. */
  set(key: OrgKey, value: string): void {
    this.edits = { ...this.edits, [key]: value };
    if (this.serverErrors[key]) {
      const rest = { ...this.serverErrors };
      delete rest[key];
      this.serverErrors = rest;
    }
  }

  /** "Discard". */
  discard(): void {
    this.edits = {};
    this.serverErrors = {};
  }

  /** "Save" with toast and undo; with a field error only toast and jump. */
  save(): void {
    if (!this.dirty) return;
    const bad = firstBadSection(this.errors);
    if (bad) {
      ui.toasts.show(m.org_check());
      this.#ctx.scrollTo(bad);
      return;
    }
    this.serverErrors = {};
    const draft = this.draft;
    const prev = this.saved;
    const next = orgOf(draft);
    const body: Partial<Org> = {};
    for (const k of ORG_KEYS) if (next[k] !== prev[k]) body[k] = next[k];
    const changed = Object.keys(body).length > 0;
    session.setOrg(next);
    const shown = session.config?.org;
    this.edits = {};
    if (changed) pending++;
    let open = changed;
    const done = (): void => {
      if (open) pending--;
      open = false;
    };
    ui.toasts.defer({
      text: m.org_saved(),
      revert: () => {
        done();
        // A later save stays.
        if (session.config?.org === shown) session.setOrg(prev);
      },
      // Only whitespace changed: nothing to send.
      ...(changed && {
        commit: async (keepalive: boolean) => {
          const org = await api<Org>('PUT', 'admin/org', body, { keepalive });
          done();
          if (session.config?.org === shown) session.setOrg(org);
        },
      }),
      onError: (error) => {
        // Show the unsaved fields again as inputs with the bar; later inputs take precedence.
        // Only these fields: the others keep following the state (also a later save that considered
        // them already saved and therefore did not send them).
        const back: Partial<OrgDraft> = {};
        for (const k of ORG_KEYS) if (k in body) back[k] = draft[k];
        this.edits = { ...back, ...this.edits };
        if (isApiError(error, 401) || isApiError(error, 403)) {
          void session.refreshUser().catch(() => {});
          return;
        }
        // 422 per field: the text at the field while it shows the sent value.
        const found = orgErrorsOf(error);
        const fields: OrgErrors = {};
        for (const k of ORG_KEYS) if (found[k] && this.draft[k] === draft[k]) fields[k] = found[k];
        const first = ORG_KEYS.find((k) => fields[k]);
        if (first && !this.#disposed) {
          this.serverErrors = { ...this.serverErrors, ...fields };
          const section = firstBadSection(fields);
          if (section) this.#ctx.scrollTo(section);
          return;
        }
        // Page already left: the text would no longer reach the field, so as a toast.
        const code = first && fields[first];
        ui.toasts.error(first && code ? orgErrorText(first, code) : failText(error, m.error_act()));
      },
      // "Undo": the inputs go back to the previous state too.
      onUndo: () => {
        this.edits = {};
      },
    });
  }

  dispose(): void {
    this.#disposed = true;
  }
}

export interface OrgField {
  k: OrgKey;
  label: string;
  desc: string;
  type: 'text' | 'url' | 'email';
  ph: string;
  value: string;
  /** Divider before the field (from the second one). */
  sep: boolean;
  /** Field not empty and invalid, or a 422 of the server: red ring, text below. */
  bad: boolean;
  /** `aria-invalid` of the field. */
  badA: 'true' | 'false';
  /** Error text below the field, empty without an error. */
  err: string;
  onChange: (value: string) => void;
}

/** Values of the page. */
export interface OrgValues {
  orgTabs: { label: string; onClick: () => void }[];
  orgFirm: OrgField[];
  orgSupport: OrgField[];
  orgLegal: OrgField[];
  orgSource: OrgField[];
  orgDirty: boolean;
  orgSave: () => void;
  orgDiscard: () => void;
  viewAbout: () => void;
}

export interface OrgContext {
  scrollTo: (section: OrgSection) => void;
  /** "View page": Settings › About. */
  viewAbout: () => void;
}

export function orgValues(p: OrgPage, ctx: OrgContext): OrgValues {
  const errorOf = (k: OrgKey): Pick<OrgField, 'bad' | 'badA' | 'err'> => {
    const code = p.errors[k];
    return { bad: !!code, badA: code ? 'true' : 'false', err: code ? orgErrorText(k, code) : '' };
  };
  const fields = (section: OrgSection): OrgField[] =>
    ORG_FIELDS[section].map((f, i) => ({
      k: f.k,
      label: f.label(),
      desc: f.desc(),
      type: f.type,
      ph: f.ph(),
      value: p.draft[f.k],
      sep: i > 0,
      ...errorOf(f.k),
      onChange: (value: string) => p.set(f.k, value),
    }));
  return {
    orgTabs: ORG_TABS.map(([section, label]) => ({ label: label(), onClick: () => ctx.scrollTo(section) })),
    orgFirm: fields('firm'),
    orgSupport: fields('support'),
    orgLegal: fields('legal'),
    orgSource: fields('source'),
    orgDirty: p.dirty,
    orgSave: () => p.save(),
    orgDiscard: () => p.discard(),
    viewAbout: ctx.viewAbout,
  };
}
