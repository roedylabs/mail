import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type Org, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  draftOf,
  firstBadSection,
  orgError,
  orgErrorsOf,
  orgErrorText,
  OrgPage,
  orgOf,
  orgValues,
} from './org.svelte.ts';
import { ApiError } from '#lib/api.ts';

/** A fully filled organization. */
const ORG0: Org = {
  name: 'Example Inc',
  website: 'https://example.com',
  help: 'https://example.com/help',
  email: 'support@example.com',
  imprint: 'https://example.com/imprint',
  privacy: 'https://example.com/privacy',
  terms: null,
  source: 'https://github.com/example/my-app',
};

const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: ORG0,
  banner: null,
  maintenance: { on: false, message: null },
  version: '0.1.0',
  update: null,
  setup_required: false,
  client_cache_version: 0,
};
const ME: Me = {
  id: 'u0',
  username: 'max',
  email: 'max@example.com',
  display_name: 'Max Example',
  role: 'admin',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: '2026-10-01T12:00:00Z',
  email_change: null,
  system_mail_configured: true,
};

const ctx = { scrollTo: vi.fn(), viewAbout: vi.fn() };

beforeEach(() => {
  // Copy: `setOrg` changes `org` in the session.
  session.config = { ...CONFIG };
  session.user = ME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  ctx.scrollTo.mockClear();
  ctx.viewAbout.mockClear();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
});

const sent = (calls: { method: string; path: string }[]) => calls.map((c) => `${c.method} ${c.path}`);

describe('draft and saved form', () => {
  it('empty fields mean null, texts are trimmed', () => {
    expect(draftOf(ORG0).terms).toBe('');
    expect(orgOf({ ...draftOf(ORG0), name: '  New Ltd ', website: '   ' })).toMatchObject({
      name: 'New Ltd',
      website: null,
    });
  });
});

describe('checking the fields like the backend', () => {
  it('name: too long over 120 characters, control characters invalid, counted like Rust chars()', () => {
    expect(orgError('name', 'x'.repeat(120))).toBeNull();
    expect(orgError('name', 'x'.repeat(121))).toBe('too_long');
    // 120 emoji are 240 UTF-16 units, but 120 characters.
    expect(orgError('name', '😀'.repeat(120))).toBeNull();
    expect(orgError('name', '😀'.repeat(121))).toBe('too_long');
    expect(orgError('name', 'Example\u0007Inc')).toBe('invalid');
    expect(orgError('name', 'Example\u0085Inc')).toBe('invalid');
    expect(orgError('name', '  Example Inc  ')).toBeNull();
  });

  it('email: too long over 254 characters, local@domain at the first @, without whitespace, ? and control characters', () => {
    const at = '@example.com';
    expect(orgError('email', 'a'.repeat(254 - at.length) + at)).toBeNull();
    expect(orgError('email', 'a'.repeat(255 - at.length) + at)).toBe('too_long');
    expect(orgError('email', 'support@example.com')).toBeNull();
    expect(orgError('email', 'a@b@c')).toBeNull();
    for (const bad of [
      'support',
      '@example.com',
      'support@',
      'sup port@example.com',
      'support@example.com?x',
      'a\u0001@b',
    ])
      expect(orgError('email', bad), bad).toBe('invalid');
  });

  it('links: too long over 2048 characters, only http:// or https:// with a host, without whitespace and control characters', () => {
    const base = 'https://example.com/';
    expect(orgError('website', base + 'x'.repeat(2048 - base.length))).toBeNull();
    expect(orgError('website', base + 'x'.repeat(2049 - base.length))).toBe('too_long');
    for (const ok of ['https://example.com', 'http://example.com/help', 'HTTPS://Example.com', 'http://localhost:8080'])
      expect(orgError('help', ok), ok).toBeNull();
    for (const bad of [
      'example.com',
      'www.example.com',
      'ftp://example.com',
      'javascript:alert(1)',
      'https://',
      'https://:443',
      'https://example .com',
      'https://example.com/\u0000',
    ])
      expect(orgError('imprint', bad), bad).toBe('invalid');
  });

  it('empty fields are never an error', () => {
    for (const k of ['name', 'website', 'help', 'email', 'imprint', 'privacy', 'terms', 'source'] as const) {
      expect(orgError(k, '')).toBeNull();
      expect(orgError(k, '   ')).toBeNull();
    }
  });

  it('names the error texts', () => {
    expect(orgErrorText('name', 'invalid')).toBe('The name contains invalid characters.');
    expect(orgErrorText('name', 'too_long')).toBe('The name can’t be longer than 120 characters.');
    expect(orgErrorText('email', 'invalid')).toBe('Please enter a valid email address.');
    expect(orgErrorText('email', 'too_long')).toBe('The email address can’t be longer than 254 characters.');
    expect(orgErrorText('source', 'invalid')).toBe('Please enter a complete URL, e.g. https://example.com.');
    expect(orgErrorText('terms', 'too_long')).toBe('The URL can’t be longer than 2048 characters.');
  });

  it('reads field errors only from a 422 with known fields and reasons', () => {
    const err = (fields: unknown, status = 422) => new ApiError(status, { error: 'invalid', fields });
    expect(orgErrorsOf(err({ website: { code: 'invalid' }, name: { code: 'too_long' } }))).toEqual({
      website: 'invalid',
      name: 'too_long',
    });
    expect(orgErrorsOf(err({ website: { code: 'required' }, color: { code: 'invalid' } }))).toEqual({});
    expect(orgErrorsOf(err({ website: { code: 'invalid' } }, 400))).toEqual({});
    expect(orgErrorsOf(new TypeError('offline'))).toEqual({});
  });

  it('jumps to the section of the first field in page order', () => {
    expect(firstBadSection({ source: 'invalid', email: 'invalid' })).toBe('support');
    expect(firstBadSection({ terms: 'too_long' })).toBe('legal');
    expect(firstBadSection({})).toBeNull();
  });
});

describe('OrgPage', () => {
  it('starts with org from public/config and takes admin/org into the session', async () => {
    const fresh = { ...ORG0, name: 'Other Inc' };
    const api = mockApi({ 'GET admin/org': [{ body: fresh }] });
    const p = new OrgPage(ctx);
    expect(p.draft.name).toBe('Example Inc');
    await p.load();
    expect(sent(api.calls)).toEqual(['GET admin/org']);
    expect(p.draft.name).toBe('Other Inc');
    expect(session.config?.org.name).toBe('Other Inc');
    expect(p.dirty).toBe(false);
  });

  it('keeps inputs when admin/org comes later; unchanged fields follow', async () => {
    mockApi({ 'GET admin/org': [{ body: { ...ORG0, name: 'Other Inc', help: null } }] });
    const p = new OrgPage(ctx);
    p.set('name', 'Own Inc');
    await p.load();
    expect(p.draft.name).toBe('Own Inc');
    expect(p.draft.help).toBe('');
    expect(p.dirty).toBe(true);
  });

  it('stays at the state from public/config if admin/org fails; 403 reloads the account', async () => {
    mockApi({ 'GET admin/org': [{ status: 500, body: { error: 'internal' } }] });
    const p = new OrgPage(ctx);
    await p.load();
    expect(p.draft.name).toBe('Example Inc');
    expect(ui.toast).toBeNull();

    const api = mockApi({
      'GET admin/org': [{ status: 403, body: { error: 'forbidden' } }],
      'GET auth/me': [{ body: { ...ME, role: 'user' } }],
    });
    await p.load();
    await vi.waitFor(() => expect(session.isAdmin).toBe(false));
    expect(sent(api.calls)).toEqual(['GET admin/org', 'GET auth/me']);
  });

  it('input shows the bar, discard reverts it', () => {
    const p = new OrgPage(ctx);
    expect(p.dirty).toBe(false);
    p.set('terms', 'https://example.com/terms');
    expect(p.dirty).toBe(true);
    p.discard();
    expect(p.dirty).toBe(false);
    expect(p.draft.terms).toBe('');
  });

  it('saves immediately in the display and sends only the changed fields after the toast', async () => {
    const saved = { ...ORG0, name: 'New Ltd', terms: 'https://example.com/terms', help: null };
    const api = mockApi({ 'PUT admin/org': [{ body: saved }] });
    const p = new OrgPage(ctx);
    p.set('name', '  New Ltd ');
    p.set('terms', 'https://example.com/terms');
    p.set('help', '');
    p.save();
    expect(p.dirty).toBe(false);
    expect(session.config?.org).toMatchObject({ name: 'New Ltd', help: null });
    expect(session.legal.privacy).toBe('https://example.com/privacy');
    expect(ui.toast).toMatchObject({ text: 'Changes saved', undo: true });
    expect(api.calls).toEqual([]);

    await ui.toasts.flush();
    expect(api.calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['PUT', 'admin/org', { name: 'New Ltd', help: null, terms: 'https://example.com/terms' }],
    ]);
    expect(session.config?.org).toEqual(saved);
    expect(p.dirty).toBe(false);
  });

  it('undo resets state and inputs without sending', () => {
    const api = mockApi({});
    const p = new OrgPage(ctx);
    p.set('name', 'New Ltd');
    p.save();
    ui.toasts.undo();
    expect(session.config?.org.name).toBe('Example Inc');
    expect(p.draft.name).toBe('Example Inc');
    expect(p.dirty).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it('shows errors live at the field; saving with an error: toast, jump, nothing sent', () => {
    const api = mockApi({});
    const p = new OrgPage(ctx);
    p.set('website', 'example.com');
    p.set('email', 'support');
    expect(p.errors).toEqual({ website: 'invalid', email: 'invalid' });
    const v = orgValues(p, ctx);
    expect(v.orgFirm[1]).toMatchObject({
      bad: true,
      badA: 'true',
      err: 'Please enter a complete URL, e.g. https://example.com.',
    });
    expect(v.orgFirm[0]).toMatchObject({ bad: false, badA: 'false', err: '' });
    p.save();
    expect(ui.toast).toMatchObject({ text: 'Please check the highlighted fields', undo: false, error: false });
    expect(ctx.scrollTo).toHaveBeenCalledWith('firm');
    expect(session.config?.org.website).toBe('https://example.com');
    expect(p.dirty).toBe(true);
    expect(api.calls).toEqual([]);
    // An empty field is never an error; the page does not add https://.
    p.set('website', '');
    p.set('email', 'help@example.com');
    expect(p.errors).toEqual({});
    p.save();
    expect(ui.toast?.text).toBe('Changes saved');
  });

  it('rejected (422): text at the field instead of an error toast, draft with bar, jump to the section', async () => {
    mockApi({
      'PUT admin/org': [
        {
          status: 422,
          body: { error: 'validation', fields: { imprint: { code: 'invalid' }, name: { code: 'too_long' } } },
        },
      ],
    });
    const p = new OrgPage(ctx);
    p.set('name', 'New Ltd');
    p.set('imprint', 'https://example.com/imprint-new');
    p.save();
    await ui.toasts.flush();
    expect(session.config?.org.imprint).toBe('https://example.com/imprint');
    expect(p.draft.imprint).toBe('https://example.com/imprint-new');
    expect(p.dirty).toBe(true);
    expect(p.errors).toEqual({ name: 'too_long', imprint: 'invalid' });
    expect(ctx.scrollTo).toHaveBeenCalledWith('firm');
    expect(ui.toast?.error ?? false).toBe(false);
    const v = orgValues(p, ctx);
    expect(v.orgLegal[0]?.err).toBe('Please enter a complete URL, e.g. https://example.com.');
    expect(v.orgFirm[0]?.err).toBe('The name can’t be longer than 120 characters.');
    // Saving works again only when the fields are changed; the server error disappears with the input.
    p.save();
    expect(ui.toast?.text).toBe('Please check the highlighted fields');
    p.set('imprint', 'https://example.com/imprint-2');
    expect(p.errors).toEqual({ name: 'too_long' });
    p.discard();
    expect(p.errors).toEqual({});
  });

  it('422 without known fields: generic error toast', async () => {
    mockApi({
      'PUT admin/org': [{ status: 422, body: { error: 'validation', fields: { color: { code: 'invalid' } } } }],
    });
    const p = new OrgPage(ctx);
    p.set('website', 'https://example.com/new');
    p.save();
    await ui.toasts.flush();
    expect(p.errors).toEqual({});
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
  });

  it('422 after leaving the page: the text of the first field as an error toast', async () => {
    mockApi({
      'PUT admin/org': [{ status: 422, body: { error: 'validation', fields: { email: { code: 'invalid' } } } }],
    });
    const p = new OrgPage(ctx);
    p.set('email', 'help@example.com');
    p.save();
    p.dispose();
    await ui.toasts.flush();
    expect(ctx.scrollTo).not.toHaveBeenCalled();
    expect(ui.toast).toMatchObject({ text: 'Please enter a valid email address.', error: true });
  });

  it('422 on a field changed in the meantime: no text at the field', async () => {
    let answer: (reply: { status: number; body: unknown }) => void = () => {};
    const api = mockApi({ 'PUT admin/org': [() => new Promise((resolve) => (answer = resolve))] });
    const p = new OrgPage(ctx);
    p.set('website', 'https://example.com/new');
    p.save();
    void ui.toasts.flush();
    await vi.waitFor(() => expect(api.calls).toHaveLength(1));
    p.set('website', 'https://example.com/other');
    answer({ status: 422, body: { error: 'validation', fields: { website: { code: 'invalid' } } } });
    await vi.waitFor(() => expect(ui.toast?.error).toBe(true));
    expect(p.draft.website).toBe('https://example.com/other');
    expect(p.errors).toEqual({});
  });

  it('without a connection: error toast "No connection", draft stays', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    const p = new OrgPage(ctx);
    p.set('email', 'help@example.com');
    p.save();
    await ui.toasts.flush();
    expect(p.draft.email).toBe('help@example.com');
    expect(ui.toast).toMatchObject({ text: 'No connection. Please try again.', error: true });
  });

  it('only whitespace changed: toast without a request', async () => {
    const api = mockApi({});
    const p = new OrgPage(ctx);
    p.set('name', 'Example Inc ');
    expect(p.dirty).toBe(true);
    p.save();
    expect(ui.toast?.text).toBe('Changes saved');
    await ui.toasts.flush();
    expect(api.calls).toEqual([]);
  });

  it('an older response of admin/org does not overwrite a pending save', async () => {
    mockApi({ 'GET admin/org': [{ body: ORG0 }], 'PUT admin/org': [{ body: { ...ORG0, name: 'New Ltd' } }] });
    const p = new OrgPage(ctx);
    p.set('name', 'New Ltd');
    p.save();
    await p.load();
    expect(session.config?.org.name).toBe('New Ltd');
    await ui.toasts.flush();
    expect(session.config?.org.name).toBe('New Ltd');
  });
  it('if the first of two saves fails, only its fields come back as inputs', async () => {
    let fail: (answer: { status: number; body: unknown }) => void = () => {};
    const second = { ...ORG0, imprint: 'https://example.com/imprint-new' };
    const api = mockApi({
      'PUT admin/org': [() => new Promise((resolve) => (fail = resolve)), { body: second }],
    });
    const p = new OrgPage(ctx);
    p.set('website', 'https://example.com/new');
    p.save();
    p.set('imprint', 'https://example.com/imprint-new');
    // The second toast sends the first save right away.
    p.save();
    await vi.waitFor(() => expect(api.calls).toHaveLength(1));
    fail({ status: 500, body: { error: 'internal' } });
    // The error toast sends the second save – only with the imprint.
    await vi.waitFor(() => expect(api.calls).toHaveLength(2));
    await ui.toasts.flush();
    expect(api.calls.map((c) => c.body)).toEqual([
      { website: 'https://example.com/new' },
      { imprint: 'https://example.com/imprint-new' },
    ]);
    expect(session.config?.org).toEqual(second);
    expect(p.edits).toEqual({ website: 'https://example.com/new' });
    expect(p.draft).toMatchObject({ website: 'https://example.com/new', imprint: 'https://example.com/imprint-new' });
    expect(p.dirty).toBe(true);
    expect(ui.toast).toMatchObject({ error: true });
  });
});

describe('orgValues', () => {
  it('returns sections, tabs and actions', () => {
    const p = new OrgPage(ctx);
    const v = orgValues(p, ctx);
    expect(v.orgTabs.map((t) => t.label)).toEqual(['Company', 'Support', 'Legal', 'Source code']);
    v.orgTabs[2]?.onClick();
    expect(ctx.scrollTo).toHaveBeenCalledWith('legal');
    expect(v.orgFirm.map((f) => [f.label, f.desc, f.type, f.ph, f.value, f.sep])).toEqual([
      ['Name', 'Name of the organization', 'text', 'Example Inc.', 'Example Inc', false],
      ['Website', 'Linked from the name', 'url', 'https://', 'https://example.com', true],
    ]);
    expect(v.orgSupport.map((f) => f.label)).toEqual(['Help center', 'Support email']);
    expect(v.orgSupport[1]).toMatchObject({ type: 'email', ph: 'support@example.com' });
    expect(v.orgLegal.map((f) => [f.label, f.desc])).toEqual([
      ['Legal notice', 'Provider identification'],
      ['Privacy policy', 'How personal data is handled'],
      ['Terms of use', 'Optional'],
    ]);
    expect(v.orgSource).toMatchObject([{ label: 'Source code', desc: 'Repository URL' }]);
    expect(v.orgDirty).toBe(false);

    v.orgSource[0]?.onChange('https://codeberg.org/example/app');
    expect(orgValues(p, ctx).orgDirty).toBe(true);
    v.orgDiscard();
    expect(orgValues(p, ctx).orgDirty).toBe(false);
    v.viewAbout();
    expect(ctx.viewAbout).toHaveBeenCalled();
  });
});
