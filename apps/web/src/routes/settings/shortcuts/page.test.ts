import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session, type Me } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

const ME: Me = {
  id: 'u0',
  username: 'jane',
  email: 'jane@example.com',
  display_name: 'Jane Doe',
  role: 'admin',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: '2026-10-20T12:00:00Z',
  email_change: null,
};

const GROUPS = [
  ['General', 'keyboard'],
  ['Navigation', 'compass'],
  ['Message list', 'list'],
  ['Reading messages', 'mail-opened'],
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  session.user = null;
  prefs.reset();
  ui.reset();
  window.dispatchEvent(new Event('resize'));
});

/** Section of a group (`data-sec`). */
function section(container: HTMLElement, sec: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-sec="${sec}"]`);
  if (!el) throw new Error(`Section ${sec} missing`);
  return el;
}

/** Keys of a shortcut in its row. */
function keysOf(container: HTMLElement, text: string): string[] {
  const row = within(container).getByText(text).closest('.row');
  return [...(row?.querySelectorAll('kbd') ?? [])].map((k) => k.textContent);
}

describe('Shortcuts page', () => {
  it('shows four groups with heading, icon and shortcuts', () => {
    session.user = ME;
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Keyboard shortcuts');
    expect(view.getByText('Overview of keyboard commands.')).toBeInTheDocument();
    expect(view.container.querySelector('.page')).not.toHaveClass('mobile');
    const headings = view.getAllByRole('heading', { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(GROUPS.map(([label]) => label));
    GROUPS.forEach(([, icon], i) => {
      expect(headings[i]?.querySelector('svg')).toHaveClass(`tabler-icon-${icon}`);
      expect(section(view.container, `sc${String(i)}`)).toContainElement(headings[i] ?? null);
    });
    expect(section(view.container, 'sc0').querySelectorAll('.row')).toHaveLength(6);
    expect(section(view.container, 'sc1').querySelectorAll('.row')).toHaveLength(8);
    expect(section(view.container, 'sc2').querySelectorAll('.row')).toHaveLength(2);
    expect(section(view.container, 'sc3').querySelectorAll('.row')).toHaveLength(5);
    expect(keysOf(view.container, 'Search')).toEqual(['/']);
    expect(keysOf(view.container, 'Manage mail servers')).toEqual(['⇧', 'M']);
    expect(keysOf(view.container, 'Move through the list')).toEqual(['↑', '↓']);
    expect(keysOf(view.container, 'Open message')).toEqual(['Enter']);
    expect(keysOf(view.container, 'Close message')).toEqual(['Esc']);
  });

  it('shows no "Manage mail servers" without admin rights', () => {
    session.user = { ...ME, role: 'user' };
    const view = render(Page);
    expect(view.queryByText('Manage mail servers')).toBeNull();
    expect(section(view.container, 'sc1').querySelectorAll('.row')).toHaveLength(7);
  });

  it('shows the modifier key per system: ⌘ on Apple systems, otherwise Ctrl', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    const mac = render(Page);
    expect(keysOf(mac.container, 'Open command palette')).toEqual(['⌘', 'K']);
    mac.unmount();
    vi.stubGlobal('navigator', { platform: 'Win32' });
    const win = render(Page);
    expect(keysOf(win.container, 'Open command palette')).toEqual(['Ctrl', 'K']);
  });

  it('scrolls to the group via the tabs', async () => {
    const view = render(Page);
    const tabs = view.getAllByRole('button');
    expect(tabs.map((t) => t.textContent)).toEqual(GROUPS.map(([label]) => label));
    // jsdom computes no layout: preset the container and the position of the section.
    const container = view.container.querySelector<HTMLElement>('.page')!;
    const scrollTo = vi.fn();
    container.scrollTo = scrollTo;
    const target = section(view.container, 'sc2');
    Object.defineProperty(target, 'offsetParent', { configurable: true, get: () => container });
    Object.defineProperty(target, 'offsetTop', { configurable: true, get: () => 500 });
    await fireEvent.click(view.getByRole('button', { name: 'Message list' }));
    expect(scrollTo).toHaveBeenCalledWith({
      top: 476,
      behavior: prefs.values.animations ? 'smooth' : 'auto',
    });
  });

  it('shows title, tabs and groups on mobile', () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = render(Page);
    expect(view.container.querySelector('.page')).toHaveClass('mobile');
    expect(view.getByRole('heading', { level: 1 })).toHaveClass('m-title');
    expect(view.container.querySelector('.tabs')).toHaveClass('no-scrollbar');
    expect(view.getAllByRole('heading', { level: 2 })).toHaveLength(4);
    expect(keysOf(view.container, 'Reply')).toEqual(['R']);
  });
});
