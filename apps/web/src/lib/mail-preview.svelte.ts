/**
 * Administration › Email › Templates: preview of the system mails as the
 * backend renders them (`GET admin/system-mail/preview`). Tabs of the
 * templates, up to four variants as a segment, above that as a "Variant"
 * select list (a sheet on mobile), HTML/text and light/dark (HTML only),
 * header with subject, from and to.
 *
 * Loading: until the first response a header without values and an empty
 * frame (`mvLoad.first`); every change reloads, the controls show the new
 * choice right away, the previous preview stays dimmed (`shown` with the
 * format and theme it was loaded in), both with the "Loading preview …"
 * pill; older responses expire. If loading fails, the `mvLoad.title` card
 * with "Try again" replaces header and frame, and the previous preview is
 * forgotten. `from` without a value (without a sending account or known
 * identity) shows the notice `mvFromHint`.
 */
import { api, isApiError } from '#lib/api.ts';
import type { SegOption } from '#lib/appearance.ts';
import { failText } from '#lib/errors.ts';
import type { Lang } from '#lib/locale.ts';
import { m } from '#lib/paraglide/messages.js';
import { segOptions, selectValues, type SelectContext, type SelectState, type SelectValues } from '#lib/select.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';

export type TemplateKey = 'invite' | 'reset' | 'email' | 'security' | 'digest' | 'system' | 'test';
export type PreviewFormat = 'html' | 'text';
export type PreviewTheme = 'light' | 'dark';

/** Response of `GET admin/system-mail/preview`. */
export interface MailPreviewData {
  subject: string;
  /** Sender as when sending; `null` without a sending account or known identity. */
  from: string | null;
  to: string;
  /** Whole HTML document or text. */
  body: string;
}

/** Loaded preview with the format and theme of the request. */
export interface ShownPreview extends MailPreviewData {
  format: PreviewFormat;
  theme: PreviewTheme;
}

interface Variant {
  key: string;
  label: () => string;
}

interface Template {
  key: TemplateKey;
  label: () => string;
  variants: readonly Variant[];
}

/** Templates with the names of their variants, in the order of the tabs. */
export const TEMPLATES: readonly Template[] = [
  { key: 'invite', label: () => m.system_mail_tpl_invite(), variants: [] },
  { key: 'reset', label: () => m.system_mail_tpl_reset(), variants: [] },
  { key: 'email', label: () => m.system_mail_tpl_email(), variants: [] },
  {
    key: 'security',
    label: () => m.system_mail_tpl_security(),
    variants: [
      { key: 'login', label: () => m.system_mail_var_login() },
      { key: 'login_no_place', label: () => m.system_mail_var_login_no_place() },
      { key: 'password', label: () => m.system_mail_var_password() },
      { key: 'password_sole_admin', label: () => m.system_mail_var_password_sole_admin() },
      { key: 'password_reset', label: () => m.system_mail_var_password_reset() },
      { key: 'email', label: () => m.system_mail_var_email() },
      { key: 'mfa_reset', label: () => m.system_mail_var_mfa_reset() },
      { key: 'totp_add', label: () => m.system_mail_var_totp_add() },
      { key: 'totp_add_first', label: () => m.system_mail_var_totp_add_first() },
      { key: 'totp_add_first_sole_admin', label: () => m.system_mail_var_totp_add_first_sole_admin() },
      { key: 'totp_remove', label: () => m.system_mail_var_totp_remove() },
      { key: 'totp_remove_last', label: () => m.system_mail_var_totp_remove_last() },
      { key: 'recovery_used', label: () => m.system_mail_var_recovery_used() },
      { key: 'recovery_used_none', label: () => m.system_mail_var_recovery_used_none() },
      { key: 'recovery_used_new_device', label: () => m.system_mail_var_recovery_used_new_device() },
      { key: 'recovery_codes', label: () => m.system_mail_var_recovery_codes() },
    ],
  },
  {
    key: 'digest',
    label: () => m.system_mail_tpl_digest(),
    variants: [
      { key: 'summary', label: () => m.system_mail_var_summary() },
      { key: 'one', label: () => m.system_mail_var_one() },
      { key: 'over_50', label: () => m.system_mail_var_over_50() },
      { key: 'instant', label: () => m.system_mail_var_instant() },
    ],
  },
  {
    key: 'system',
    label: () => m.system_mail_tpl_system(),
    variants: [
      { key: 'backup', label: () => m.system_mail_var_backup() },
      { key: 'update', label: () => m.system_mail_var_update() },
    ],
  },
  // Own template without variants; the recipient of the preview is the signed-in administrator.
  { key: 'test', label: () => m.system_mail_tpl_test(), variants: [] },
];

/**
 * Preview document for the iframe: links open a new tab (`<base
 * target="_blank">`; in the reading area `render.ts` sets `target` per link).
 * The element goes into the `head`, not behind a `<!DOCTYPE>`, so that the
 * document does not fall into quirks mode.
 */
export function previewDocument(html: string): string {
  const base = '<base target="_blank">';
  const at = /<head(\s[^>]*)?>/i.exec(html) ?? /^\s*<!doctype[^>]*>/i.exec(html);
  if (!at) return base + html;
  const end = at.index + at[0].length;
  return html.slice(0, end) + base + html.slice(end);
}

/** Up to this many variants a segment, above that the select list. */
const MAX_SEGMENTS = 4;

function templateOf(key: TemplateKey): Template {
  return TEMPLATES.find((t) => t.key === key) ?? TEMPLATES[0]!;
}

/**
 * Path of the request; `variant` only for templates with variants, `theme` only for HTML,
 * `lang` always: the UI language applies right away, even before the server has saved it.
 */
export function previewPath(
  tpl: TemplateKey,
  variant: string | null,
  format: PreviewFormat,
  theme: PreviewTheme,
  lang: Lang,
): string {
  const q: [string, string][] = [['template', tpl]];
  if (variant !== null) q.push(['variant', variant]);
  q.push(['format', format]);
  if (format === 'html') q.push(['theme', theme]);
  q.push(['lang', lang]);
  return `admin/system-mail/preview?${q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

export class MailPreview {
  tpl = $state<TemplateKey>('invite');
  /** Chosen variant; `null` for templates without variants. */
  variant = $state<string | null>(null);
  format = $state<PreviewFormat>('html');
  theme = $state<PreviewTheme>('light');
  /** Last loaded preview; stays while reloading, a failure forgets it. */
  shown = $state.raw<ShownPreview | null>(null);
  /** A request is running. */
  loading = $state(false);
  /** Reason of the last failure; `null` = no error or a new request is running. */
  error = $state<string | null>(null);

  #seq = 0;
  #disposed = false;

  /** Variants of the chosen template. */
  get variants(): readonly Variant[] {
    return templateOf(this.tpl).variants;
  }

  /**
   * Loads the preview of the current choice; a later request supersedes a
   * running one. After a failure the card disappears while loading (empty
   * frame as on the first load) and comes back on another failure.
   */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    const { tpl, variant, format, theme } = this;
    const lang = prefs.lang;
    this.loading = true;
    this.error = null;
    try {
      const data = await api<MailPreviewData>('GET', previewPath(tpl, variant, format, theme, lang));
      if (seq !== this.#seq || this.#disposed) return;
      this.shown = { subject: data.subject, from: data.from, to: data.to, body: data.body, format, theme };
    } catch (error) {
      if (seq !== this.#seq || this.#disposed) return;
      // Without a session or role: reload the account, the layout then shows the sign-in or "Access denied".
      if (isApiError(error, 401) || isApiError(error, 403)) void session.refreshUser().catch(() => {});
      this.error = failText(error);
      this.shown = null;
    } finally {
      if (seq === this.#seq && !this.#disposed) this.loading = false;
    }
  }

  /** "Try again" of the card. */
  retry(): Promise<void> {
    return this.load();
  }

  /**
   * Choose a template; the variant starts at the first and the preview
   * reloads. The active tab too: it resets the variant and reloads.
   */
  setTemplate(key: TemplateKey): void {
    this.tpl = key;
    this.variant = templateOf(key).variants[0]?.key ?? null;
    void this.load();
  }

  setVariant(key: string): void {
    if (key === this.variant || !this.variants.some((v) => v.key === key)) return;
    this.variant = key;
    void this.load();
  }

  setFormat(format: PreviewFormat): void {
    if (format === this.format) return;
    this.format = format;
    void this.load();
  }

  setTheme(theme: PreviewTheme): void {
    if (theme === this.theme) return;
    this.theme = theme;
    // The text knows no theme: only load with the next HTML.
    if (this.format === 'html') void this.load();
  }

  dispose(): void {
    this.#disposed = true;
  }
}

/** Tab of a template; colours per `on` in the page. */
export interface PreviewTab {
  key: TemplateKey;
  label: string;
  on: boolean;
  onClick: () => void;
}

/** Loading, switching and load errors of the preview. */
export interface PreviewLoad {
  /** A request is running: `aria-busy` on header and frame. */
  busy: boolean;
  /** "Loading preview …" pill at the top of the frame. */
  spin: boolean;
  /** No preview yet: header without values, empty frame of 560 px. */
  first: boolean;
  /** Preview present: values in the header and mail in the frame. */
  ok: boolean;
  /** Loading failed: card instead of header and frame. */
  fail: boolean;
  /** Header and frame visible. */
  show: boolean;
  /** Previous preview dimmed while the new one loads (`op` 0.55). */
  dim: boolean;
  title: string;
  text: string;
  onRetry: () => void;
}

/** Values of the templates section. */
export interface MailPreviewValues {
  mvTabs: PreviewTab[];
  mvVarSeg: boolean;
  mvVarList: boolean;
  mvVarOpts: SegOption<string>[];
  /** "Variant" select list; `null` without a list. */
  mvVarSel: SelectValues | null;
  mvModeOpts: SegOption<PreviewFormat>[];
  mvThemeOpts: SegOption<PreviewTheme>[];
  /** Light/dark only for HTML, per the choice (also while the previous preview is still shown). */
  mvThemeOn: boolean;
  mvSubj: string;
  mvFrom: string;
  /** "From" with sender or without (`from` null): notice `mvFromHint`. */
  mvFromOk: boolean;
  mvFromNo: boolean;
  mvFromHint: string;
  mvTo: string;
  /** HTML document of the loaded preview for the isolated iframe; `null` for text or before the first response. */
  mvDoc: string | null;
  /** Text of the loaded preview; `null` for HTML or before the first response. */
  mvText: string | null;
  /** Colour scheme of the loaded HTML preview (frame background, `color-scheme` of the iframe). */
  mvScheme: PreviewTheme;
  mvLoad: PreviewLoad;
}

/** Key of the "Variant" select list. */
export const VARIANT_PICK = 'mvvar';

export function mailPreviewValues<K extends string>(
  p: MailPreview,
  input: SelectState<K | typeof VARIANT_PICK>,
  ctx: SelectContext<K | typeof VARIANT_PICK>,
): MailPreviewValues {
  const variants = p.variants;
  const list = variants.length > MAX_SEGMENTS;
  const shown = p.shown;
  // During a request `error` is empty; the card only shows after a failure.
  const fail = p.error;
  const cur = p.variant ?? '';
  const label = (key: string) => variants.find((v) => v.key === key)?.label() ?? key;
  return {
    mvTabs: TEMPLATES.map((t) => ({
      key: t.key,
      label: t.label(),
      on: t.key === p.tpl,
      onClick: () => p.setTemplate(t.key),
    })),
    mvVarSeg: variants.length > 0 && !list,
    mvVarList: list,
    mvVarOpts: list
      ? []
      : segOptions(
          variants.map((v) => v.key),
          cur,
          label,
          (v) => p.setVariant(v),
        ),
    mvVarSel: list
      ? selectValues<K | typeof VARIANT_PICK>(
          VARIANT_PICK,
          m.system_mail_tpl_variant(),
          variants.map((v) => ({ v: v.key, l: v.label() })),
          cur,
          (v) => p.setVariant(v),
          false,
          input,
          ctx,
        )
      : null,
    mvModeOpts: segOptions<PreviewFormat>(
      ['html', 'text'],
      p.format,
      (f) => (f === 'html' ? m.system_mail_tpl_html() : m.system_mail_tpl_text()),
      (f) => p.setFormat(f),
    ),
    mvThemeOpts: segOptions<PreviewTheme>(
      ['light', 'dark'],
      p.theme,
      (t) => (t === 'dark' ? m.system_mail_tpl_dark() : m.system_mail_tpl_light()),
      (t) => p.setTheme(t),
    ),
    mvThemeOn: p.format === 'html',
    mvSubj: shown?.subject ?? '',
    mvFrom: shown?.from ?? '',
    mvFromOk: shown !== null && shown.from !== null,
    mvFromNo: shown !== null && shown.from === null,
    mvFromHint: m.system_mail_tpl_from_none(),
    mvTo: shown?.to ?? '',
    mvDoc: shown?.format === 'html' ? shown.body : null,
    mvText: shown?.format === 'text' ? shown.body : null,
    mvScheme: shown?.format === 'html' ? shown.theme : 'light',
    mvLoad: {
      busy: p.loading,
      spin: p.loading,
      first: shown === null && fail === null,
      ok: shown !== null,
      fail: fail !== null,
      show: fail === null,
      dim: p.loading && shown !== null,
      title: m.system_mail_tpl_failed(),
      text: fail ?? '',
      onRetry: () => void p.retry(),
    },
  };
}
