import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { brandingOf, forgetBranding, type AdminBranding } from '#lib/branding.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

const sections = vi.hoisted(() => ({ scrollToSection: vi.fn() }));
vi.mock('#lib/sections.ts', () => sections);

/** State from `GET admin/branding`: default with a custom name. */
const ADMIN: AdminBranding = { ...BRAND0, name: 'Example Mail', imageName: '', imageMeta: '' };
const CONFIG: PublicConfig = {
  name: 'Example Mail',
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
  username: 'jane',
  email: 'jane@example.com',
  display_name: 'Jane Doe',
  role: 'admin',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: '2026-10-20T10:00:00Z',
  email_change: null,
  system_mail_configured: true,
};

beforeEach(() => {
  // Copy: `setBranding` changes name and branding in the session.
  session.config = { ...CONFIG };
  session.user = ME;
  // jsdom loads no images: pixel size for the check on upload.
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 512;
      naturalHeight = 512;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  forgetBranding();
  sections.scrollToSection.mockClear();
  ui.reset();
  prefs.reset();
  session.config = null;
  session.user = null;
  window.dispatchEvent(new Event('resize'));
});

/** Page with the state from `admin/branding`; waits for the response. */
async function renderPage(branding: AdminBranding = ADMIN, routes: Parameters<typeof mockApi>[0] = {}) {
  session.config = { ...CONFIG, name: branding.name ?? 'Roedy Mail', branding: brandingOf(branding) };
  const api = mockApi({ 'GET admin/branding': [{ body: branding }], ...routes });
  const view = render(Page);
  await vi.waitFor(() => expect(api.calls).toHaveLength(1));
  await Promise.resolve();
  return { ...view, ...api };
}

const field = (label: string) => screen.getByRole('textbox', { name: label });
const sw = (label: string) => screen.getByRole('switch', { name: label });
const radios = (group: string) => within(screen.getByRole('radiogroup', { name: group })).getAllByRole('radio');
const radio = (group: string, name: string) =>
  within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });
const stage = (label: string) => screen.getByText(label).closest('figure') as HTMLElement;
const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });
const fileInput = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;
const png = (name = 'logo.png', type = 'image/png') => new File([new Uint8Array(2048)], name, { type });
const puts = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body]);

describe('Branding page', () => {
  it('shows heading, tabs, preview and sections with the saved state', async () => {
    const view = await renderPage();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Branding');
    expect(view.getByText('App name, logo, brand color, and sign-in page.')).toBeInTheDocument();
    for (const tab of ['Name', 'Logo', 'Brand color', 'Sign-in page']) {
      expect(view.getByRole('button', { name: tab })).toBeInTheDocument();
      expect(view.getByRole('heading', { level: 2, name: tab })).toBeInTheDocument();
    }
    expect(view.getByText('Shown in the header, on the sign-in page, and in search.')).toBeInTheDocument();
    expect(view.getByText('Roedy logo, initials, icon, or your own image.')).toBeInTheDocument();
    expect(view.getByText('Default accent color for all users.')).toBeInTheDocument();
    expect(view.getByText('Greeting above the sign-in form.')).toBeInTheDocument();

    // Preview: header with rotated tile in the accent colour, app icon.
    const header = stage('Header');
    expect(within(header).getByText('Example Mail')).toBeInTheDocument();
    const tile = header.querySelector('.brand-tile') as HTMLElement;
    expect(tile).toHaveStyle({ backgroundColor: '#f5a06e', color: '#3a1b06', transform: 'rotate(-4deg)' });
    expect(within(stage('App icon')).getByText('Example Mail')).toBeInTheDocument();

    // Name and login page with limits and placeholders.
    expect(field('App name')).toHaveValue('Example Mail');
    expect(field('App name')).toHaveAttribute('maxlength', '32');
    expect(field('App name')).toHaveAttribute('placeholder', 'Roedy Mail');
    expect(view.getByText('Up to 32 characters')).toBeInTheDocument();
    expect(field('Heading')).toHaveValue('Welcome back');
    expect(field('Heading')).toHaveAttribute('maxlength', '48');
    expect(field('Heading')).toHaveAttribute('placeholder', 'Welcome back');
    expect(view.getByText(m.branding_login_title_hint())).toBeInTheDocument();
    expect(field('Text')).toHaveValue('Sign in with your account.');
    expect(field('Text')).toHaveAttribute('maxlength', '120');

    // Logo: kinds, plate, switch; default without an extra row.
    expect(radios('Type').map((r) => r.textContent)).toEqual(['Default', 'Initials', 'Icon', 'Image']);
    expect(radio('Type', 'Default')).toHaveAttribute('aria-checked', 'true');
    expect(radios('Tile').map((r) => r.textContent)).toEqual(['Accent color', 'Light', 'Dark']);
    expect(radio('Tile', 'Accent color')).toHaveAttribute('aria-checked', 'true');
    expect(view.queryByRole('radiogroup', { name: 'Size' })).toBeNull();
    expect(view.queryByRole('textbox', { name: 'Characters' })).toBeNull();
    expect(sw('Slightly tilted')).toHaveAttribute('aria-checked', 'true');
    expect(sw('Allow custom accent color')).toHaveAttribute('aria-checked', 'true');
    expect(sw('Background art')).toHaveAttribute('aria-checked', 'true');

    // Brand colour: five colours, apricot selected.
    expect(radios('Brand color').map((r) => r.textContent?.trim())).toEqual([
      'Apricot',
      'Sage',
      'Lavender',
      'Sky',
      'Rose',
    ]);
    expect(radio('Brand color', 'Apricot')).toHaveAttribute('aria-checked', 'true');

    // Default with a custom name: "Restore defaults", no bar.
    expect(view.getByRole('button', { name: 'Restore defaults' })).toBeInTheDocument();
    expect(bar()).toBeNull();
  });

  it('switches the kind: initial with character, icon with grid', async () => {
    const view = await renderPage();
    await fireEvent.click(radio('Type', 'Initials'));
    expect(radio('Type', 'Initials')).toHaveAttribute('aria-checked', 'true');
    expect(field('Characters')).toHaveAttribute('maxlength', '2');
    expect(field('Characters')).toHaveAttribute('placeholder', 'E');
    expect(
      view.getByText('One or two characters. Leave empty to use the first letter of the name.'),
    ).toBeInTheDocument();
    expect(within(stage('Header')).getByText('E')).toBeInTheDocument();
    await fireEvent.input(field('Characters'), { target: { value: 'XY' } });
    expect(within(stage('Header')).getByText('XY')).toBeInTheDocument();
    expect(bar()).not.toBeNull();

    await fireEvent.click(radio('Type', 'Icon'));
    expect(view.queryByRole('textbox', { name: 'Characters' })).toBeNull();
    expect(view.getByText('Shown in the text color on the tile')).toBeInTheDocument();
    expect(radios('Icon').map((r) => r.getAttribute('aria-label'))).toEqual([
      'Mountain',
      'Leaf',
      'Bolt',
      'Flame',
      'Star',
      'Heart',
      'Cloud',
      'Compass',
      'Diamond',
      'Rocket',
      'Feather',
      'Planet',
    ]);
    expect(radio('Icon', 'Mountain')).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(radio('Icon', 'Rocket'));
    expect(radio('Icon', 'Rocket')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Icon', 'Mountain')).toHaveAttribute('aria-checked', 'false');

    // Plate, colour and switch change the preview.
    await fireEvent.click(radio('Tile', 'Dark'));
    const tile = stage('Header').querySelector('.brand-tile') as HTMLElement;
    expect(tile).toHaveStyle({ backgroundColor: '#2b221c', color: '#fffaf3' });
    await fireEvent.click(sw('Slightly tilted'));
    expect(sw('Slightly tilted')).toHaveAttribute('aria-checked', 'false');
    expect(tile).toHaveStyle({ transform: 'none' });
    await fireEvent.click(radio('Brand color', 'Sage'));
    expect(radio('Brand color', 'Sage')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Brand color', 'Apricot')).toHaveAttribute('aria-checked', 'false');

    await fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Discard' }));
    expect(bar()).toBeNull();
    expect(radio('Type', 'Default')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Brand color', 'Apricot')).toHaveAttribute('aria-checked', 'true');
    expect(sw('Slightly tilted')).toHaveAttribute('aria-checked', 'true');
  });

  it('picks an image, shows name and details, replaces and removes it', async () => {
    const view = await renderPage();
    await fireEvent.click(radio('Type', 'Image'));
    expect(view.getByText('Square, at least 256 × 256 pixels')).toBeInTheDocument();
    const drop = view.getByRole('button', { name: /Drag an image here or choose one/ });
    expect(drop).toHaveTextContent('PNG, SVG, JPG, or WebP, up to 1 MB');
    expect(radios('Size').map((r) => r.textContent)).toEqual(['Padded', 'Fill']);

    // "Select" opens the hidden file field.
    const input = fileInput(view.container);
    expect(input).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp,image/svg+xml');
    const click = vi.spyOn(input, 'click');
    await fireEvent.click(drop);
    expect(click).toHaveBeenCalledTimes(1);

    await fireEvent.change(input, { target: { files: [png()] } });
    await vi.waitFor(() => expect(view.getByText('logo.png')).toBeInTheDocument());
    expect(view.getByText('PNG · 2 KB')).toBeInTheDocument();
    expect(input.value).toBe('');
    expect(view.queryByRole('button', { name: /Drag an image here/ })).toBeNull();
    expect(stage('Header').querySelector('img')).toHaveAttribute('src', expect.stringMatching(/^data:image\/png/));
    expect(bar()).not.toBeNull();

    await fireEvent.click(view.getByRole('button', { name: 'Replace' }));
    expect(click).toHaveBeenCalledTimes(2);
    await fireEvent.click(view.getByRole('button', { name: 'Remove image' }));
    expect(view.queryByText('logo.png')).toBeNull();
    expect(view.getByRole('button', { name: /Drag an image here/ })).toBeInTheDocument();

    // Without an image "Save" asks for one and leads to the logo.
    await fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Save' }));
    expect(ui.toast?.text).toBe('Please upload an image');
    expect(sections.scrollToSection.mock.calls[0]?.[1]).toBe('logo');
  });

  it('accepts an image by dropping and reports a wrong format at the drop zone', async () => {
    const view = await renderPage();
    await fireEvent.click(radio('Type', 'Image'));
    const drop = view.getByRole('button', { name: /Drag an image here/ });

    expect(await fireEvent.dragOver(drop, { dataTransfer: { files: [] } })).toBe(false);
    expect(drop).toHaveClass('drag');
    await fireEvent.dragLeave(drop);
    expect(drop).not.toHaveClass('drag');

    await fireEvent.drop(drop, { dataTransfer: { files: [png('notiz.txt', 'text/plain')] } });
    expect(view.getByRole('alert')).toHaveTextContent('This format isn’t supported. Use PNG, SVG, JPG, or WebP.');
    expect(drop).not.toHaveClass('drag');

    await fireEvent.drop(drop, { dataTransfer: { files: [png('marke.webp', 'image/webp')] } });
    await vi.waitFor(() => expect(view.getByText('marke.webp')).toBeInTheDocument());
    expect(view.getByText('WEBP · 2 KB')).toBeInTheDocument();
    expect(view.queryByRole('alert')).toBeNull();

    // Switching the kind removes the error.
    await fireEvent.drop(view.getByRole('group', { name: 'Image' }), {
      dataTransfer: { files: [png('gross.gif', 'image/gif')] },
    });
    expect(view.getByRole('alert')).toBeInTheDocument();
    await fireEvent.click(radio('Type', 'Default'));
    await fireEvent.click(radio('Type', 'Image'));
    expect(view.queryByRole('alert')).toBeNull();

    // Text in the SVG shows the reason at the same place.
    const svg = new File(['<svg><text>Acme</text></svg>'], 'marke.svg', { type: 'image/svg+xml' });
    await fireEvent.drop(view.getByRole('group', { name: 'Image' }), { dataTransfer: { files: [svg] } });
    await vi.waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('Text in SVG isn’t supported. Convert the text to paths.'),
    );
  });

  it('saves with a toast and then sends only the changed fields', async () => {
    const saved: AdminBranding = { ...ADMIN, name: 'New Mail', kind: 'initial', letter: 'N' };
    const view = await renderPage(ADMIN, { 'PUT admin/branding': [{ body: saved }] });
    await fireEvent.input(field('App name'), { target: { value: ' New Mail ' } });
    expect(within(stage('Header')).getByText('New Mail')).toBeInTheDocument();
    await fireEvent.click(radio('Type', 'Initials'));
    await fireEvent.input(field('Characters'), { target: { value: 'N' } });
    await fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Save' }));
    expect(bar()).toBeNull();
    expect(ui.toast?.text).toBe('Changes saved');
    expect(field('App name')).toHaveValue('New Mail');
    expect(session.appName).toBe('New Mail');
    expect(puts(view.calls)).toEqual([]);

    await ui.toasts.flush();
    expect(puts(view.calls)).toEqual([['admin/branding', { name: 'New Mail', kind: 'initial', letter: 'N' }]]);
    expect(session.config?.branding).toMatchObject({ kind: 'initial', letter: 'N' });
    expect(bar()).toBeNull();
  });

  it('requires a name before saving and leads to the name section', async () => {
    const view = await renderPage();
    await fireEvent.input(field('App name'), { target: { value: '  ' } });
    await fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Save' }));
    expect(ui.toast?.text).toBe('Please enter an app name');
    expect(sections.scrollToSection).toHaveBeenCalledTimes(1);
    expect(sections.scrollToSection.mock.calls[0]?.[1]).toBe('name');
    expect(puts(view.calls)).toEqual([]);
  });

  it('restores the default as a draft', async () => {
    const custom: AdminBranding = {
      ...ADMIN,
      name: null,
      kind: 'icon',
      icon: 'ti-rocket',
      color: 'rose',
      loginArt: false,
    };
    const view = await renderPage(custom);
    expect(field('App name')).toHaveValue('Roedy Mail');
    expect(radio('Icon', 'Rocket')).toHaveAttribute('aria-checked', 'true');
    expect(sw('Background art')).toHaveAttribute('aria-checked', 'false');

    await fireEvent.click(view.getByRole('button', { name: 'Restore defaults' }));
    expect(view.queryByRole('button', { name: 'Restore defaults' })).toBeNull();
    expect(radio('Type', 'Default')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Brand color', 'Apricot')).toHaveAttribute('aria-checked', 'true');
    expect(sw('Background art')).toHaveAttribute('aria-checked', 'true');
    expect(bar()).not.toBeNull();

    await fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Discard' }));
    expect(radio('Type', 'Icon')).toHaveAttribute('aria-checked', 'true');
    expect(view.getByRole('button', { name: 'Restore defaults' })).toBeInTheDocument();
  });

  it('scrolls to the section via the tabs', async () => {
    const view = await renderPage();
    await fireEvent.click(view.getByRole('button', { name: 'Brand color' }));
    expect(sections.scrollToSection).toHaveBeenCalledTimes(1);
    const [root, key, animate] = sections.scrollToSection.mock.calls[0] as [HTMLElement, string, boolean];
    expect(key).toBe('color');
    expect(animate).toBe(true);
    expect(root.querySelector('[data-sec="color"]')).toHaveTextContent('Brand color');
    expect([...root.querySelectorAll('section')].map((s) => s.dataset.sec)).toEqual(['name', 'logo', 'color', 'login']);
  });

  it('shows only the header, shorter texts, icon buttons at the image and the bar with two buttons on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = await renderPage();
    expect(ui.isMobile).toBe(true);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Branding');
    expect(stage('Header')).toBeInTheDocument();
    expect(view.queryByText('App icon')).toBeNull();
    expect(view.queryByText('What appears on the logo tile')).toBeNull();
    expect(view.getByText('Show the logo tile at an angle')).toBeInTheDocument();
    expect(view.getByText('Next to the form on large screens')).toBeInTheDocument();

    await fireEvent.click(radio('Type', 'Initials'));
    expect(view.getByText('One or two characters')).toBeInTheDocument();
    await fireEvent.click(radio('Type', 'Image'));
    expect(view.getByRole('button', { name: /Choose image/ })).toBeInTheDocument();
    await fireEvent.change(fileInput(view.container), { target: { files: [png()] } });
    await vi.waitFor(() => expect(view.getByText('logo.png')).toBeInTheDocument());
    expect(view.getByRole('button', { name: 'Replace image' })).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Replace' })).toBeNull();

    const region = bar() as HTMLElement;
    expect(within(region).queryByText('Unsaved changes')).toBeNull();
    expect(
      within(region)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Discard', 'Save']);
    await fireEvent.click(view.getByRole('button', { name: 'Remove image' }));
    expect(view.getByRole('button', { name: /Choose image/ })).toBeInTheDocument();
  });
});
