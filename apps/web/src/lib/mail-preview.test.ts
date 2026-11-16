import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MailPreview,
  mailPreviewValues,
  previewDocument,
  previewPath,
  TEMPLATES,
  type MailPreviewData,
  type MailPreviewValues,
} from '#lib/mail-preview.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { session } from '#lib/state/session.svelte.ts';

type Pick = 'mailsrv' | 'mvvar';

const ctx = { show: vi.fn<(key: Pick | null) => void>(), mark: vi.fn<(i: number | null) => void>() };
const values = (p: MailPreview, open: Pick | null = null, isMobile = false): MailPreviewValues =>
  mailPreviewValues<Pick>(p, { open, hi: null, isMobile }, ctx);

const INVITE: MailPreviewData = {
  subject: 'Invitation to Roedy Mail',
  from: 'Example Inc <noreply@example.com>',
  to: 'alex@example.com',
  body: '<!DOCTYPE html><html><head></head><body>Invitation</body></html>',
};

const path = (q: string) => `GET admin/system-mail/preview?${q}&lang=en`;

/** Response that arrives only on `release()`. */
function later(answer: { status?: number; body?: unknown }) {
  let release = () => {};
  const reply = () =>
    new Promise<{ status?: number; body?: unknown }>((resolve) => {
      release = () => resolve(answer);
    });
  return { reply, release: () => release() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  session.user = null;
});

describe('templates and variants', () => {
  it('knows the templates and variants in the order of the tabs', () => {
    expect(TEMPLATES.map((t) => [t.key, t.label(), t.variants.length])).toEqual([
      ['invite', 'Invitation', 0],
      ['reset', 'Reset password', 0],
      ['email', 'Confirm email address', 0],
      ['security', 'Security notice', 16],
      ['digest', 'Notification digest', 4],
      ['system', 'System notice', 2],
      ['test', 'Test email', 0],
    ]);
    expect(TEMPLATES[3]!.variants.map((v) => v.key)).toEqual([
      'login',
      'login_no_place',
      'password',
      'password_sole_admin',
      'password_reset',
      'email',
      'mfa_reset',
      'totp_add',
      'totp_add_first',
      'totp_add_first_sole_admin',
      'totp_remove',
      'totp_remove_last',
      'recovery_used',
      'recovery_used_none',
      'recovery_used_new_device',
      'recovery_codes',
    ]);
    expect(TEMPLATES[3]!.variants.map((v) => v.label())).toContain('First app added, sole administrator');
    expect(TEMPLATES[4]!.variants.map((v) => [v.key, v.label()])).toEqual([
      ['summary', 'Summary'],
      ['one', 'One item'],
      ['over_50', 'Over 50'],
      ['instant', 'Instant'],
    ]);
    expect(TEMPLATES[5]!.variants.map((v) => [v.key, v.label()])).toEqual([
      ['backup', 'Backup'],
      ['update', 'Update'],
    ]);
  });

  it('builds the path: variant only with variants, theme only for HTML, language always', () => {
    expect(previewPath('invite', null, 'html', 'light', 'de')).toBe(
      'admin/system-mail/preview?template=invite&format=html&theme=light&lang=de',
    );
    expect(previewPath('security', 'totp_remove_last', 'html', 'dark', 'de')).toBe(
      'admin/system-mail/preview?template=security&variant=totp_remove_last&format=html&theme=dark&lang=de',
    );
    expect(previewPath('digest', 'over_50', 'text', 'dark', 'en')).toBe(
      'admin/system-mail/preview?template=digest&variant=over_50&format=text&lang=en',
    );
    expect(previewPath('test', null, 'html', 'light', 'en')).toBe(
      'admin/system-mail/preview?template=test&format=html&theme=light&lang=en',
    );
  });
});

describe('document for the iframe', () => {
  it('puts `<base target="_blank">` at the start of the `head`', () => {
    expect(previewDocument('<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">')).toBe(
      '<!DOCTYPE html>\n<html lang="en">\n<head><base target="_blank">\n<meta charset="utf-8">',
    );
    expect(previewDocument('<html><HEAD lang="en"><title>x</title>')).toBe(
      '<html><HEAD lang="en"><base target="_blank"><title>x</title>',
    );
  });

  it('without a `head` after the DOCTYPE, otherwise at the start; `<header>` does not count', () => {
    expect(previewDocument('<!doctype html><body><header>x</header>')).toBe(
      '<!doctype html><base target="_blank"><body><header>x</header>',
    );
    expect(previewDocument('<p>x</p>')).toBe('<base target="_blank"><p>x</p>');
  });
});

describe('loading', () => {
  it('loads the invitation as light HTML and shows header and document', async () => {
    const api = mockApi({ [path('template=invite&format=html&theme=light')]: [{ body: INVITE }] });
    const p = new MailPreview();
    const before = values(p);
    expect(before).toMatchObject({ mvSubj: '', mvFrom: '', mvTo: '', mvDoc: null, mvText: null });
    expect(before.mvLoad).toMatchObject({ first: true, ok: false, fail: false, show: true, busy: false });
    const done = p.load();
    // First load: header without values, empty frame, pill, `aria-busy`.
    expect(values(p).mvLoad).toMatchObject({ first: true, ok: false, busy: true, spin: true, fail: false, dim: false });
    await done;
    expect(api.calls.map((c) => c.path)).toEqual([
      'admin/system-mail/preview?template=invite&format=html&theme=light&lang=en',
    ]);
    const v = values(p);
    expect(v).toMatchObject({
      mvSubj: 'Invitation to Roedy Mail',
      mvFrom: 'Example Inc <noreply@example.com>',
      mvTo: 'alex@example.com',
      mvDoc: INVITE.body,
      mvText: null,
      mvScheme: 'light',
      mvFromOk: true,
      mvFromNo: false,
      mvLoad: { first: false, ok: true, busy: false, spin: false, fail: false, show: true, dim: false },
      mvThemeOn: true,
      mvVarSeg: false,
      mvVarList: false,
      mvVarOpts: [],
      mvVarSel: null,
    });
    expect(v.mvTabs.map((t) => [t.label, t.on])).toEqual([
      ['Invitation', true],
      ['Reset password', false],
      ['Confirm email address', false],
      ['Security notice', false],
      ['Notification digest', false],
      ['System notice', false],
      ['Test email', false],
    ]);
    expect(v.mvModeOpts.map((o) => [o.label, o.on])).toEqual([
      ['HTML', true],
      ['Text', false],
    ]);
    expect(v.mvThemeOpts.map((o) => [o.label, o.on])).toEqual([
      ['Light', true],
      ['Dark', false],
    ]);
  });

  it('shows "From" without a sender as a notice', async () => {
    mockApi({ [path('template=invite&format=html&theme=light')]: [{ body: { ...INVITE, from: null } }] });
    const p = new MailPreview();
    await p.load();
    expect(values(p)).toMatchObject({
      mvFrom: '',
      mvFromOk: false,
      mvFromNo: true,
      mvFromHint: 'No sender yet – available after a successful connection test',
    });
  });

  it('test email: own template without variants', async () => {
    const test = { ...INVITE, subject: 'Test email from Roedy Mail', to: 'sam@example.com' };
    const api = mockApi({ [path('template=test&format=html&theme=light')]: [{ body: test }] });
    const p = new MailPreview();
    values(p)
      .mvTabs.find((t) => t.key === 'test')!
      .onClick();
    await vi.waitFor(() => expect(p.loading).toBe(false));
    expect(api.calls.map((c) => c.path)).toEqual([
      'admin/system-mail/preview?template=test&format=html&theme=light&lang=en',
    ]);
    expect(values(p)).toMatchObject({
      mvSubj: 'Test email from Roedy Mail',
      mvTo: 'sam@example.com',
      mvVarSeg: false,
      mvVarList: false,
      mvVarSel: null,
    });
    expect(p.variant).toBeNull();
  });

  it('system notice: two variants as a segment, the first chosen, switching loads the variant', async () => {
    const backup = { ...INVITE, subject: 'Backup completed' };
    const update = { ...INVITE, subject: 'Updated to version 0.2.0' };
    const api = mockApi({
      [path('template=system&variant=backup&format=html&theme=light')]: [{ body: backup }],
      [path('template=system&variant=update&format=html&theme=light')]: [{ body: update }],
    });
    const p = new MailPreview();
    values(p).mvTabs[5]!.onClick();
    await vi.waitFor(() => expect(p.loading).toBe(false));
    let v = values(p);
    expect(v.mvTabs[5]!.on).toBe(true);
    expect(v.mvVarSeg).toBe(true);
    expect(v.mvVarList).toBe(false);
    expect(v.mvVarOpts.map((o) => [o.label, o.on])).toEqual([
      ['Backup', true],
      ['Update', false],
    ]);
    expect(v.mvSubj).toBe('Backup completed');
    v.mvVarOpts[1]!.onClick();
    await vi.waitFor(() => expect(p.loading).toBe(false));
    v = values(p);
    expect(v.mvSubj).toBe('Updated to version 0.2.0');
    expect(v.mvVarOpts.map((o) => o.on)).toEqual([false, true]);
    expect(api.calls).toHaveLength(2);
  });

  it('security notice: 16 variants as the "Variant" select list, choosing closes the list', async () => {
    const api = mockApi({
      [path('template=security&variant=login&format=html&theme=light')]: [{ body: INVITE }],
      [path('template=security&variant=totp_remove_last&format=html&theme=light')]: [{ body: INVITE }],
    });
    const p = new MailPreview();
    p.setTemplate('security');
    await vi.waitFor(() => expect(p.loading).toBe(false));
    let v = values(p, 'mvvar');
    expect(v.mvVarSeg).toBe(false);
    expect(v.mvVarList).toBe(true);
    expect(v.mvVarOpts).toEqual([]);
    expect(v.mvVarSel).toMatchObject({ title: 'Variant', label: 'New sign-in', open: true });
    expect(v.mvVarSel!.opts).toHaveLength(16);
    v.mvVarSel!.toggle();
    expect(ctx.show).toHaveBeenLastCalledWith(null);
    values(p).mvVarSel!.toggle();
    expect(ctx.show).toHaveBeenLastCalledWith('mvvar');
    v.mvVarSel!.opts[11]!.onClick();
    expect(ctx.show).toHaveBeenLastCalledWith(null);
    await vi.waitFor(() => expect(p.loading).toBe(false));
    v = values(p);
    expect(v.mvVarSel!.label).toBe('Last app removed');
    expect(v.mvVarSel!.opts.filter((o) => o.on).map((o) => o.label)).toEqual(['Last app removed']);
    expect(api.calls.map((c) => c.path)).toEqual([
      'admin/system-mail/preview?template=security&variant=login&format=html&theme=light&lang=en',
      'admin/system-mail/preview?template=security&variant=totp_remove_last&format=html&theme=light&lang=en',
    ]);
  });

  it('on mobile the select list opens no popover (the layout shows the sheet)', () => {
    const p = new MailPreview();
    p.tpl = 'security';
    p.variant = 'login';
    expect(values(p, 'mvvar', true).mvVarSel!.open).toBe(false);
  });

  it('a new tab starts at the first variant', async () => {
    mockApi({
      [path('template=digest&variant=summary&format=html&theme=light')]: [{ body: INVITE }, { body: INVITE }],
      [path('template=digest&variant=instant&format=html&theme=light')]: [{ body: INVITE }],
      [path('template=system&variant=backup&format=html&theme=light')]: [{ body: INVITE }],
    });
    const p = new MailPreview();
    p.setTemplate('digest');
    p.setVariant('instant');
    p.setTemplate('system');
    expect(p.variant).toBe('backup');
    p.setTemplate('digest');
    expect(p.variant).toBe('summary');
    await vi.waitFor(() => expect(p.loading).toBe(false));
  });

  it('ignores unknown variants and the same choice', () => {
    const api = mockApi({});
    const p = new MailPreview();
    p.setTemplate('invite');
    p.setVariant('login');
    p.setFormat('html');
    p.setTheme('light');
    expect(p.variant).toBeNull();
    expect(api.calls).toEqual([]);
  });

  it('text: shows the text, no theme; light/dark with text does not load, only when switching to HTML', async () => {
    const text = { ...INVITE, body: 'Hello Alex,\n…' };
    const dark = { ...INVITE, body: '<html><head></head><body>dark</body></html>' };
    const api = mockApi({
      [path('template=invite&format=text')]: [{ body: text }],
      [path('template=invite&format=html&theme=dark')]: [{ body: dark }],
    });
    const p = new MailPreview();
    values(p).mvModeOpts[1]!.onClick();
    await vi.waitFor(() => expect(p.loading).toBe(false));
    let v = values(p);
    expect(v).toMatchObject({ mvThemeOn: false, mvText: 'Hello Alex,\n…', mvDoc: null });
    v.mvThemeOpts[1]!.onClick();
    expect(api.calls).toHaveLength(1);
    expect(p.theme).toBe('dark');
    values(p).mvModeOpts[0]!.onClick();
    await vi.waitFor(() => expect(p.loading).toBe(false));
    v = values(p);
    expect(v).toMatchObject({ mvThemeOn: true, mvDoc: dark.body, mvText: null, mvScheme: 'dark' });
    expect(api.calls.map((c) => c.path)).toEqual([
      'admin/system-mail/preview?template=invite&format=text&lang=en',
      'admin/system-mail/preview?template=invite&format=html&theme=dark&lang=en',
    ]);
  });

  it('shows the previous preview in its format until the new response', async () => {
    const text = later({ body: { ...INVITE, body: 'Text' } });
    mockApi({
      [path('template=invite&format=html&theme=light')]: [{ body: INVITE }],
      [path('template=invite&format=text')]: [text.reply],
    });
    const p = new MailPreview();
    await p.load();
    p.setFormat('text');
    let v = values(p);
    // Text is already chosen (controls), the HTML is still shown, dimmed with a pill.
    expect(v).toMatchObject({ mvThemeOn: false, mvDoc: INVITE.body, mvText: null });
    expect(v.mvModeOpts.map((o) => o.on)).toEqual([false, true]);
    expect(v.mvLoad).toMatchObject({ ok: true, first: false, busy: true, spin: true, dim: true });
    text.release();
    await vi.waitFor(() => expect(p.loading).toBe(false));
    v = values(p);
    expect(v).toMatchObject({ mvDoc: null, mvText: 'Text' });
    expect(v.mvLoad).toMatchObject({ ok: true, busy: false, spin: false, dim: false });
  });

  it('discards an older response that arrives after the newer one', async () => {
    const slow = later({ body: { ...INVITE, subject: 'old' } });
    mockApi({
      [path('template=invite&format=html&theme=light')]: [slow.reply],
      [path('template=reset&format=html&theme=light')]: [{ body: { ...INVITE, subject: 'new' } }],
    });
    const p = new MailPreview();
    const first = p.load();
    p.setTemplate('reset');
    await vi.waitFor(() => expect(values(p).mvSubj).toBe('new'));
    slow.release();
    await first;
    expect(values(p).mvSubj).toBe('new');
    expect(p.loading).toBe(false);
  });

  it('loading failed: card with reason, "Try again" reloads', async () => {
    const api = mockApi({
      [path('template=invite&format=html&theme=light')]: [
        { status: 500, body: { error: 'internal' } },
        { body: INVITE },
      ],
    });
    const p = new MailPreview();
    await p.load();
    let v = values(p);
    expect(v.mvLoad).toMatchObject({
      fail: true,
      show: false,
      busy: false,
      title: 'Couldn’t load the preview',
      text: 'That didn’t work. Please try again.',
    });
    v.mvLoad.onRetry();
    // During the new attempt the empty frame with `aria-busy` shows instead of the card.
    expect(values(p).mvLoad).toMatchObject({ fail: false, show: true, first: true, busy: true, spin: true });
    await vi.waitFor(() => expect(p.loading).toBe(false));
    v = values(p);
    expect(v.mvLoad).toMatchObject({ fail: false, ok: true });
    expect(v.mvSubj).toBe('Invitation to Roedy Mail');
    expect(api.calls).toHaveLength(2);
  });

  it('if a switch fails, the previous preview is forgotten; a new switch starts empty', async () => {
    mockApi({
      [path('template=invite&format=html&theme=light')]: [{ body: INVITE }],
      [path('template=reset&format=html&theme=light')]: [{ status: 500, body: { error: 'internal' } }],
      [path('template=email&format=html&theme=light')]: [{ body: { ...INVITE, subject: 'Confirm' } }],
    });
    const p = new MailPreview();
    await p.load();
    p.setTemplate('reset');
    await vi.waitFor(() => expect(p.loading).toBe(false));
    expect(values(p)).toMatchObject({ mvSubj: '', mvDoc: null, mvLoad: { fail: true, ok: false } });
    p.setTemplate('email');
    expect(values(p).mvLoad).toMatchObject({ fail: false, first: true, busy: true });
    await vi.waitFor(() => expect(p.loading).toBe(false));
    expect(values(p).mvSubj).toBe('Confirm');
  });

  it('without a connection: reason "No connection"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const p = new MailPreview();
    await p.load();
    expect(values(p).mvLoad).toMatchObject({ fail: true, text: 'No connection. Please try again.' });
  });

  it('without a role: reloads the account', async () => {
    const api = mockApi({
      [path('template=invite&format=html&theme=light')]: [{ status: 403, body: { error: 'forbidden' } }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    const p = new MailPreview();
    await p.load();
    await vi.waitFor(() => expect(api.calls.map((c) => `${c.method} ${c.path}`)).toContain('GET auth/me'));
  });

  it('after dispose the state stays', async () => {
    const slow = later({ body: INVITE });
    mockApi({ [path('template=invite&format=html&theme=light')]: [slow.reply] });
    const p = new MailPreview();
    const done = p.load();
    p.dispose();
    slow.release();
    await done;
    expect(p.shown).toBeNull();
  });
});
