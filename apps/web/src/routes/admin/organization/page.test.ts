import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type Org, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';
import SOURCE from './+page.svelte?raw';

const nav = vi.hoisted(() => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
const sections = vi.hoisted(() => ({ scrollToSection: vi.fn() }));
vi.mock('#lib/sections.ts', () => sections);

/** State from `public/config`. */
const ORG: Org = {
  name: 'Example Ltd',
  website: 'https://example.com',
  help: null,
  email: null,
  imprint: 'https://example.com/imprint',
  privacy: null,
  terms: null,
  source: null,
};
/** State from `GET admin/org`, extended in the meantime. */
const ADMIN_ORG: Org = { ...ORG, help: 'https://example.com/help', source: 'https://github.com/example/mail' };
const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: ORG,
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
  // Copy: `setOrg` changes `org` in the session.
  session.config = { ...CONFIG };
  session.user = ME;
});

afterEach(() => {
  vi.unstubAllGlobals();
  nav.goto.mockClear();
  sections.scrollToSection.mockClear();
  ui.reset();
  prefs.reset();
  session.config = null;
  session.user = null;
  window.dispatchEvent(new Event('resize'));
});

function renderPage(routes: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({ 'GET admin/org': [{ body: ADMIN_ORG }], ...routes });
  return { ...render(Page), ...api };
}

const field = (label: string) => screen.getByRole('textbox', { name: label });
const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });

describe('Organization page', () => {
  it('shows heading, tabs, notice and the fields with the state from public/config and admin/org', async () => {
    const view = renderPage();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Organization');
    expect(view.getByText('Company details, support, and legal notices.')).toBeInTheDocument();
    for (const tab of ['Company', 'Support', 'Legal', 'Source code']) {
      expect(view.getByRole('button', { name: tab })).toBeInTheDocument();
      expect(view.getByRole('heading', { level: 2, name: tab })).toBeInTheDocument();
    }
    expect(
      view.getByText('All users see this information under Settings › About. Empty fields are hidden there.'),
    ).toBeInTheDocument();
    expect(view.getByText('Named as the provider on the About page.')).toBeInTheDocument();
    expect(view.getByText('Where users can go with questions.')).toBeInTheDocument();
    expect(view.getByText('Required disclosures and policies.')).toBeInTheDocument();
    expect(view.getByText('Linked under Licenses.')).toBeInTheDocument();
    expect(view.getByText('Provider identification')).toBeInTheDocument();

    // Immediately the state from public/config, without bar.
    expect(field('Name')).toHaveValue('Example Ltd');
    expect(field('Name')).toHaveAttribute('placeholder', 'Example Inc.');
    expect(field('Website')).toHaveAttribute('type', 'url');
    expect(field('Website')).toHaveAttribute('placeholder', 'https://');
    expect(field('Support email')).toHaveAttribute('type', 'email');
    expect(field('Support email')).toHaveAttribute('placeholder', 'support@example.com');
    expect(field('Help center')).toHaveValue('');
    expect(field('Source code')).toHaveValue('');
    expect(view.getAllByRole('textbox')).toHaveLength(8);
    expect(bar()).toBeNull();

    // Then the state from admin/org.
    await vi.waitFor(() => expect(field('Help center')).toHaveValue('https://example.com/help'));
    expect(field('Source code')).toHaveValue('https://github.com/example/mail');
    expect(bar()).toBeNull();
  });

  it('shows the bar after an input and discards the changes', async () => {
    renderPage();
    await vi.waitFor(() => expect(field('Help center')).toHaveValue('https://example.com/help'));
    await fireEvent.input(field('Name'), { target: { value: 'Example Inc' } });
    const region = bar();
    expect(region).not.toBeNull();
    expect(within(region as HTMLElement).getByText('Unsaved changes')).toBeInTheDocument();
    await fireEvent.click(within(region as HTMLElement).getByRole('button', { name: 'Discard' }));
    expect(bar()).toBeNull();
    expect(field('Name')).toHaveValue('Example Ltd');
  });

  it('saves with a toast and then sends only the changed fields', async () => {
    const saved: Org = { ...ADMIN_ORG, name: 'Example Inc', imprint: null };
    const view = renderPage({ 'PUT admin/org': [{ body: saved }] });
    await vi.waitFor(() => expect(field('Help center')).toHaveValue('https://example.com/help'));
    await fireEvent.input(field('Name'), { target: { value: ' Example Inc ' } });
    await fireEvent.input(field('Legal notice'), { target: { value: '' } });
    await fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Save' }));
    expect(bar()).toBeNull();
    expect(ui.toast?.text).toBe('Changes saved');
    expect(field('Name')).toHaveValue('Example Inc');
    expect(view.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);

    await ui.toasts.flush();
    const puts = view.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => [c.path, c.body])).toEqual([['admin/org', { name: 'Example Inc', imprint: null }]]);
    expect(session.config?.org).toEqual(saved);
    expect(field('Legal notice')).toHaveValue('');
    expect(bar()).toBeNull();
  });

  it('scrolls to the section via the tabs and leads to Settings › About', async () => {
    const view = renderPage();
    await fireEvent.click(view.getByRole('button', { name: 'Legal' }));
    expect(sections.scrollToSection).toHaveBeenCalledTimes(1);
    const [root, key, animate] = sections.scrollToSection.mock.calls[0] as [HTMLElement, string, boolean];
    expect(key).toBe('legal');
    expect(animate).toBe(true);
    expect(root.querySelector('[data-sec="legal"]')).toHaveTextContent('Legal');
    expect([...root.querySelectorAll('section')].map((s) => s.dataset.sec)).toEqual([
      'firm',
      'support',
      'legal',
      'source',
    ]);
    await fireEvent.click(view.getByRole('button', { name: 'View page' }));
    expect(nav.goto).toHaveBeenCalledWith('/settings/about');
  });

  it('shows field errors live at the field and does not save with an error', async () => {
    const view = renderPage();
    await vi.waitFor(() => expect(field('Help center')).toHaveValue('https://example.com/help'));
    expect(field('Website')).toHaveAttribute('aria-invalid', 'false');
    expect(view.queryByRole('alert')).toBeNull();

    await fireEvent.input(field('Website'), { target: { value: 'example.com' } });
    const input = field('Website');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveClass('bad');
    const alert = view.getByRole('alert');
    expect(alert).toHaveTextContent('Please enter a complete URL, e.g. https://example.com.');
    expect(input).toHaveAttribute('aria-describedby', alert.id);
    // On desktop below the row, not next to the field.
    expect(input.parentElement?.contains(alert)).toBe(false);

    await fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Save' }));
    expect(ui.toast).toMatchObject({ text: 'Please check the highlighted fields', error: false });
    expect(sections.scrollToSection.mock.calls.at(-1)?.[1]).toBe('firm');
    expect(bar()).not.toBeNull();
    await ui.toasts.flush();
    expect(view.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);

    await fireEvent.input(field('Website'), { target: { value: '' } });
    expect(view.queryByRole('alert')).toBeNull();
    expect(field('Website')).not.toHaveAttribute('aria-describedby');
  });

  it('fields on mobile without transition, the red ring applies in both layouts', () => {
    const rule = (selector: string) =>
      new RegExp(`^ {2}${selector.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} \\{([^}]*)\\}`, 'm').exec(SOURCE)?.[1] ?? '';
    expect(rule('.mobile input')).toMatch(/transition: none;/);
    expect(rule('input')).toMatch(/transition: box-shadow var\(--dur, 220ms\);/);
    expect(rule('input.bad')).toMatch(/box-shadow: 0 0 0 2px var\(--danger\);/);
  });

  it('shows a 422 from the server at the field until it is changed', async () => {
    const view = renderPage({
      'PUT admin/org': [{ status: 422, body: { error: 'validation', fields: { source: { code: 'too_long' } } } }],
    });
    await vi.waitFor(() => expect(field('Source code')).toHaveValue('https://github.com/example/mail'));
    await fireEvent.input(field('Source code'), { target: { value: 'https://codeberg.org/example/mail' } });
    await fireEvent.click(within(bar() as HTMLElement).getByRole('button', { name: 'Save' }));
    await ui.toasts.flush();
    await vi.waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent('The URL can’t be longer than 2048 characters.'),
    );
    expect(field('Source code')).toHaveAttribute('aria-invalid', 'true');
    expect(field('Source code')).toHaveValue('https://codeberg.org/example/mail');
    expect(bar()).not.toBeNull();
    expect(sections.scrollToSection.mock.calls.at(-1)?.[1]).toBe('source');
    await fireEvent.input(field('Source code'), { target: { value: 'https://codeberg.org/example' } });
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows heading, fields and the bar with two buttons on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = renderPage();
    expect(ui.isMobile).toBe(true);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Organization');
    expect(view.getByRole('button', { name: 'View page' })).toBeInTheDocument();
    expect(view.getByRole('heading', { level: 2, name: 'Support' })).toBeInTheDocument();
    await fireEvent.input(field('Support email'), { target: { value: 'help@example.com' } });
    const region = bar() as HTMLElement;
    expect(within(region).queryByText('Unsaved changes')).toBeNull();
    expect(
      within(region)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Discard', 'Save']);
    await fireEvent.click(within(region).getByRole('button', { name: 'Discard' }));
    expect(field('Support email')).toHaveValue('');

    // On mobile the field error sits directly below the field.
    await fireEvent.input(field('Support email'), { target: { value: 'help' } });
    const alert = view.getByRole('alert');
    expect(alert).toHaveTextContent('Please enter a valid email address.');
    expect(field('Support email').parentElement?.contains(alert)).toBe(true);
  });
});
