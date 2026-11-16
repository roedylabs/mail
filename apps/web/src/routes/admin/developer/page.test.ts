import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tooltips } from '#lib/actions/tooltip.ts';
import { LOG_ROWS } from '#lib/developer.ts';
import { devLog } from '#lib/state/devlog.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

const nav = vi.hoisted(() => ({
  goto: vi.fn(() => Promise.resolve()),
  page: { url: new URL('http://localhost/admin/developer') },
  logout: vi.fn(() => Promise.resolve()),
  scrollToSection: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
vi.mock('$app/state', () => ({ page: nav.page }));
vi.mock('#lib/logout.ts', () => ({ logout: nav.logout }));
vi.mock('#lib/sections.ts', () => ({ scrollToSection: nav.scrollToSection }));

function mobile(): void {
  vi.stubGlobal('innerWidth', 390);
  window.dispatchEvent(new Event('resize'));
}

/** Browser clipboard; `navigator` otherwise stays unchanged (the environment reads `userAgent`). */
function clipboard() {
  const writeText = vi.fn((text: string) => Promise.resolve(void text));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

const section = (name: string) => screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement;
const log = () => screen.getByRole('log', { name: 'Log' });
const debugSwitch = () => screen.getByRole('switch', { name: 'Debug mode' });
const offlineSwitch = () => screen.getByRole('switch', { name: 'Simulate offline' });
const levels = () => within(screen.getByRole('group', { name: 'Log level' }));
const logMsgs = () => [...log().querySelectorAll('.log-msg')].map((e) => e.textContent);
const trigger = () => within(section('Test')).getAllByRole('button', { name: 'Trigger' });
const envValue = (key: string) =>
  within(section('Environment')).getByText(key).closest('.env-row')?.querySelector('.env-value')?.textContent;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'clipboard');
  nav.goto.mockClear();
  nav.logout.mockClear();
  nav.scrollToSection.mockClear();
  ui.toasts.discard();
  ui.confirmCancel();
  ui.reset();
  prefs.reset();
  network.simulate(false);
  devLog.clear();
  window.dispatchEvent(new Event('resize'));
});

describe('Administration › Developer page', () => {
  it('shows header, tabs and all sections with their texts', () => {
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveClass('title');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Developer');
    expect(view.getByText('Debug options and logs.')).toHaveClass('lead');
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Diagnostics',
      'Log',
      'Test',
      'Environment',
    ]);
    expect([...view.container.querySelectorAll('.tab')].map((t) => t.textContent)).toEqual([
      'Diagnostics',
      'Log',
      'Test',
      'Environment',
    ]);

    const diag = within(section('Diagnostics'));
    expect(diag.getByText('Tools for troubleshooting.')).toBeInTheDocument();
    expect(diag.getByText('Shows layout, screen size, and view in the bottom left')).toBeInTheDocument();
    expect(diag.getByText('Which entries appear in the log')).toBeInTheDocument();

    expect(within(section('Log')).getByText('Events in this session, newest first.')).toBeInTheDocument();

    const test = within(section('Test'));
    expect(test.getByText('Trigger specific app states.')).toBeInTheDocument();
    expect(test.getByText('Preview the pages for errors and lost connection')).toBeInTheDocument();
    expect(test.getByText('The app behaves as if there were no connection')).toBeInTheDocument();
    expect(test.getByText('Show the notice after a long period of inactivity')).toBeInTheDocument();
    expect(test.getByText('Writes a test entry at the error level')).toBeInTheDocument();

    expect(within(section('Environment')).getByText('Details for bug reports.')).toBeInTheDocument();
  });

  it('scrolls to the section with the tabs', async () => {
    const view = render(Page);
    const root = view.container.querySelector('.page');
    const tabs = [...view.container.querySelectorAll('.tab')];
    for (const tab of tabs) await fireEvent.click(tab);
    expect(nav.scrollToSection.mock.calls).toEqual(
      ['diag', 'log', 'test', 'env'].map((key) => [root, key, prefs.values.animations]),
    );
    for (const key of ['diag', 'log', 'test', 'env']) {
      expect(view.container.querySelector(`section[data-sec="${key}"]`)).toBeInTheDocument();
    }
  });

  it('writes the debug mode to the settings', async () => {
    render(Page);
    expect(debugSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(debugSwitch()).not.toHaveClass('on');

    await fireEvent.click(debugSwitch());
    expect(prefs.values.devDebug).toBe(true);
    expect(debugSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(debugSwitch()).toHaveClass('on');

    await fireEvent.click(debugSwitch());
    expect(prefs.values.devDebug).toBe(false);
    expect(debugSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('selects the log level', async () => {
    render(Page);
    const state = () =>
      levels()
        .getAllByRole('button')
        .map((b) => [b.textContent, b.getAttribute('aria-pressed'), b.classList.contains('on')]);
    expect(state()).toEqual([
      ['Error', 'false', false],
      ['Warning', 'false', false],
      ['Info', 'true', true],
      ['Debug', 'false', false],
    ]);

    await fireEvent.click(levels().getByRole('button', { name: 'Error' }));
    expect(prefs.values.devLevel).toBe('error');
    expect(state()).toEqual([
      ['Error', 'true', true],
      ['Warning', 'false', false],
      ['Info', 'false', false],
      ['Debug', 'false', false],
    ]);
  });

  it('shows the log with time, level and colour, newest first', () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 6, 14, 5, 9), toFake: ['Date'] });
    devLog.add('info', 'First message');
    devLog.add('error', 'Second message');
    render(Page);
    expect(log()).toHaveClass('no-scrollbar');
    const rows = [...log().querySelectorAll<HTMLElement>('.log-row')];
    expect(rows.map((r) => r.querySelector('.log-time')?.textContent)).toEqual(['14:05:09', '14:05:09']);
    expect(rows.map((r) => r.querySelector('.log-level')?.textContent)).toEqual(['Error', 'Info']);
    expect(logMsgs()).toEqual(['Second message', 'First message']);
    expect(rows[0]?.querySelector('.log-level')).toHaveAttribute('style', expect.stringContaining('var(--danger)'));
    expect(rows[1]?.querySelector('.log-level')).toHaveAttribute('style', expect.stringContaining('var(--fg)'));
    expect(within(log()).queryByText('No entries for this level')).toBeNull();
  });

  it('filters rows and counter by level and shows the empty state', async () => {
    devLog.add('debug', 'Detail');
    devLog.add('warning', 'Warning note');
    devLog.add('info', 'Information');
    render(Page);
    const count = within(section('Log'));
    expect(logMsgs()).toEqual(['Information', 'Warning note']);
    expect(count.getByText('2 entries in this session')).toHaveClass('log-count');

    await fireEvent.click(levels().getByRole('button', { name: 'Debug' }));
    expect(logMsgs()).toEqual(['Information', 'Warning note', 'Detail']);
    expect(count.getByText('3 entries in this session')).toBeInTheDocument();

    await fireEvent.click(levels().getByRole('button', { name: 'Warning' }));
    expect(logMsgs()).toEqual(['Warning note']);
    expect(count.getByText('1 entry in this session')).toBeInTheDocument();

    await fireEvent.click(levels().getByRole('button', { name: 'Error' }));
    expect(logMsgs()).toEqual([]);
    expect(count.getByText('0 entries in this session')).toBeInTheDocument();
    expect(within(log()).getByText('No entries for this level')).toBeInTheDocument();
  });

  it('shows at most LOG_ROWS rows but counts all', () => {
    for (let i = 0; i < LOG_ROWS + 5; i++) devLog.add('info', `Message ${i}`);
    render(Page);
    expect(logMsgs()).toHaveLength(LOG_ROWS);
    expect(within(section('Log')).getByText(`${LOG_ROWS + 5} entries in this session`)).toBeInTheDocument();
  });

  it('copies the visible entries and clears the log', async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 6, 14, 5, 9), toFake: ['Date'] });
    const writeText = clipboard();
    devLog.add('debug', 'Detail');
    devLog.add('error', 'Crash');
    render(Page);
    const box = within(section('Log'));

    await fireEvent.click(box.getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Log copied'));
    expect(writeText).toHaveBeenCalledWith('14:05:09 [Error] Crash');

    await fireEvent.click(box.getByRole('button', { name: 'Clear' }));
    expect(devLog.entries).toEqual([]);
    expect(logMsgs()).toEqual([]);
    expect(within(log()).getByText('No entries for this level')).toBeInTheDocument();

    writeText.mockClear();
    await fireEvent.click(box.getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('(empty)'));
  });

  it('opens the error pages with tooltip and label', async () => {
    render(Page);
    const test = within(section('Test'));
    const buttons = [
      ['Not found', '404', '/error/404'],
      ['Access denied', '403', '/error/403'],
      ['Server error', '500', '/error/500'],
      ['No connection', 'Offline', '/error/offline'],
    ] as const;
    for (const [label, code, path] of buttons) {
      const button = test.getByRole('button', { name: label });
      expect(button).toHaveTextContent(new RegExp(`^${code}$`));
      expect(tooltips.targets.get(button)?.text).toBe(label);
      nav.goto.mockClear();
      await fireEvent.click(button);
      expect(nav.goto).toHaveBeenCalledWith(path);
    }
  });

  it('simulates the missing connection and records it in the log', async () => {
    render(Page);
    expect(offlineSwitch()).toHaveAttribute('aria-checked', 'false');

    await fireEvent.click(offlineSwitch());
    expect(network.simulated).toBe(true);
    expect(offlineSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(offlineSwitch()).toHaveClass('on');
    expect(logMsgs()).toEqual(['Offline simulation started']);

    await fireEvent.click(offlineSwitch());
    expect(network.simulated).toBe(false);
    expect(offlineSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(logMsgs()).toEqual(['Offline simulation ended', 'Offline simulation started']);
  });

  it('asks about the session expiry and signs out', async () => {
    render(Page);
    const [expire] = trigger();
    await fireEvent.click(expire as HTMLElement);
    expect(ui.confirm).toMatchObject({
      force: true,
      noCancel: true,
      title: 'Session expired',
      text: 'You were inactive for a while. Sign in again to continue.',
      icon: 'ti-clock-off',
      ok: 'Sign in again',
    });
    expect(nav.logout).not.toHaveBeenCalled();
    ui.confirm?.run();
    expect(nav.logout).toHaveBeenCalledOnce();
  });

  it('writes a test error to the log', async () => {
    render(Page);
    const [, error] = trigger();
    await fireEvent.click(error as HTMLElement);
    // The toast also ends up in the log as a notice of level info.
    expect(logMsgs()).toEqual(['Notice: Error logged', 'Test error: unhandled exception']);
    expect([...log().querySelectorAll('.log-level')].map((e) => e.textContent)).toEqual(['Info', 'Error']);
    expect(ui.toast?.text).toBe('Error logged');
  });

  it('shows the environment with dividers and copies it', async () => {
    const writeText = clipboard();
    render(Page);
    const env = section('Environment');
    expect([...env.querySelectorAll('.env-key')].map((e) => e.textContent)).toEqual([
      'Version',
      'Layout',
      'Screen',
      'View',
      'Browser',
      'Time zone',
      'Language',
    ]);
    expect(envValue('Version')).toMatch(/ · Build /);
    expect(envValue('Layout')).toBe('Desktop');
    expect(envValue('Screen')).toMatch(/^\d+ × \d+ px$/);
    expect(envValue('View')).toBe('/admin/developer');
    expect(envValue('Language')).toBe('EN · United Kingdom');
    expect(env.querySelectorAll('.sep')).toHaveLength(7);

    await fireEvent.click(within(env).getByRole('button', { name: 'Copy' }));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Environment copied'));
    const text = writeText.mock.calls[0]?.[0] ?? '';
    expect(text.split('\n')[0]).toBe(session.appName);
    expect(text).toContain('View: /admin/developer');
    expect(text).toContain('Language: EN · United Kingdom');
  });

  it('uses its own header, the short descriptions and two-line error pages on mobile', async () => {
    mobile();
    devLog.add('warning', 'Warning note');
    const view = render(Page);
    expect(view.container.querySelector('.page')).toHaveClass('mobile');
    expect(view.getByRole('heading', { level: 1 })).toHaveClass('m-title');
    expect(view.getByText('Debug options and logs.')).toHaveClass('m-lead');

    expect(within(section('Diagnostics')).getByText('Show layout and view')).toBeInTheDocument();

    // On mobile the counter sits below the heading instead of in the list's header row.
    const logBox = within(section('Log'));
    expect(logBox.queryByText('Events in this session, newest first.')).toBeNull();
    expect(logBox.getByText('1 entry in this session')).toHaveClass('sec-desc');
    expect(view.container.querySelector('.log-count')).toBeNull();
    expect(logMsgs()).toEqual(['Warning note']);

    const test = within(section('Test'));
    expect(test.getByText('Preview the error pages')).toBeInTheDocument();
    expect(test.getByText('Behaves as if offline')).toBeInTheDocument();
    expect(test.getByText('Show the notice after inactivity')).toBeInTheDocument();
    expect(test.getByText('Test entry at the error level')).toBeInTheDocument();

    const error = test.getByRole('button', { name: /^404/ });
    expect(error).not.toHaveAttribute('aria-label');
    expect(error.querySelector('.err-code')).toHaveTextContent('404');
    expect(error.querySelector('.err-label')).toHaveTextContent('Not found');
    expect(tooltips.targets.get(error)?.text).toBeUndefined();
    await fireEvent.click(error);
    expect(nav.goto).toHaveBeenCalledWith('/error/404');

    // On mobile there is no divider before "Copy".
    expect(section('Environment').querySelectorAll('.sep')).toHaveLength(6);
    expect(within(section('Environment')).getByText('Layout').closest('.env-row')).toHaveTextContent('Narrow');
  });

  it('shows no mobile texts on desktop', () => {
    render(Page);
    expect(screen.queryByText('Show layout and view')).toBeNull();
    expect(screen.queryByText('Preview the error pages')).toBeNull();
    expect(screen.queryByText('Behaves as if offline')).toBeNull();
    expect(screen.queryByText('Show the notice after inactivity')).toBeNull();
    expect(screen.queryByText('Test entry at the error level')).toBeNull();
    expect(screen.queryByText('Not found')).toBeNull();
  });
});
