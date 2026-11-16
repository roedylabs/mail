import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  type AdminBranding,
  type BrandingDraft,
  BrandingPage,
  bodyOf,
  brandingValues,
  checkFile,
  defaultDraft,
  differs,
  fileMeta,
  forgetBranding,
  imageErrorOf,
  imageErrorText,
  imageSize,
  normalized,
  svgHasText,
} from './branding.svelte.ts';

/** Pixel size that the mocked `Image` reports (jsdom loads no images). */
let pixels = { width: 512, height: 512 };
/** Number of created `Image`s (the page does not measure SVGs). */
let images = 0;

class FakeImage {
  naturalWidth = pixels.width;
  naturalHeight = pixels.height;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    images++;
  }
  set src(_: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const IMAGE = '/branding/image/0123456789abcdef0123456789abcdef.png';

const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: {
    name: null,
    website: null,
    help: null,
    email: null,
    imprint: null,
    privacy: null,
    terms: null,
    source: null,
  },
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

/** Saved branding with a logo, as `GET admin/branding` returns it. */
const SAVED: AdminBranding = {
  ...BRAND0,
  name: 'Acme Mail',
  kind: 'image',
  image: IMAGE,
  imageName: 'acme.png',
  imageMeta: 'PNG · 12 KB',
  color: 'sage',
};

const ctx = { scrollTo: vi.fn() };

beforeEach(() => {
  // Copy: `setBranding` changes `name` and `branding` in the session.
  session.config = { ...CONFIG };
  session.user = ME;
  pixels = { width: 512, height: 512 };
  images = 0;
  vi.stubGlobal('Image', FakeImage);
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.reject(new Error('unexpected'))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetBranding();
  ctx.scrollTo.mockClear();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
});

const sent = (calls: { method: string; path: string }[]) => calls.map((c) => `${c.method} ${c.path}`);
const png = (bytes = 3, name = 'logo.png', type = 'image/png') => new File([new Uint8Array(bytes)], name, { type });

describe('helpers', () => {
  it('checks format and size of files', () => {
    expect(checkFile({ type: 'image/gif', size: 10 })).toBe('unsupported');
    expect(checkFile({ type: 'image/svg+xml', size: 1_048_577 })).toBe('too_large');
    expect(checkFile({ type: 'image/webp', size: 1_048_576 })).toBeNull();
  });

  it('describes files with format and size', () => {
    expect(fileMeta({ type: 'image/svg+xml', size: 100 })).toBe('SVG · 1 KB');
    expect(fileMeta({ type: 'image/jpeg', size: 2_000_000 })).toBe('JPG · 1,953 KB');
    expect(fileMeta({ type: 'image/webp', size: 12_288 })).toBe('WEBP · 12 KB');
  });

  it('names the five reasons with their texts', () => {
    expect(imageErrorText('unsupported')).toBe('This format isn’t supported. Use PNG, SVG, JPG, or WebP.');
    expect(imageErrorText('too_large')).toBe('The file is larger than 1 MB.');
    expect(imageErrorText('unreadable')).toBe('The file couldn’t be read.');
    expect(imageErrorText('svg_text')).toBe('Text in SVG isn’t supported. Convert the text to paths.');
    expect(imageErrorText('dimensions')).toBe('The image is too large. Use no more than 4096 × 4096 pixels.');
  });

  it('finds text in the SVG on the parsed document', () => {
    const NS = 'xmlns="http://www.w3.org/2000/svg"';
    expect(svgHasText(`<svg ${NS}><text x="0">A</text></svg>`)).toBe(true);
    expect(svgHasText(`<svg ${NS}><g><text/></g></svg>`)).toBe(true);
    expect(svgHasText('<svg:svg xmlns:svg="http://www.w3.org/2000/svg"><svg:text>A</svg:text></svg:svg>')).toBe(true);
    // without a namespace
    expect(svgHasText('<svg><text>A</text></svg>')).toBe(true);
    // `<text` in a comment, CDATA and style does not count.
    expect(svgHasText(`<svg ${NS}><!-- <text>A</text> --><path d="M0 0"/></svg>`)).toBe(false);
    expect(svgHasText(`<svg ${NS}><style><![CDATA[ <text> ]]></style><path d="M0 0"/></svg>`)).toBe(false);
    expect(svgHasText(`<svg ${NS}><desc>&lt;text&gt;</desc></svg>`)).toBe(false);
    expect(svgHasText(`<svg ${NS}><textPath href="#p"/><path d="M0 0"/></svg>`)).toBe(false);
    // Element names in XML are case-sensitive: <TEXT> is no text element.
    expect(svgHasText(`<svg ${NS}><TEXT>A</TEXT></svg>`)).toBe(false);
  });

  it('takes the regex if the SVG is not valid XML or DOMParser is missing', () => {
    // Prefix without a declaration: parse error
    expect(svgHasText('<svg:svg><svg:text>A</svg:text></svg:svg>')).toBe(true);
    expect(svgHasText('<svg><text>A</svg>')).toBe(true);
    expect(svgHasText('<svg><path d="M0 0"></svg>')).toBe(false);
    vi.stubGlobal('DOMParser', undefined);
    expect(svgHasText('<svg><!-- <text> --></svg>')).toBe(true);
    expect(svgHasText('<svg><path d="M0 0"/></svg>')).toBe(false);
  });

  it('measures images via an Image, createImageBitmap only without an Image', async () => {
    pixels = { width: 4097, height: 10 };
    await expect(imageSize(png(), 'data:,')).resolves.toEqual({ width: 4097, height: 10 });
    expect(images).toBe(1);
    expect(globalThis.createImageBitmap).not.toHaveBeenCalled();

    vi.stubGlobal('Image', undefined);
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 300, height: 200, close })),
    );
    await expect(imageSize(png(), 'data:,')).resolves.toEqual({ width: 300, height: 200 });
    expect(close).toHaveBeenCalled();
  });

  it('reads the code at fields.image only from 422', () => {
    const invalid = (code: string, field = 'image') =>
      new ApiError(422, { error: 'invalid', fields: { [field]: { code } } });
    expect(imageErrorOf(invalid('svg_text'))).toBe('svg_text');
    expect(imageErrorOf(invalid('required'))).toBeNull();
    expect(imageErrorOf(invalid('too_long', 'name'))).toBeNull();
    expect(imageErrorOf(new ApiError(500, { error: 'internal' }))).toBeNull();
  });

  it('normalises the draft before saving and compares drafts', () => {
    const d: BrandingDraft = {
      ...defaultDraft(),
      name: ' Acme ',
      letter: ' A ',
      loginTitle: '  ',
      loginText: ' Hello ',
    };
    expect(normalized(d)).toMatchObject({
      name: 'Acme',
      letter: 'A',
      loginTitle: BRAND0.loginTitle,
      loginText: 'Hello',
    });
    expect(differs({ ...defaultDraft(), name: ' Roedy Mail ' }, defaultDraft())).toBe(false);
    expect(differs({ ...defaultDraft(), tilt: false }, defaultDraft())).toBe(true);
  });

  it('sends only changed fields; the own name becomes null, a new logo with details', () => {
    const prev: BrandingDraft = { ...SAVED, name: 'Acme Mail' };
    expect(bodyOf({ ...prev, name: 'Roedy Mail', tilt: false }, prev)).toEqual({ name: null, tilt: false });
    expect(
      bodyOf({ ...prev, image: 'data:image/png;base64,AAAA', imageName: 'new.png', imageMeta: 'PNG · 1 KB' }, prev),
    ).toEqual({
      image: 'data:image/png;base64,AAAA',
      imageName: 'new.png',
      imageMeta: 'PNG · 1 KB',
    });
    expect(bodyOf({ ...prev, kind: 'standard', image: null, imageName: '', imageMeta: '' }, prev)).toEqual({
      kind: 'standard',
      image: null,
    });
  });
});

describe('BrandingPage', () => {
  it('starts with public/config and takes admin/branding with the file details', async () => {
    const api = mockApi({ 'GET admin/branding': [{ body: SAVED }] });
    const p = new BrandingPage(ctx);
    expect(p.draft.name).toBe('Roedy Mail');
    expect(p.draft.imageName).toBe('');
    await p.load();
    expect(sent(api.calls)).toEqual(['GET admin/branding']);
    expect(session.appName).toBe('Acme Mail');
    expect(session.branding).toMatchObject({ kind: 'image', image: IMAGE, color: 'sage' });
    expect(session.branding).not.toHaveProperty('imageName');
    expect(p.draft).toMatchObject({ name: 'Acme Mail', imageName: 'acme.png', imageMeta: 'PNG · 12 KB' });
    expect(p.dirty).toBe(false);
  });

  it('takes null as the default app name', async () => {
    mockApi({ 'GET admin/branding': [{ body: { ...SAVED, name: null } }] });
    const p = new BrandingPage(ctx);
    await p.load();
    expect(session.appName).toBe('Roedy Mail');
    expect(p.dirty).toBe(false);
  });

  it('stays with public/config if admin/branding fails; 403 reloads the account', async () => {
    mockApi({ 'GET admin/branding': [{ status: 500, body: { error: 'internal' } }] });
    const p = new BrandingPage(ctx);
    await p.load();
    expect(p.draft.name).toBe('Roedy Mail');
    expect(ui.toast).toBeNull();

    const api = mockApi({
      'GET admin/branding': [{ status: 403, body: { error: 'forbidden' } }],
      'GET auth/me': [{ body: { ...ME, role: 'user' } }],
    });
    await p.load();
    await vi.waitFor(() => expect(session.isAdmin).toBe(false));
    expect(sent(api.calls)).toEqual(['GET admin/branding', 'GET auth/me']);
  });

  it('reads a file as a data URL and switches to Image', async () => {
    const p = new BrandingPage(ctx);
    await p.readFile(png(2048));
    expect(p.draft).toMatchObject({ kind: 'image', imageName: 'logo.png', imageMeta: 'PNG · 2 KB' });
    expect(p.draft.image).toMatch(/^data:image\/png;base64,/);
    expect(p.dirty).toBe(true);
    expect(p.error).toBeNull();
  });

  it('rejects an SVG with text, accepts one without text', async () => {
    const svg = (body: string) => new File([body], 'logo.svg', { type: 'image/svg+xml' });
    const p = new BrandingPage(ctx);
    await p.readFile(svg('<svg xmlns="http://www.w3.org/2000/svg"><text>Acme</text></svg>'));
    expect(p.error).toBe('Text in SVG isn’t supported. Convert the text to paths.');
    expect(p.dirty).toBe(false);
    await p.readFile(svg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>'));
    expect(p.error).toBeNull();
    expect(p.draft).toMatchObject({ kind: 'image', imageName: 'logo.svg' });
    expect(images).toBe(0);
  });

  it('rejects images over 4096 pixels in width or height', async () => {
    const p = new BrandingPage(ctx);
    pixels = { width: 4097, height: 100 };
    await p.readFile(png(100));
    expect(p.error).toBe('The image is too large. Use no more than 4096 × 4096 pixels.');
    expect(p.dirty).toBe(false);
    pixels = { width: 100, height: 4097 };
    await p.readFile(png(100, 'logo.jpg', 'image/jpeg'));
    expect(p.error).toBe('The image is too large. Use no more than 4096 × 4096 pixels.');
    pixels = { width: 4096, height: 4096 };
    await p.readFile(png(100, 'logo.webp', 'image/webp'));
    expect(p.error).toBeNull();
    expect(p.draft).toMatchObject({ kind: 'image', imageName: 'logo.webp' });
  });

  it('an image that cannot be decoded is unreadable', async () => {
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', BrokenImage);
    const p = new BrandingPage(ctx);
    await p.readFile(png(100));
    expect(p.error).toBe('The file couldn’t be read.');
    expect(p.dirty).toBe(false);
  });

  it('rejects wrong formats and too large files with the texts from readBrandFile', async () => {
    const p = new BrandingPage(ctx);
    await p.readFile(png(3, 'logo.gif', 'image/gif'));
    expect(p.error).toBe('This format isn’t supported. Use PNG, SVG, JPG, or WebP.');
    expect(p.dirty).toBe(false);
    await p.readFile(png(1_048_577));
    expect(p.error).toBe('The file is larger than 1 MB.');
    p.setKind('icon');
    expect(p.error).toBeNull();
  });

  it('Remove clears logo and details, Discard reverts everything', async () => {
    mockApi({ 'GET admin/branding': [{ body: SAVED }] });
    const p = new BrandingPage(ctx);
    await p.load();
    p.removeImage();
    expect(p.draft).toMatchObject({ image: null, imageName: '', imageMeta: '' });
    expect(p.dirty).toBe(true);
    p.discard();
    expect(p.draft.image).toBe(IMAGE);
    expect(p.dirty).toBe(false);
  });

  it('initials at most two characters, emoji stay whole', () => {
    const p = new BrandingPage(ctx);
    p.setLetter('ABC');
    expect(p.draft.letter).toBe('AB');
    p.setLetter('A😀B');
    expect(p.draft.letter).toBe('A😀');
  });

  it('Discard, Remove, Reset and another kind cancel a running read', async () => {
    const p = new BrandingPage(ctx);
    for (const cancel of [() => p.discard(), () => p.removeImage(), () => p.reset(), () => p.setKind('icon')]) {
      const reading = p.readFile(png(100));
      cancel();
      await reading;
      expect(p.draft.image).toBeNull();
      expect(p.draft.kind).not.toBe('image');
    }
  });

  it('does not save without a name or without an image, but jumps to the section', () => {
    const p = new BrandingPage(ctx);
    p.set('name', '   ');
    p.save();
    expect(ui.toast).toMatchObject({ text: 'Please enter an app name', undo: false, error: false });
    expect(ctx.scrollTo).toHaveBeenCalledWith('name');
    p.set('name', 'Acme');
    p.setKind('image');
    p.save();
    expect(ui.toast?.text).toBe('Please upload an image');
    expect(ctx.scrollTo).toHaveBeenLastCalledWith('logo');
    expect(session.appName).toBe('Roedy Mail');
  });

  it('takes over at once, sends after the toast and takes the address from the response', async () => {
    const api = mockApi({
      'PUT admin/branding': [
        {
          body: {
            ...BRAND0,
            name: 'Acme',
            kind: 'image',
            image: IMAGE,
            imageName: 'logo.png',
            imageMeta: 'PNG · 1 KB',
            userAccent: false,
          },
        },
      ],
    });
    const p = new BrandingPage(ctx);
    p.set('name', ' Acme ');
    p.set('userAccent', false);
    await p.readFile(png(100));
    p.save();
    expect(session.appName).toBe('Acme');
    expect(session.branding.userAccent).toBe(false);
    expect(session.logo).toMatchObject({ isPad: true });
    expect(session.logo.src).toMatch(/^data:image\/png;base64,/);
    expect(p.dirty).toBe(false);
    expect(ui.toast).toMatchObject({ text: 'Changes saved', undo: true });
    expect(api.calls).toEqual([]);
    await ui.toasts.flush();
    expect(api.calls.map((c) => [c.method, c.path])).toEqual([['PUT', 'admin/branding']]);
    expect(api.calls[0]?.body).toMatchObject({
      name: 'Acme',
      kind: 'image',
      userAccent: false,
      imageName: 'logo.png',
      imageMeta: 'PNG · 1 KB',
    });
    expect((api.calls[0]?.body as { image: string }).image).toMatch(/^data:image\/png;base64,/);
    expect(session.branding.image).toBe(IMAGE);
    expect(p.draft).toMatchObject({ image: IMAGE, imageName: 'logo.png' });
    expect(p.dirty).toBe(false);
  });

  it('undo resets state and inputs without sending', () => {
    const api = mockApi({});
    const p = new BrandingPage(ctx);
    p.set('color', 'rose');
    p.save();
    expect(session.branding.color).toBe('rose');
    ui.toasts.undo();
    expect(session.branding.color).toBe(BRAND0.color);
    expect(p.dirty).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it('shows logo errors in brErr and restores the draft', async () => {
    mockApi({
      'GET admin/branding': [{ body: SAVED }],
      'PUT admin/branding': [{ status: 422, body: { error: 'invalid', fields: { image: { code: 'svg_text' } } } }],
    });
    const p = new BrandingPage(ctx);
    await p.load();
    await p.readFile(png(10, 'logo.svg', 'image/svg+xml'));
    p.save();
    await ui.toasts.flush();
    expect(session.branding.image).toBe(IMAGE);
    expect(p.error).toBe('Text in SVG isn’t supported. Convert the text to paths.');
    expect(ctx.scrollTo).toHaveBeenCalledWith('logo');
    expect(p.draft).toMatchObject({ imageName: 'logo.svg', imageMeta: 'SVG · 1 KB' });
    expect(p.draft.image).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(p.dirty).toBe(true);
    expect(ui.toast?.error ?? false).toBe(false);
  });

  it('shows logo errors as a toast if the page has already been left', async () => {
    mockApi({
      'PUT admin/branding': [{ status: 422, body: { error: 'invalid', fields: { image: { code: 'unsupported' } } } }],
    });
    const p = new BrandingPage(ctx);
    await p.readFile(png(10));
    p.save();
    p.dispose();
    await ui.toasts.flush();
    expect(session.branding.image).toBeNull();
    expect(ui.toast).toMatchObject({
      text: 'This format isn’t supported. Use PNG, SVG, JPG, or WebP.',
      error: true,
    });
    expect(ctx.scrollTo).not.toHaveBeenCalled();
  });

  it('other errors show the error toast', async () => {
    mockApi({
      'PUT admin/branding': [{ status: 422, body: { error: 'invalid', fields: { name: { code: 'too_long' } } } }],
    });
    const p = new BrandingPage(ctx);
    p.set('loginText', 'New');
    p.save();
    await ui.toasts.flush();
    expect(p.draft.loginText).toBe('New');
    expect(p.error).toBeNull();
    expect(ui.toast).toMatchObject({ error: true });
  });

  it('sends large requests without keepalive when the page is hidden', async () => {
    mockApi({ 'PUT admin/branding': [{ body: { ...SAVED } }, { body: { ...SAVED, tilt: false } }] });
    const fetch = vi.mocked(globalThis.fetch);
    const p = new BrandingPage(ctx);
    await p.readFile(png(60_000));
    p.save();
    await ui.toasts.flush(true);
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('keepalive');
    p.set('tilt', false);
    p.save();
    await ui.toasts.flush(true);
    expect(fetch.mock.calls[1]?.[1]).toHaveProperty('keepalive', true);
  });

  it('Reset restores BRAND0 as a draft and removes the logo when saving', async () => {
    const api = mockApi({
      'GET admin/branding': [{ body: SAVED }],
      'PUT admin/branding': [{ body: { ...BRAND0, name: null, imageName: '', imageMeta: '' } }],
    });
    const p = new BrandingPage(ctx);
    await p.load();
    expect(p.notDefault).toBe(true);
    p.reset();
    expect(p.notDefault).toBe(false);
    expect(p.dirty).toBe(true);
    p.save();
    await ui.toasts.flush();
    expect(api.calls[1]?.body).toEqual({ name: null, kind: 'standard', color: 'apricot', image: null });
    expect(session.appName).toBe('Roedy Mail');
    expect(session.branding.image).toBeNull();
  });
});

describe('brandingValues', () => {
  it('returns preview, kinds, icons and colours from the draft', () => {
    const p = new BrandingPage(ctx);
    let v = brandingValues(p, ctx);
    expect(v.brPrev).toMatchObject({ name: 'Roedy Mail', bg: '#f5a06e', ink: '#3a1b06', tilt: 'rotate(-4deg)' });
    expect(v.brPrev.logo.isMark).toBe(true);
    expect(v.brKindOpts.map((o) => [o.label, o.on])).toEqual([
      ['Default', true],
      ['Initials', false],
      ['Icon', false],
      ['Image', false],
    ]);
    expect(v.brKindExtra).toBe(false);
    expect(v.brIcons).toHaveLength(12);
    expect(v.brIcons[0]).toMatchObject({ icon: 'ti-mountain', label: 'Mountain', pressed: true });
    expect(v.brColors.find((c) => c.on)?.name).toBe('apricot');
    expect(v.brImgName).toBe('Logo');
    expect(v.brLetterPh).toBe('R');

    v.brKindOpts[1]?.onClick();
    v.onBrName('acme');
    v.brPlateOpts[2]?.onClick();
    v.tgBrTilt.onClick();
    v = brandingValues(p, ctx);
    expect(v.brIsInit).toBe(true);
    expect(v.brPrev).toMatchObject({ name: 'acme', bg: '#2b221c', ink: '#fffaf3', tilt: 'none' });
    expect(v.brPrev.logo).toMatchObject({ isInit: true, text: 'A' });
    expect(v.brLetterPh).toBe('A');
    expect(v.brDirty).toBe(true);
    expect(v.brNotDefault).toBe(true);

    v.brTabs[3]?.onClick();
    expect(ctx.scrollTo).toHaveBeenCalledWith('login');
  });
});
