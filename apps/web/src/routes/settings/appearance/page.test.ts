import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

// The tabs scroll to the section; jsdom has no layout (`offsetParent`), hence only the call.
const scrollToSection = vi.hoisted(() => vi.fn());
vi.mock('#lib/sections.ts', () => ({ scrollToSection }));

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
const LOCKED = 'Set by your administrator';

function group(name: string) {
  return within(screen.getByRole('radiogroup', { name }));
}

function checked(name: string) {
  return group(name).getByRole('radio', { checked: true });
}

beforeEach(() => {
  session.config = CONFIG;
  ui.collapsed = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  scrollToSection.mockClear();
  session.config = null;
  ui.collapsed = false;
  ui.reset();
  prefs.reset();
  window.dispatchEvent(new Event('resize'));
});

describe('Appearance page', () => {
  it('shows header, tabs, sections and the defaults', () => {
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Appearance');
    expect(view.getByText('Customize how the app looks.')).toBeInTheDocument();
    const tabs = ['Color scheme', 'Accent color', 'Text & animation', 'Layout'];
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(tabs);
    for (const t of tabs) expect(view.getByRole('button', { name: t })).toBeInTheDocument();
    expect(view.getByText('Light, dark, or matching your system.')).toBeInTheDocument();
    expect(view.getByText('For icons, highlights, and selection.')).toBeInTheDocument();
    expect(view.queryByText(LOCKED)).toBeNull();

    expect(
      group('Color scheme')
        .getAllByRole('radio')
        .map((r) => r.textContent.trim()),
    ).toEqual(['Light', 'Dark', 'System']);
    expect(checked('Color scheme')).toHaveTextContent('Dark');
    expect(
      group('Accent color')
        .getAllByRole('radio')
        .map((r) => r.textContent.trim()),
    ).toEqual(['Apricot', 'Sage', 'Lavender', 'Sky', 'Rose']);
    expect(checked('Accent color')).toHaveTextContent('Apricot');
    expect(checked('Font size')).toHaveTextContent('Medium');
    expect(checked('Density')).toHaveTextContent('Normal');
    expect(checked('Sidebar')).toHaveTextContent('Expanded');
    expect(checked('Message list')).toHaveTextContent('Soft');
    expect(view.getByRole('switch', { name: 'Animations' })).toHaveAttribute('aria-checked', 'true');
    expect(view.getByText('Text size for better readability')).toBeInTheDocument();
    expect(view.getByText('Spacing in the interface')).toBeInTheDocument();
    expect(view.getByText('Springy transitions and floating elements')).toBeInTheDocument();
    expect(view.getByText('Width and behavior of the sidebar')).toBeInTheDocument();
    expect(view.getByText('How messages are shown in the mailbox')).toBeInTheDocument();
  });

  it('shows the preview of each mode in its fixed colours', () => {
    render(Page);
    const light = group('Color scheme').getByRole('radio', { name: 'Light' });
    expect(light.querySelector<HTMLElement>('.prev')?.style.background).toBe('rgb(243, 238, 231)');
    expect(light.querySelector<HTMLElement>('.prev-panel')?.style.background).toBe('rgb(255, 253, 250)');
    expect(group('Accent color').getByRole('radio', { name: 'Sky' }).style.getPropertyValue('--swatch')).toMatch(/^#/);
  });

  it('selects colour scheme and accent colour via prefs', async () => {
    render(Page);
    await fireEvent.click(group('Color scheme').getByRole('radio', { name: 'Light' }));
    expect(prefs.values.mode).toBe('light');
    expect(checked('Color scheme')).toHaveTextContent('Light');
    await fireEvent.click(group('Accent color').getByRole('radio', { name: 'Sky' }));
    expect(prefs.values.accent).toBe('sky');
    expect(checked('Accent color')).toHaveTextContent('Sky');
  });

  it('locks the accent colour when the branding sets it', async () => {
    session.config = { ...CONFIG, branding: { ...BRAND0, userAccent: false, color: 'rose' } };
    const view = render(Page);
    expect(view.getByText(LOCKED)).toBeInTheDocument();
    const accents = view.getByRole('radiogroup', { name: 'Accent color' });
    expect(accents).toHaveClass('locked');
    expect(accents).toHaveAttribute('aria-disabled', 'true');
    expect(checked('Accent color')).toHaveTextContent('Rose');
    const sky = within(accents).getByRole('radio', { name: 'Sky' });
    expect(sky).toBeDisabled();
    await fireEvent.click(sky);
    expect(prefs.values.accent).toBeNull();
    expect(checked('Accent color')).toHaveTextContent('Rose');
  });

  it('changes font size, density, message list and animations', async () => {
    const view = render(Page);
    await fireEvent.click(group('Font size').getByRole('radio', { name: 'Large' }));
    expect(prefs.values.fontSize).toBe('large');
    expect(checked('Font size')).toHaveTextContent('Large');
    await fireEvent.click(group('Density').getByRole('radio', { name: 'Compact' }));
    expect(prefs.values.density).toBe('compact');
    expect(checked('Density')).toHaveTextContent('Compact');
    await fireEvent.click(group('Message list').getByRole('radio', { name: 'Compact' }));
    expect(prefs.values.pfDesign).toBe('compact');
    expect(checked('Message list')).toHaveTextContent('Compact');
    const anim = view.getByRole('switch', { name: 'Animations' });
    await fireEvent.click(anim);
    expect(prefs.values.animations).toBe(false);
    expect(anim).toHaveAttribute('aria-checked', 'false');
    expect(anim).not.toHaveClass('on');
  });

  it('collapses and expands the sidebar via ui.collapsed', async () => {
    render(Page);
    await fireEvent.click(group('Sidebar').getByRole('radio', { name: 'Collapsed' }));
    expect(ui.collapsed).toBe(true);
    expect(checked('Sidebar')).toHaveTextContent('Collapsed');
    await fireEvent.click(group('Sidebar').getByRole('radio', { name: 'Expanded' }));
    expect(ui.collapsed).toBe(false);
  });

  it('shows "Density" in the layout section before sidebar and message list', () => {
    const view = render(Page);
    const rows = (sec: string) =>
      [...view.container.querySelectorAll(`[data-sec="${sec}"] .row-label`)].map((e) => e.textContent.trim());
    expect(rows('text')).toEqual(['Font size', 'Animations']);
    expect(rows('layout')).toEqual(['Density', 'Sidebar', 'Message list']);
    expect(view.container.querySelectorAll('[data-sec="layout"] .sep')).toHaveLength(2);

    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    view.unmount();
    const mobile = render(Page);
    const mRows = (sec: string) =>
      [...mobile.container.querySelectorAll(`[data-sec="${sec}"] .row-label`)].map((e) => e.textContent.trim());
    expect(mRows('text')).toEqual(['Font size', 'Animations']);
    expect(mRows('layout')).toEqual(['Density', 'Message list']);
    expect(mobile.container.querySelectorAll('[data-sec="layout"] .sep')).toHaveLength(1);
  });

  it('scrolls to the section via the tabs, instantly without animations', async () => {
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: 'Accent color' }));
    expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'accent', true);
    expect(view.container.querySelector('[data-sec="accent"]')).not.toBeNull();
    prefs.set({ animations: false });
    await fireEvent.click(view.getByRole('button', { name: 'Layout' }));
    expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'layout', false);
  });

  it('shows header and tabs but no sidebar on mobile', () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Appearance');
    expect(view.getByText('Customize how the app looks.')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Text & animation' })).toBeInTheDocument();
    expect(view.container.querySelector('.page')).toHaveClass('mobile');
    expect(group('Color scheme').getAllByRole('radio')).toHaveLength(3);
    expect(view.container.querySelector('.m-prev')).not.toBeNull();
    expect(view.container.querySelector('.prev')).toBeNull();
    expect(group('Accent color').getAllByRole('radio')).toHaveLength(5);
    expect(view.queryByRole('radiogroup', { name: 'Sidebar' })).toBeNull();
    expect(view.queryByText('Width and behavior of the sidebar')).toBeNull();
    expect(checked('Message list')).toHaveTextContent('Soft');
    expect(view.getByRole('switch', { name: 'Animations' })).toBeInTheDocument();
  });
});
