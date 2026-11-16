import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicBanner, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui, type ConfirmRequest } from '#lib/state/ui.svelte.ts';
import { urlOk } from '#lib/links.ts';
import { ANN0, BannerPage, bannerValues, forgetBanner, normalized, type AdminBanner } from './banner.svelte.ts';

const SHOWN: PublicBanner = {
  title: 'Maintenance on Saturday',
  text: 'The app is unavailable from 8 to 10.',
  link: 'https://example.com/status',
  linkLabel: 'Status',
  tone: 'dark',
  icon: 'ti-calendar-event',
  closable: true,
  revision: 4,
};
const ON: AdminBanner = { ...SHOWN, on: true };
const OFF: AdminBanner = { ...SHOWN, on: false };

const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: { name: null, website: null, help: null, email: null, imprint: null, privacy: null, terms: null, source: null },
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

const ctx = { scrollTo: vi.fn() };
const pages: BannerPage[] = [];

/** Page with the state from `public/config` and – as when opened – `admin/banner`. */
async function open(banner: AdminBanner): Promise<BannerPage> {
  session.config = { ...CONFIG, banner: banner.on ? { ...SHOWN, ...banner } : null };
  mockApi({ 'GET admin/banner': [{ body: banner }] });
  const p = new BannerPage(ctx);
  pages.push(p);
  await p.load();
  return p;
}

beforeEach(() => {
  session.config = { ...CONFIG };
  session.user = ME;
});

afterEach(async () => {
  // Finish pending toasts so that counter and state do not leak into the next test.
  ui.toasts.discard();
  for (const p of pages.splice(0)) p.dispose();
  vi.unstubAllGlobals();
  ctx.scrollTo.mockClear();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
  forgetBanner();
  await Promise.resolve();
});

/** Open confirmation; without a function TypeScript would narrow `ui.confirm` to `null` after `= null`. */
const asked = (): ConfirmRequest | null => ui.confirm;

const calls = (api: ReturnType<typeof mockApi>) => api.calls.map((c) => [c.method, c.path, c.body]);

describe('check and shape', () => {
  it('urlOk: only https:// with a dot in the host', () => {
    expect(urlOk(' https://example.com/x ')).toBe(true);
    expect(urlOk('http://example.com')).toBe(false);
    expect(urlOk('https://localhost')).toBe(false);
    expect(urlOk('example.com')).toBe(false);
  });

  it('aNorm trims the texts', () => {
    expect(normalized({ ...ANN0, title: ' A ', linkLabel: ' B ' })).toMatchObject({ title: 'A', linkLabel: 'B' });
  });
});

describe('BannerPage', () => {
  it('starts without a banner with ANN0 and takes the draft from admin/banner', async () => {
    const p = new BannerPage(ctx);
    pages.push(p);
    expect(p.saved).toMatchObject({ ...ANN0, on: false, revision: 0 });
    const api = mockApi({ 'GET admin/banner': [{ body: OFF }] });
    await p.load();
    expect(calls(api)).toEqual([['GET', 'admin/banner', undefined]]);
    expect(p.draft.title).toBe('Maintenance on Saturday');
    expect(session.config?.banner).toBeNull();
    expect(bannerValues(p, ctx).annStatus).toBe('Off');
  });

  it('active from public/config; closed for me until “Show again”', async () => {
    const p = await open(ON);
    expect(bannerValues(p, ctx)).toMatchObject({
      annStatus: 'Active. All users see the banner.',
      annHiddenMe: false,
    });
    prefs.set({ bannerDismissedRev: 4 });
    expect(bannerValues(p, ctx)).toMatchObject({ annStatus: 'Active. Hidden for you.', annHiddenMe: true });
    bannerValues(p, ctx).annUnhide();
    expect(prefs.values.bannerDismissedRev).toBeNull();
    expect(p.hidden).toBe(false);
  });

  it('whitespace is no change; Discard reverts the inputs', async () => {
    const p = await open(ON);
    p.set('title', ' Maintenance on Saturday ');
    expect(p.dirty).toBe(false);
    p.set('tone', 'warning');
    expect(p.dirty).toBe(true);
    expect(bannerValues(p, ctx).annDirtyText).toBe('Unsaved changes to the active banner');
    p.discard();
    expect(p.dirty).toBe(false);
  });

  it('without a title or with a bad link: notice, jump to the content, nothing saved', async () => {
    const p = await open(OFF);
    p.set('title', '  ');
    p.save();
    expect(ui.toast).toMatchObject({ text: 'Please enter a title', error: false, undo: false });
    expect(ctx.scrollTo).toHaveBeenCalledWith('content');
    p.set('title', 'New');
    p.set('link', 'http://example.com');
    expect(p.linkBad).toBe(true);
    p.toggle();
    expect(ui.toast?.text).toBe('Please check the link');
    expect(ui.confirm).toBeNull();
    expect(p.saved.title).toBe('Maintenance on Saturday');
  });

  it('saves at once in the display (also again for me) and sends the changes after the toast', async () => {
    const p = await open(ON);
    prefs.set({ bannerDismissedRev: 4 });
    const api = mockApi({ 'PUT admin/banner': [{ body: { ...ON, title: 'New', tone: 'soft', revision: 5 } }] });
    p.set('title', ' New ');
    p.set('tone', 'soft');
    p.save();
    expect(session.config?.banner).toMatchObject({ title: 'New', tone: 'soft', revision: 5 });
    expect(p.hidden).toBe(false);
    expect(p.dirty).toBe(false);
    expect(ui.toast).toMatchObject({ text: 'Changes saved', undo: true });
    expect(api.calls).toEqual([]);
    await ui.toasts.flush();
    expect(calls(api)).toEqual([['PUT', 'admin/banner', { title: 'New', tone: 'soft' }]]);
    expect(session.config?.banner?.revision).toBe(5);
  });

  it('undo resets state and inputs without sending', async () => {
    const p = await open(ON);
    const api = mockApi({});
    p.set('text', 'Different');
    p.save();
    ui.toasts.undo();
    expect(session.config?.banner).toEqual(SHOWN);
    expect(p.draft.text).toBe(SHOWN.text);
    expect(api.calls).toEqual([]);
  });

  it('rejected link (422): inputs back with the bar, general error notice', async () => {
    const p = await open(OFF);
    mockApi({
      'PUT admin/banner': [{ status: 422, body: { error: 'invalid', fields: { link: { code: 'invalid' } } } }],
    });
    p.set('link', 'https://example.com/new');
    p.save();
    await ui.toasts.flush();
    expect(p.saved.link).toBe('https://example.com/status');
    expect(p.draft.link).toBe('https://example.com/new');
    expect(p.dirty).toBe(true);
    expect(ui.toast).toMatchObject({ text: 'Please check the link', error: true });
  });

  it('switching off at once with undo; after the toast { on: false }', async () => {
    const p = await open(ON);
    const api = mockApi({ 'PUT admin/banner': [{ body: { ...OFF, revision: 5 } }] });
    p.toggle();
    expect(session.config?.banner).toBeNull();
    expect(p.saved.on).toBe(false);
    expect(ui.toast).toMatchObject({ text: 'Banner turned off', undo: true });
    ui.toasts.undo();
    expect(session.config?.banner).toEqual(SHOWN);
    p.toggle();
    await ui.toasts.flush();
    expect(calls(api)).toEqual([['PUT', 'admin/banner', { on: false }]]);
    expect(p.saved).toMatchObject({ on: false, revision: 5, title: 'Maintenance on Saturday' });
  });

  it('switching on after confirmation, with the changes in one call', async () => {
    const p = await open(OFF);
    p.toggle();
    expect(ui.confirm).toMatchObject({
      title: 'Turn on banner?',
      text: 'All users will see the banner at the top of the app right away.',
      ok: 'Turn on',
    });
    ui.confirm = null;
    p.set('title', 'New ');
    p.toggle();
    expect(asked()?.text).toBe(
      'All users will see the banner at the top of the app right away. Your changes will be saved.',
    );
    const api = mockApi({ 'PUT admin/banner': [{ body: { ...ON, title: 'New', revision: 5 } }] });
    asked()?.run();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Banner active'));
    expect(session.config?.banner).toMatchObject({ title: 'New', revision: 5 });
    expect(calls(api)).toEqual([['PUT', 'admin/banner', { title: 'New', on: true }]]);
    expect(p.dirty).toBe(false);
  });

  it('switching on during the toast “Banner turned off”: first the switch-off, then the switch-on', async () => {
    const p = await open(ON);
    const api = mockApi({
      'PUT admin/banner': [{ body: { ...OFF, revision: 5 } }, { body: { ...ON, revision: 6 } }],
    });
    p.toggle();
    p.toggle();
    asked()?.run();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Banner active'));
    expect(calls(api)).toEqual([
      ['PUT', 'admin/banner', { on: false }],
      ['PUT', 'admin/banner', { on: true }],
    ]);
    expect(session.config?.banner).toMatchObject({ title: 'Maintenance on Saturday', revision: 6 });
  });

  it('without a response from admin/banner switching on sends all fields (the content on the server is unknown)', async () => {
    mockApi({ 'GET admin/banner': [{ status: 500, body: { error: 'internal' } }] });
    const p = new BannerPage(ctx);
    pages.push(p);
    await p.load();
    p.set('title', 'New');
    const api = mockApi({ 'PUT admin/banner': [{ body: { ...ANN0, title: 'New', on: true, revision: 3 } }] });
    p.toggle();
    asked()?.run();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Banner active'));
    expect(calls(api)).toEqual([['PUT', 'admin/banner', { ...ANN0, title: 'New', on: true }]]);
  });

  it('if switching on fails, it is off again and the inputs are back', async () => {
    const p = await open(OFF);
    mockApi({ 'PUT admin/banner': [{ status: 500, body: { error: 'internal' } }] });
    p.set('title', 'New');
    p.toggle();
    ui.confirm?.run();
    await vi.waitFor(() => expect(ui.toast?.error).toBe(true));
    expect(session.config?.banner).toBeNull();
    expect(p.draft.title).toBe('New');
    expect(p.dirty).toBe(true);
  });

  it('an older response from admin/banner does not overwrite a pending save', async () => {
    session.config = { ...CONFIG, banner: SHOWN };
    mockApi({
      'GET admin/banner': [{ body: ON }],
      'PUT admin/banner': [{ body: { ...ON, title: 'New', revision: 5 } }],
    });
    const p = new BannerPage(ctx);
    pages.push(p);
    p.set('title', 'New');
    p.save();
    await p.load();
    expect(session.config.banner?.title).toBe('New');
    await ui.toasts.flush();
    expect(session.config.banner?.title).toBe('New');
  });
});

describe('bannerValues', () => {
  it('preview with placeholder, tones and icons with their names', async () => {
    const p = await open({ ...ANN0, on: false, revision: 0 });
    const v = bannerValues(p, ctx);
    expect(v.annTabs.map((t) => t.label)).toEqual(['Display', 'Content', 'Appearance']);
    expect(v.annPrev).toMatchObject({
      title: 'Title',
      op: 0.55,
      act: 'Learn more',
      hasAct: false,
      hasClose: true,
      icon: 'ti-speakerphone',
      bg: 'var(--acc)',
    });
    expect(v.annTones.map((t) => [t.name, t.pressed])).toEqual([
      ['accent', true],
      ['soft', false],
      ['dark', false],
      ['warning', false],
    ]);
    expect(v.annIcons.map((i) => i.label)).toEqual([
      'Megaphone',
      'Info',
      'Warning',
      'Event',
      'New',
      'Tool',
      'Gift',
      'Heart',
    ]);
    v.annIcons[7]?.onClick();
    v.annTones[2]?.onClick();
    v.tgAnnClose.onClick();
    v.onAnnTitle('Hello');
    v.onAnnLink('https://example.com');
    const w = bannerValues(p, ctx);
    expect(w.annPrev).toMatchObject({
      icon: 'ti-heart',
      bg: 'var(--ink)',
      hasClose: false,
      title: 'Hello',
      op: 1,
      hasAct: true,
    });
    expect(w.annDirty).toBe(true);
    expect(w.annDirtyText).toBe('Unsaved changes');
    w.annTabs[2]?.onClick();
    expect(ctx.scrollTo).toHaveBeenCalledWith('look');
  });
});
