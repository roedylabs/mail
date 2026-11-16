import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetBanner, publicOf, type AdminBanner } from '#lib/banner.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicBanner, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

const sections = vi.hoisted(() => ({ scrollToSection: vi.fn() }));
vi.mock('#lib/sections.ts', () => sections);

/** Disabled banner from `GET admin/banner`. */
const OFF: AdminBanner = {
  on: false,
  title: 'Maintenance on Saturday',
  text: 'From 8 to 10 am',
  link: '',
  linkLabel: '',
  tone: 'accent',
  icon: 'ti-speakerphone',
  closable: true,
  revision: 2,
};
/** Active banner from `public/config`. */
const ON: PublicBanner = {
  title: 'New feature',
  text: 'Folders can now be shared',
  link: 'https://example.com/new',
  linkLabel: '',
  tone: 'soft',
  icon: 'ti-sparkles',
  closable: true,
  revision: 5,
};
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
  // Copy: `setBanner` changes `banner` in the session.
  session.config = { ...CONFIG };
  session.user = ME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  sections.scrollToSection.mockClear();
  ui.reset();
  prefs.reset();
  session.config = null;
  session.user = null;
  forgetBanner();
  window.dispatchEvent(new Event('resize'));
});

/** Page with the state from `admin/banner`; waits until it is shown. */
async function renderPage(banner: AdminBanner = OFF, routes: Parameters<typeof mockApi>[0] = {}) {
  session.config = { ...CONFIG, banner: publicOf(banner) };
  const api = mockApi({ 'GET admin/banner': [{ body: banner }], ...routes });
  const view = render(Page);
  await vi.waitFor(() => expect(api.calls).toHaveLength(1));
  await vi.waitFor(() => expect(field('Title')).toHaveValue(banner.title));
  return { ...view, ...api };
}

const onBanner = (b: PublicBanner): AdminBanner => ({ ...b, on: true });
const field = (label: string) => screen.getByRole('textbox', { name: label });
const sw = (label: string) => screen.getByRole('switch', { name: label });
const preview = () => screen.getByRole('figure');
const radios = (group: string) => within(screen.getByRole('radiogroup', { name: group })).getAllByRole('radio');
const radio = (group: string, name: string) =>
  within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name });
const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });
const puts = (calls: { method: string; path: string; body: unknown }[]) =>
  calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body]);

describe('Banner page', () => {
  it('shows heading, tabs, preview and sections with the state from admin/banner', async () => {
    const view = await renderPage();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Banner');
    expect(view.getByText('Custom notice shown to all users at the top of the app.')).toBeInTheDocument();
    for (const tab of ['Display', 'Content', 'Appearance']) {
      expect(view.getByRole('button', { name: tab })).toBeInTheDocument();
      expect(view.getByRole('heading', { level: 2, name: tab })).toBeInTheDocument();
    }
    expect(view.getByText('Appears above the header for all users.')).toBeInTheDocument();
    expect(view.getByText('Title and text appear on one line. Phones show only the title.')).toBeInTheDocument();
    expect(view.getByText('The banner’s color and icon.')).toBeInTheDocument();
    expect(view.getByText('Users can close the banner. It reappears after a change.')).toBeInTheDocument();

    // Display: off, closable.
    expect(sw('Show banner')).toHaveAttribute('aria-checked', 'false');
    expect(view.getByText('Off')).toBeInTheDocument();
    expect(sw('Dismissible')).toHaveAttribute('aria-checked', 'true');
    expect(view.queryByRole('button', { name: 'Unhide' })).toBeNull();

    // Content: fields with limits and placeholders, no label without a link.
    expect(field('Title')).toHaveAttribute('maxlength', '40');
    expect(field('Title')).toHaveAttribute('placeholder', 'New feature');
    expect(field('Text')).toHaveValue('From 8 to 10 am');
    expect(field('Text')).toHaveAttribute('maxlength', '140');
    expect(field('Text')).toHaveAttribute('placeholder', 'What’s it about?');
    expect(field('Link')).toHaveAttribute('type', 'url');
    expect(field('Link')).toHaveAttribute('placeholder', 'https://');
    expect(field('Link')).toHaveAttribute('aria-invalid', 'false');
    expect(view.queryByRole('textbox', { name: 'Label' })).toBeNull();

    // Preview with title, text and close, without button.
    const fig = preview();
    expect(fig).toHaveTextContent('Preview');
    expect(within(fig).getByText('Maintenance on Saturday')).toHaveStyle({ opacity: '1' });
    expect(within(fig).getByText('From 8 to 10 am')).toBeInTheDocument();
    expect(within(fig).queryByText('Learn more')).toBeNull();
    expect(within(fig).queryByRole('button')).toBeNull();

    // Appearance: four colours, eight icons, selection from the state.
    expect(radios('Color').map((r) => r.textContent)).toEqual(['Accent color', 'Soft', 'Dark', 'Warning']);
    expect(radio('Color', 'Accent color')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Color', 'Soft')).toHaveAttribute('aria-checked', 'false');
    expect(radios('Icon').map((r) => r.getAttribute('aria-label'))).toEqual([
      'Megaphone',
      'Info',
      'Warning',
      'Event',
      'New',
      'Tool',
      'Gift',
      'Heart',
    ]);
    expect(radio('Icon', 'Megaphone')).toHaveAttribute('aria-checked', 'true');
    expect(bar()).toBeNull();
  });

  it('shows the inputs, the link with label and the error at the link in the preview', async () => {
    const view = await renderPage();
    await fireEvent.input(field('Title'), { target: { value: '' } });
    expect(within(preview()).getByText('Title')).toHaveStyle({ opacity: '0.55' });
    await fireEvent.input(field('Title'), { target: { value: 'New in the mailbox' } });
    await fireEvent.input(field('Text'), { target: { value: 'Share folders' } });
    expect(within(preview()).getByText('New in the mailbox')).toHaveStyle({ opacity: '1' });
    expect(within(preview()).getByText('Share folders')).toBeInTheDocument();

    await fireEvent.input(field('Link'), { target: { value: 'example.com' } });
    expect(field('Link')).toHaveAttribute('aria-invalid', 'true');
    expect(view.getByRole('alert')).toHaveTextContent('The address must start with https://.');
    expect(within(preview()).getByText('Learn more')).toBeInTheDocument();
    expect(field('Label')).toHaveAttribute('maxlength', '24');
    expect(field('Label')).toHaveAttribute('placeholder', 'Learn more');
    expect(view.getByText(m.banner_field_label_hint())).toBeInTheDocument();

    await fireEvent.input(field('Link'), { target: { value: 'https://example.com/new' } });
    expect(field('Link')).toHaveAttribute('aria-invalid', 'false');
    expect(view.queryByRole('alert')).toBeNull();
    await fireEvent.input(field('Label'), { target: { value: 'View' } });
    expect(within(preview()).getByText('View')).toBeInTheDocument();
    expect(within(preview()).queryByText('Learn more')).toBeNull();

    await fireEvent.click(sw('Dismissible'));
    expect(sw('Dismissible')).toHaveAttribute('aria-checked', 'false');
    expect(within(bar() as HTMLElement).getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('selects colour and icon and discards the changes', async () => {
    await renderPage();
    expect(preview().firstElementChild).toHaveStyle({ color: 'var(--accink)' });
    await fireEvent.click(radio('Color', 'Dark'));
    expect(radio('Color', 'Dark')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Color', 'Accent color')).toHaveAttribute('aria-checked', 'false');
    expect(preview().firstElementChild).toHaveStyle({ color: 'var(--inkfg)' });
    await fireEvent.click(radio('Icon', 'Heart'));
    expect(radio('Icon', 'Heart')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Icon', 'Megaphone')).toHaveAttribute('aria-checked', 'false');

    const region = bar() as HTMLElement;
    expect(region).not.toBeNull();
    await fireEvent.click(within(region).getByRole('button', { name: 'Discard' }));
    expect(bar()).toBeNull();
    expect(radio('Color', 'Accent color')).toHaveAttribute('aria-checked', 'true');
    expect(radio('Icon', 'Megaphone')).toHaveAttribute('aria-checked', 'true');
  });

  it('saves with a toast and then sends only the changed fields', async () => {
    const saved: AdminBanner = { ...OFF, title: 'Maintenance on Sunday', tone: 'dark', revision: 3 };
    const view = await renderPage(OFF, { 'PUT admin/banner': [{ body: saved }] });
    await fireEvent.input(field('Title'), { target: { value: ' Maintenance on Sunday ' } });
    await fireEvent.click(radio('Color', 'Dark'));
    await fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Save' }));
    expect(bar()).toBeNull();
    expect(ui.toast?.text).toBe('Changes saved');
    expect(field('Title')).toHaveValue('Maintenance on Sunday');
    expect(puts(view.calls)).toEqual([]);

    await ui.toasts.flush();
    expect(puts(view.calls)).toEqual([['admin/banner', { title: 'Maintenance on Sunday', tone: 'dark' }]]);
    // Off it stays off; the notice bar shows nothing.
    expect(session.config?.banner).toBeNull();
    expect(sw('Show banner')).toHaveAttribute('aria-checked', 'false');
    expect(radio('Color', 'Dark')).toHaveAttribute('aria-checked', 'true');
    expect(bar()).toBeNull();
  });

  it('requires a title before saving and enabling and leads to the content', async () => {
    const view = await renderPage();
    await fireEvent.input(field('Title'), { target: { value: '  ' } });
    await fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Save' }));
    expect(ui.toast?.text).toBe('Please enter a title');
    expect(sections.scrollToSection).toHaveBeenCalledTimes(1);
    expect(sections.scrollToSection.mock.calls[0]?.[1]).toBe('content');

    await fireEvent.click(sw('Show banner'));
    expect(ui.confirm).toBeNull();
    expect(sections.scrollToSection).toHaveBeenCalledTimes(2);
    expect(sw('Show banner')).toHaveAttribute('aria-checked', 'false');
    expect(puts(view.calls)).toEqual([]);
  });

  it('enables after the confirmation and saves the changes along the way', async () => {
    const enabled: AdminBanner = { ...OFF, title: 'Maintenance on Sunday', on: true, revision: 3 };
    const view = await renderPage(OFF, { 'PUT admin/banner': [{ body: enabled }] });
    await fireEvent.input(field('Title'), { target: { value: 'Maintenance on Sunday' } });
    await fireEvent.click(sw('Show banner'));
    expect(ui.confirm).toMatchObject({
      title: 'Turn on banner?',
      text: 'All users will see the banner at the top of the app right away. Your changes will be saved.',
      ok: 'Turn on',
    });
    expect(puts(view.calls)).toEqual([]);

    ui.confirmOk();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Banner active'));
    expect(puts(view.calls)).toEqual([['admin/banner', { title: 'Maintenance on Sunday', on: true }]]);
    expect(sw('Show banner')).toHaveAttribute('aria-checked', 'true');
    expect(view.getByText('Active. All users see the banner.')).toBeInTheDocument();
    expect(session.config?.banner).toMatchObject({ title: 'Maintenance on Sunday', revision: 3 });
    expect(bar()).toBeNull();
  });

  it('disables with toast and undo and only sends afterwards', async () => {
    const off: AdminBanner = { ...onBanner(ON), on: false, revision: 6 };
    const view = await renderPage(onBanner(ON), { 'PUT admin/banner': [{ body: off }] });
    expect(sw('Show banner')).toHaveAttribute('aria-checked', 'true');
    expect(view.getByText('Active. All users see the banner.')).toBeInTheDocument();
    expect(field('Label')).toHaveValue('');
    await fireEvent.input(field('Text'), { target: { value: 'Share folders' } });
    expect(within(bar() as HTMLElement).getByText('Unsaved changes to the active banner')).toBeInTheDocument();
    await fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Discard' }));

    await fireEvent.click(sw('Show banner'));
    expect(ui.confirm).toBeNull();
    expect(ui.toast?.text).toBe('Banner turned off');
    expect(sw('Show banner')).toHaveAttribute('aria-checked', 'false');
    expect(view.getByText('Off')).toBeInTheDocument();
    expect(session.config?.banner).toBeNull();

    ui.toasts.undo();
    await vi.waitFor(() => expect(sw('Show banner')).toHaveAttribute('aria-checked', 'true'));
    expect(session.config?.banner).toMatchObject({ title: 'New feature', revision: 5 });
    expect(puts(view.calls)).toEqual([]);

    await fireEvent.click(sw('Show banner'));
    await ui.toasts.flush();
    expect(puts(view.calls)).toEqual([['admin/banner', { on: false }]]);
    expect(sw('Show banner')).toHaveAttribute('aria-checked', 'false');
    expect(field('Title')).toHaveValue('New feature');
  });

  it('shows a banner closed for me and shows it again', async () => {
    prefs.set({ bannerDismissedRev: 5 });
    const view = await renderPage(onBanner(ON));
    expect(view.getByText('Active. Hidden for you.')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Unhide' }));
    expect(prefs.values.bannerDismissedRev).toBeNull();
    expect(view.getByText('Active. All users see the banner.')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Unhide' })).toBeNull();
  });

  it('scrolls to the section via the tabs', async () => {
    const view = await renderPage();
    await fireEvent.click(view.getByRole('button', { name: 'Appearance' }));
    expect(sections.scrollToSection).toHaveBeenCalledTimes(1);
    const [root, key, animate] = sections.scrollToSection.mock.calls[0] as [HTMLElement, string, boolean];
    expect(key).toBe('look');
    expect(animate).toBe(true);
    expect(root.querySelector('[data-sec="look"]')).toHaveTextContent('Appearance');
    expect([...root.querySelectorAll('section')].map((s) => s.dataset.sec)).toEqual(['status', 'content', 'look']);
  });

  it('shows heading, shorter texts, "Show again" and the bar with two buttons on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    prefs.set({ bannerDismissedRev: 5 });
    const view = await renderPage(onBanner(ON));
    expect(ui.isMobile).toBe(true);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Banner');
    expect(view.getByText('Phones show only the title.')).toBeInTheDocument();
    expect(view.getByText('Users can close the banner')).toBeInTheDocument();
    // On mobile the preview shows only the title.
    expect(within(preview()).getByText('New feature')).toBeInTheDocument();
    expect(within(preview()).queryByText('Folders can now be shared')).toBeNull();
    expect(within(preview()).getByText('Learn more')).toBeInTheDocument();

    await fireEvent.click(view.getByRole('button', { name: 'Show again' }));
    expect(prefs.values.bannerDismissedRev).toBeNull();

    await fireEvent.input(field('Link'), { target: { value: 'http://example.com' } });
    expect(view.getByRole('alert')).toHaveTextContent('The address must start with https://.');
    const region = bar() as HTMLElement;
    expect(within(region).queryByText('Unsaved changes to the active banner')).toBeNull();
    expect(
      within(region)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Discard', 'Save']);
    await fireEvent.click(within(region).getByRole('button', { name: 'Discard' }));
    expect(field('Link')).toHaveValue('https://example.com/new');
  });
});
