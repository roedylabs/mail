import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { licenses } from '#lib/licenses.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Org, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

// The tabs scroll to the section; jsdom has no layout (`offsetParent`), hence only the call.
const scrollToSection = vi.hoisted(() => vi.fn());
vi.mock('#lib/sections.ts', () => ({ scrollToSection }));

// Fixed device time zone, independent of the test run's environment.
vi.mock('#lib/state/prefs.svelte.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('#lib/state/prefs.svelte.ts')>();
  return { ...mod, browserTimeZone: () => 'Europe/Berlin' };
});

// Fixed build info instead of from Git and package.json.
vi.mock('#lib/build-info.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('#lib/build-info.ts')>();
  return { ...mod, buildInfo: { version: '0.6.0', sha: '7f3c2a1', date: new Date(2026, 9, 14, 12) } };
});

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
const ORG: Org = {
  name: 'Example Ltd',
  website: 'https://example.com',
  help: 'https://example.com/help',
  email: 'support@example.com',
  imprint: 'https://example.com/imprint',
  privacy: 'www.example.com/privacy/',
  terms: null,
  source: 'https://github.com/example/my-app',
};
const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: NO_ORG,
  banner: null,
  maintenance: { on: false, message: null },
  version: '0.6.0',
  update: null,
  setup_required: false,
  client_cache_version: 0,
};
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';
const LIBS = [
  ['Svelte', 'User interface', 'MIT', 'https://svelte.dev'],
  ['Tabler Icons', 'Icons', 'MIT', 'https://tabler.io/icons'],
  ['Nunito Sans', 'Font', 'OFL-1.1', 'https://fonts.google.com/specimen/Nunito+Sans'],
  ['Young Serif', 'Font', 'OFL-1.1', 'https://fonts.google.com/specimen/Young+Serif'],
  ['Rust/axum', 'Server', 'MIT/Apache-2.0', 'https://github.com/tokio-rs/axum'],
  ['SQLite', 'Database', 'Public Domain', 'https://sqlite.org'],
];

const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve());

/** Rows of a section as [label, subline, tag, address]. */
function links(container: HTMLElement, sec: string) {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>(`[data-sec="${sec}"] a.link`), (a) => [
    a.querySelector('.link-label')?.textContent,
    a.querySelector('.link-sub')?.textContent,
    a.querySelector('.tag')?.textContent ?? null,
    a.getAttribute('href'),
  ]);
}

function rows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.row'), (r) => [
    r.querySelector('.row-k')?.textContent,
    r.querySelector('.row-v')?.textContent,
  ]);
}

beforeEach(() => {
  session.config = CONFIG;
  // Own properties on the object shadow the getters of Navigator (jsdom has no clipboard).
  Object.defineProperty(navigator, 'userAgent', { value: FIREFOX, configurable: true });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'userAgent');
  Reflect.deleteProperty(navigator, 'clipboard');
  vi.unstubAllGlobals();
  writeText.mockReset();
  writeText.mockImplementation(() => Promise.resolve());
  scrollToSection.mockClear();
  session.config = null;
  licenses.reset();
  ui.reset();
  prefs.reset();
  window.dispatchEvent(new Event('resize'));
});

describe('About page', () => {
  it('shows the chip according to `public/config` › `update`', () => {
    session.config = { ...CONFIG, update: { available: false, latest: '0.6.0' } };
    const current = render(Page);
    expect(current.container.querySelector('.hero .chip')).toHaveTextContent('Up to date');
    current.unmount();

    session.config = { ...CONFIG, update: { available: true, latest: '0.7.0' } };
    const found = render(Page);
    expect(found.container.querySelector('.hero .chip')).toHaveTextContent('Update to 0.7.0 available');
  });

  it('shows the chip below the version on mobile', () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    session.config = { ...CONFIG, update: { available: true, latest: '0.7.0' } };
    const view = render(Page);
    expect(view.container.querySelector('.m-chip .chip')).toHaveTextContent('Update to 0.7.0 available');
  });

  it('shows version and licences without an organization', () => {
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('About');
    expect(view.getByText('Version, support, legal, and licenses.')).toBeInTheDocument();
    const tabs = ['Version', 'Licenses'];
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(tabs);
    expect(
      within(view.container.querySelector<HTMLElement>('.tabs')!)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(tabs);
    expect(view.container.querySelector('[data-sec="support"]')).toBeNull();
    expect(view.container.querySelector('[data-sec="legal"]')).toBeNull();

    expect(view.getByText('Installed version of this app.')).toBeInTheDocument();
    expect(view.container.querySelector('.app-name')).toHaveTextContent('Roedy Mail');
    expect(view.container.querySelector('.logo-tile .logo')).not.toBeNull();
    expect(view.getByText('Version 0.6.0')).toBeInTheDocument();
    expect(view.queryByText(/Provided by/)).toBeNull();
    // Without `update` from `public/config` (state unknown) no chip.
    expect(view.container.querySelector('.chip')).toBeNull();
    expect(rows(view.container)).toEqual([
      ['Version', '0.6.0'],
      ['Build', '7f3c2a1'],
      ['Released', '14.10.2026'],
      ['Browser', 'Firefox'],
    ]);
    expect(view.container.querySelectorAll('.box .sep')).toHaveLength(4);
    expect(view.getByText('System information')).toBeInTheDocument();
    expect(view.getByText('Copy for support requests')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    expect(view.getByText('Open-source software used.')).toBeInTheDocument();
    expect(links(view.container, 'licenses')).toEqual(LIBS.map(([name, role, lic, href]) => [name, role, lic, href]));
    for (const a of view.container.querySelectorAll('a.link')) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('uses the date format of the settings for "Released"', () => {
    prefs.set({ dateFmt: 'iso' });
    const view = render(Page);
    expect(rows(view.container)[2]).toEqual(['Released', '2026-10-14']);
  });

  it('shows support, legal, source code and "Provided by" with link with an organization', () => {
    session.config = { ...CONFIG, org: ORG };
    const view = render(Page);
    const tabs = ['Version', 'Support', 'Legal', 'Licenses'];
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(tabs);
    for (const t of tabs) expect(view.getAllByRole('button', { name: t })).toHaveLength(1);

    const org = view.container.querySelector('.org');
    expect(org).toHaveTextContent('Provided by Example Ltd');
    const site = view.getByRole('link', { name: 'Example Ltd' });
    expect(site).toHaveAttribute('href', 'https://example.com/');
    expect(site).toHaveAttribute('target', '_blank');
    expect(site).toHaveAttribute('rel', 'noopener noreferrer');

    expect(view.getByText('Help with questions and problems.')).toBeInTheDocument();
    expect(links(view.container, 'support')).toEqual([
      ['Help center', 'example.com/help', null, 'https://example.com/help'],
      ['Contact support', 'support@example.com', null, 'mailto:support@example.com'],
    ]);
    expect(view.getByText('Provider and privacy information.')).toBeInTheDocument();
    expect(links(view.container, 'legal')).toEqual([
      ['Legal notice', 'example.com/imprint', null, 'https://example.com/imprint'],
      ['Privacy policy', 'example.com/privacy', null, 'https://www.example.com/privacy/'],
    ]);
    const lic = links(view.container, 'licenses');
    expect(lic).toHaveLength(7);
    expect(lic[0]).toEqual(['Source code', 'github.com/example/my-app', null, 'https://github.com/example/my-app']);
    for (const a of view.container.querySelectorAll('a')) {
      expect(a).toHaveAttribute('target', '_blank');
      expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('shows the name of the organization without a website without a link', () => {
    session.config = { ...CONFIG, org: { ...NO_ORG, name: 'Example Ltd' } };
    const view = render(Page);
    expect(view.container.querySelector('.org')).toHaveTextContent('Provided by Example Ltd');
    expect(view.queryByRole('link', { name: 'Example Ltd' })).toBeNull();
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Version', 'Licenses']);
  });

  it('copies the system information and reports it', async () => {
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('System information copied'));
    expect(writeText).toHaveBeenCalledWith(
      'Roedy Mail 0.6.0 (Build 7f3c2a1)\nBrowser: Firefox\nTime zone: Europe/Berlin',
    );
  });

  it('reports nothing when copying fails', async () => {
    writeText.mockImplementation(() => Promise.reject(new Error('no')));
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    await Promise.resolve();
    expect(ui.toast).toBeNull();
  });

  it('scrolls to the section via the tabs, instantly without animations', async () => {
    session.config = { ...CONFIG, org: ORG };
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: 'Legal' }));
    expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'legal', true);
    expect(view.container.querySelector('[data-sec="legal"]')).not.toBeNull();
    prefs.set({ animations: false });
    await fireEvent.click(view.getByRole('button', { name: 'Licenses' }));
    expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'licenses', false);
    await fireEvent.click(view.getByRole('button', { name: 'Support' }));
    expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'support', false);
    await fireEvent.click(view.getByRole('button', { name: 'Version' }));
    expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'version', false);
  });

  it('opens the licences dialog in the layout via "All licenses" and loads the list', async () => {
    const file = {
      version: 1,
      generated: '2026-11-12T00:00:00.000Z',
      packages: [{ name: 'svelte', version: '5.40.0', license: 'MIT', origin: 'web', texts: [0] }],
      texts: ['MIT License …'],
    };
    const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(file))));
    vi.stubGlobal('fetch', fetch);
    const view = render(Page);
    const row = view.getByRole('button', { name: /^All licenses/ });
    expect(row).toHaveAttribute('aria-haspopup', 'dialog');
    expect(row).toHaveTextContent('Web app and server, with license texts');
    // Last row below the main components.
    expect(view.container.querySelector('[data-sec="licenses"] .links')?.lastElementChild).toBe(row);
    expect(ui.pageDialog?.()).toBeNull();

    await fireEvent.click(row);
    expect(ui.pageDialog?.()?.title).toBe('All licenses');
    expect(fetch).toHaveBeenCalledWith('/licenses.json', expect.anything());
    ui.pageDialog?.()?.close();
    expect(ui.pageDialog?.()).toBeNull();

    view.unmount();
    expect(ui.pageDialog).toBeNull();
  });

  it('shows header, tabs and the short description of the system information on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    session.config = { ...CONFIG, org: ORG };
    const view = render(Page);
    expect(view.container.querySelector('.page')).toHaveClass('mobile');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('About');
    expect(view.getByText('Version, support, legal, and licenses.')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Support' })).toBeInTheDocument();
    expect(view.getByText('Version 0.6.0')).toBeInTheDocument();
    expect(view.container.querySelector('.m-org .org')).toHaveTextContent('Provided by Example Ltd');
    expect(view.container.querySelector('.m-chip')).toBeEmptyDOMElement();
    expect(view.getByText('For support')).toBeInTheDocument();
    expect(view.queryByText('Copy for support requests')).toBeNull();
    expect(rows(view.container)).toHaveLength(4);
    expect(links(view.container, 'licenses')).toHaveLength(7);
    expect(screen.getAllByRole('link')).toHaveLength(12);

    await fireEvent.click(view.getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('System information copied'));
  });
});
