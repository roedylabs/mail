import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

// The tabs scroll to the section; jsdom has no layout (`offsetParent`), hence only the call.
const scrollToSection = vi.hoisted(() => vi.fn());
vi.mock('#lib/sections.ts', () => ({ scrollToSection }));

// Fixed device time zone, independent of the test run's environment.
const device = vi.hoisted(() => ({ tz: 'Europe/Berlin' }));
vi.mock('#lib/state/prefs.svelte.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('#lib/state/prefs.svelte.ts')>();
  return { ...mod, browserTimeZone: () => device.tz };
});

/** 1 November 2026, 10:00 UTC – 11:00 CET in Berlin. */
const NOW = Date.UTC(2026, 10, 1, 10, 0);
const REGIONS = [
  'Germany',
  'Austria',
  'Switzerland',
  'France',
  'Italy',
  'Netherlands',
  'Spain',
  'United Kingdom',
  'United States',
];
const NBSP = ' ';

function group(name: string) {
  return within(screen.getByRole('radiogroup', { name }));
}

function checked(name: string) {
  return group(name).getByRole('radio', { checked: true });
}

function preview(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.pv'), (p) => [
    p.querySelector('.pv-k')?.textContent,
    p.querySelector('.pv-v')?.textContent,
  ]);
}

function hiLabel(list: HTMLElement) {
  return list.querySelector('.opt.hi .opt-label')?.textContent;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  device.tz = 'Europe/Berlin';
  // Most cases describe a user in Germany; the defaults have their own case.
  prefs.set({ region: 'DE', numFmt: '1.234,56' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  scrollToSection.mockClear();
  ui.reset();
  prefs.reset();
  window.dispatchEvent(new Event('resize'));
});

describe('Language & region page', () => {
  it('shows header, tabs, sections and the defaults', () => {
    prefs.reset();
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Language & region');
    expect(view.getByText('Language, date, and time format.')).toBeInTheDocument();
    const tabs = ['Language', 'Region', 'Formats'];
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(tabs);
    for (const t of tabs) expect(view.getByRole('button', { name: t })).toBeInTheDocument();
    expect(view.getByText('Language of the interface.')).toBeInTheDocument();
    expect(view.getByText('Country and time zone.')).toBeInTheDocument();
    expect(view.getByText('How dates, times, and numbers are shown.')).toBeInTheDocument();

    expect(
      group('Language')
        .getAllByRole('radio')
        .map((r) => r.textContent.trim()),
    ).toEqual(['System Browser: English', 'DE Deutsch German', 'EN English']);
    expect(checked('Language')).toHaveTextContent('English');
    expect(view.queryByText(/use the language of your last sign-in/)).toBeNull();
    expect(checked('Language')).toHaveClass('on');

    // Name from the row label and the visible value (WCAG 2.5.3).
    const region = view.getByRole('combobox', { name: 'Country or region United Kingdom' });
    expect(region).toHaveTextContent('United Kingdom');
    expect(region).toHaveAttribute('role', 'combobox');
    expect(region).toHaveAttribute('aria-expanded', 'false');
    expect(region).toHaveAttribute('aria-disabled', 'false');
    expect(view.getByText('For holidays and currency')).toBeInTheDocument();
    expect(view.getByRole('switch', { name: 'Set time zone automatically' })).toHaveAttribute('aria-checked', 'true');
    expect(view.getByText('Based on your device settings')).toBeInTheDocument();
    expect(view.getByRole('combobox', { name: 'Time zone Berlin, Vienna, Zurich (CET)' })).toHaveTextContent(
      'Berlin, Vienna, Zurich (CET)',
    );
    expect(view.getByText('For times and events')).toBeInTheDocument();
    expect(view.queryByRole('listbox')).toBeNull();

    expect(preview(view.container)).toEqual([
      ['Date', '01.11.2026'],
      ['Time', '11:00'],
      ['Number', '12,345.67'],
    ]);
    expect(
      group('Date format')
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['01.11.2026', '2026-11-01', '11/01/2026']);
    expect(checked('Date format')).toHaveTextContent('01.11.2026');
    expect(checked('Time format')).toHaveTextContent('24-hour');
    expect(checked('Week starts on')).toHaveTextContent('Monday');
    expect(
      group('Number format')
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['1.234,56', '1,234.56', `1${NBSP}234,56`]);
    expect(checked('Number format')).toHaveTextContent('1,234.56');
    expect(view.getByText('Short date in lists and tables')).toBeInTheDocument();
    expect(view.getByText('Times throughout the app')).toBeInTheDocument();
    expect(view.getByText('For calendars and date pickers')).toBeInTheDocument();
    expect(view.getByText('Thousands and decimal separators')).toBeInTheDocument();
  });

  it('selects German: saves `lang`, the page switches the language at once', async () => {
    const german = { locale: 'de' } as const;
    const view = render(Page);
    const de = group('Language').getByRole('radio', { name: /Deutsch/ });
    expect(de).toHaveAttribute('aria-checked', 'false');
    expect(de).not.toHaveAttribute('aria-disabled');
    expect(de.querySelector('.lang-name')).toHaveAttribute('lang', 'de');
    await fireEvent.click(de);
    expect(prefs.values.lang).toBe('de');
    // The page header follows too (`pageOf` in `$derived`).
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent(m.nav_language({}, german));
    const languages = group(m.region_tab_lang({}, german));
    expect(checked(m.region_tab_lang({}, german))).toHaveTextContent('Deutsch');
    expect(languages.getAllByRole('radio')).toHaveLength(3);
    expect(
      view.getByRole('combobox', { name: new RegExp(`^${m.region_country_title({}, german)} `) }),
    ).toBeInTheDocument();
    expect(view.getByRole('combobox', { name: new RegExp(`^${m.region_tz_title({}, german)} `) })).toBeInTheDocument();
    await fireEvent.click(languages.getByRole('radio', { name: /^EN / }));
    expect(prefs.values.lang).toBe('en');
    expect(checked('Language')).toHaveTextContent('English');
  });

  it('selects "System": only its card is checked, the browser\'s language live and the note on mails', async () => {
    const languages = vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en-US']);
    window.dispatchEvent(new Event('languagechange'));
    try {
      const view = render(Page);
      const system = group('Language').getByRole('radio', { name: 'System Browser: English' });
      expect(group('Language').getAllByRole('radio')[0]).toBe(system);
      expect(system.querySelector('.tile .tabler-icon-world')).not.toBeNull();
      expect(system.querySelector('.lang-name')).not.toHaveAttribute('lang');
      await fireEvent.click(system);
      expect(prefs.values.lang).toBe('system');
      expect(group('Language').getAllByRole('radio', { checked: true })).toEqual([system]);
      expect(view.getByText('Emails from Roedy Mail use the language of your last sign-in.')).toBeInTheDocument();
      // A new browser language applies at once: the interface and the second line follow.
      languages.mockReturnValue(['de-DE']);
      window.dispatchEvent(new Event('languagechange'));
      await tick();
      const german = { locale: 'de' } as const;
      const cards = group(m.region_tab_lang({}, german)).getAllByRole('radio');
      expect(cards.map((r) => r.textContent.trim())).toEqual([
        'System Browser: Deutsch',
        'DE Deutsch',
        'EN English Englisch',
      ]);
      expect(cards.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
      expect(view.getByText(m.region_lang_system_mail({ app: 'Roedy Mail' }, german))).toBeInTheDocument();
    } finally {
      languages.mockRestore();
      window.dispatchEvent(new Event('languagechange'));
    }
  });

  it('selects country or region in the popover with the mouse', async () => {
    const view = render(Page);
    const btn = view.getByRole('combobox', { name: /^Country or region / });
    await fireEvent.click(btn);
    expect(ui.menu).toBe('pick');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).toHaveClass('open');
    const list = view.getByRole('listbox', { name: 'Country or region' });
    expect(list.closest('[data-pop]')).not.toBeNull();
    const opts = within(list).getAllByRole('option');
    expect(opts.map((o) => o.textContent.trim())).toEqual(REGIONS);
    expect(within(list).getByRole('option', { selected: true })).toHaveTextContent('Germany');
    expect(opts[0]).toHaveClass('on');
    expect(hiLabel(list)).toBe('Germany');
    await fireEvent.mouseMove(opts[2]!);
    expect(hiLabel(list)).toBe('Switzerland');
    expect(opts[0]).not.toHaveClass('hi');
    await fireEvent.click(opts[2]!);
    expect(prefs.values.region).toBe('CH');
    expect(ui.menu).toBeNull();
    expect(view.queryByRole('listbox')).toBeNull();
    expect(btn).toHaveTextContent('Switzerland');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    // A second click on the button closes the open list again.
    await fireEvent.click(btn);
    expect(view.getByRole('listbox')).toBeInTheDocument();
    await fireEvent.click(btn);
    expect(view.queryByRole('listbox')).toBeNull();
  });

  it('operates country or region with arrow keys, Enter, Space and Tab', async () => {
    const view = render(Page);
    const btn = view.getByRole('combobox', { name: /^Country or region / });
    await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    const list = view.getByRole('listbox', { name: 'Country or region' });
    expect(hiLabel(list)).toBe('Germany');
    await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(hiLabel(list)).toBe('Austria');
    await fireEvent.keyDown(btn, { key: 'ArrowUp' });
    await fireEvent.keyDown(btn, { key: 'ArrowUp' });
    expect(hiLabel(list)).toBe('United States');
    await fireEvent.keyDown(btn, { key: 'Enter' });
    expect(prefs.values.region).toBe('US');
    expect(view.queryByRole('listbox')).toBeNull();

    // The list opens on the selected row; Space selects on release.
    await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(hiLabel(view.getByRole('listbox'))).toBe('United States');
    await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    await fireEvent.keyDown(btn, { key: ' ' });
    expect(view.getByRole('listbox')).toBeInTheDocument();
    await fireEvent.keyUp(btn, { key: ' ' });
    expect(prefs.values.region).toBe('DE');
    expect(view.queryByRole('listbox')).toBeNull();

    await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    await fireEvent.keyDown(btn, { key: 'Tab' });
    expect(view.queryByRole('listbox')).toBeNull();
    expect(ui.menu).toBeNull();
    expect(prefs.values.region).toBe('DE');
  });

  it('names the list and the highlighted option on the button while open', async () => {
    const view = render(Page);
    const btn = view.getByRole('combobox', { name: /^Country or region / });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).not.toHaveAttribute('aria-controls');
    expect(btn).not.toHaveAttribute('aria-activedescendant');

    await fireEvent.click(btn);
    const list = view.getByRole('listbox', { name: 'Country or region' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(list.id).not.toBe('');
    expect(btn).toHaveAttribute('aria-controls', list.id);
    const opts = within(list).getAllByRole('option');
    expect(new Set(opts.map((o) => o.id)).size).toBe(opts.length);
    expect(opts[0]).toHaveTextContent('Germany');
    expect(btn).toHaveAttribute('aria-activedescendant', opts[0]!.id);

    await fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(btn).toHaveAttribute('aria-activedescendant', opts[1]!.id);
    expect(opts[1]).toHaveClass('hi');

    await fireEvent.keyDown(btn, { key: 'Tab' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).not.toHaveAttribute('aria-controls');
    expect(btn).not.toHaveAttribute('aria-activedescendant');
  });

  it('scrolls the page along until the highlighted row is visible', async () => {
    // jsdom has no `scrollIntoView`; if the list is below the window edge, the page has to scroll too.
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    try {
      const view = render(Page);
      const btn = view.getByRole('combobox', { name: /^Country or region / });
      await fireEvent.keyDown(btn, { key: 'ArrowDown' });
      await tick();
      expect(scroll.mock.contexts.at(-1)).toHaveTextContent('Germany');
      await fireEvent.keyDown(btn, { key: 'ArrowDown' });
      await tick();
      expect(scroll.mock.contexts.at(-1)).toHaveTextContent('Austria');
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  it('locks the time zone while it is automatic and unlocks it with the switch', async () => {
    const view = render(Page);
    const tz = view.getByRole('combobox', { name: /^Time zone / });
    expect(tz).toHaveAttribute('aria-disabled', 'true');
    expect(tz.closest('.pick')).toHaveClass('disabled');
    await fireEvent.click(tz);
    await fireEvent.keyDown(tz, { key: 'ArrowDown' });
    expect(ui.menu).toBeNull();
    expect(view.queryByRole('listbox')).toBeNull();

    const auto = view.getByRole('switch', { name: 'Set time zone automatically' });
    await fireEvent.click(auto);
    expect(prefs.values.tzAuto).toBe(false);
    expect(prefs.values.tz).toBe('Europe/Berlin');
    expect(auto).toHaveAttribute('aria-checked', 'false');
    expect(auto).not.toHaveClass('on');
    expect(tz).toHaveAttribute('aria-disabled', 'false');
    expect(tz.closest('.pick')).not.toHaveClass('disabled');

    await fireEvent.click(tz);
    const list = view.getByRole('listbox', { name: 'Time zone' });
    const opts = within(list).getAllByRole('option');
    expect(opts).toHaveLength(6);
    expect(opts[0]?.querySelector('.opt-sub')).toHaveTextContent('CET');
    expect(within(list).getByRole('option', { selected: true })).toHaveTextContent(/^Berlin, Vienna, Zurich/);
    await fireEvent.click(within(list).getByRole('option', { name: /^Tokyo, Seoul/ }));
    expect(prefs.values.tz).toBe('Asia/Tokyo');
    expect(tz).toHaveTextContent('Tokyo, Seoul (GMT+9)');
    expect(preview(view.container)[1]).toEqual(['Time', '19:00']);

    // Automatic again: the device zone applies and is reported.
    await fireEvent.click(auto);
    expect(prefs.values).toMatchObject({ tzAuto: true, tz: 'Europe/Berlin' });
    expect(tz).toHaveTextContent('Berlin, Vienna, Zurich (CET)');
  });

  it('puts a device zone outside the selection at the front', async () => {
    device.tz = 'America/Argentina/Buenos_Aires';
    prefs.set({ tzAuto: false, tz: 'America/Argentina/Buenos_Aires' });
    const view = render(Page);
    const tz = view.getByRole('combobox', { name: /^Time zone / });
    expect(tz).toHaveTextContent(/^Buenos Aires/);
    await fireEvent.click(tz);
    const opts = within(view.getByRole('listbox', { name: 'Time zone' })).getAllByRole('option');
    expect(opts).toHaveLength(7);
    expect(opts[0]).toHaveAttribute('aria-selected', 'true');
    expect(preview(view.container)[1]).toEqual(['Time', '07:00']);
  });

  it('changes the formats, the preview follows', async () => {
    const view = render(Page);
    await fireEvent.click(group('Date format').getByRole('radio', { name: '2026-11-01' }));
    expect(prefs.values.dateFmt).toBe('iso');
    expect(checked('Date format')).toHaveTextContent('2026-11-01');
    await fireEvent.click(group('Time format').getByRole('radio', { name: '12-hour' }));
    expect(prefs.values.timeFmt).toBe('12h');
    await fireEvent.click(group('Week starts on').getByRole('radio', { name: 'Sunday' }));
    expect(prefs.values.weekStart).toBe('sunday');
    expect(checked('Week starts on')).toHaveTextContent('Sunday');
    await fireEvent.click(group('Number format').getAllByRole('radio')[2]!);
    expect(prefs.values.numFmt).toBe(`1${NBSP}234,56`);
    expect(checked('Number format')).toHaveClass('on');
    expect(preview(view.container)).toEqual([
      ['Date', '2026-11-01'],
      ['Time', '11:00 AM'],
      ['Number', `12${NBSP}345,67`],
    ]);
    expect(view.getByRole('radiogroup', { name: 'Date format' })).toHaveClass('num', 'date');
    expect(view.getByRole('radiogroup', { name: 'Number format' })).toHaveClass('num');
    expect(view.getByRole('radiogroup', { name: 'Time format' })).not.toHaveClass('num');
  });

  it('updates preview and date formats across the day change', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    // 23:59:50 in Berlin.
    vi.setSystemTime(Date.UTC(2026, 10, 1, 22, 59, 50));
    const view = render(Page);
    expect(preview(view.container)[0]).toEqual(['Date', '01.11.2026']);
    vi.advanceTimersByTime(30_000);
    await tick();
    expect(preview(view.container)).toEqual([
      ['Date', '02.11.2026'],
      ['Time', '00:00'],
      ['Number', '12.345,67'],
    ]);
    expect(checked('Date format')).toHaveTextContent('02.11.2026');
  });

  it('scrolls to the section via the tabs, instantly without animations', async () => {
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: 'Region' }));
    expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'region', true);
    expect(view.container.querySelector('[data-sec="region"]')).not.toBeNull();
    prefs.set({ animations: false });
    await fireEvent.click(view.getByRole('button', { name: 'Formats' }));
    expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'formats', false);
    await fireEvent.click(view.getByRole('button', { name: 'Language' }));
    expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'lang', false);
  });

  it('shows header, tabs and the pick lists in the sheet on mobile (ui.pick)', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Language & region');
    expect(view.getByText('Language, date, and time format.')).toBeInTheDocument();
    expect(view.container.querySelector('.page')).toHaveClass('mobile');
    expect(view.getByRole('button', { name: 'Formats' })).toBeInTheDocument();
    expect(group('Language').getAllByRole('radio')).toHaveLength(3);
    expect(preview(view.container)).toHaveLength(3);

    const region = view.getByRole('button', { name: /^Country or region / });
    expect(region).toHaveAttribute('aria-haspopup', 'dialog');
    await fireEvent.click(region);
    // On mobile the layout shows the list as a sheet, no popover on the page.
    expect(ui.menu).toBe('pick');
    expect(view.queryByRole('listbox')).toBeNull();
    expect(region).not.toHaveAttribute('aria-expanded');
    const pick = ui.pick?.();
    expect(pick?.title).toBe('Country or region');
    expect(pick?.opts.map((o) => o.label)).toEqual(REGIONS);
    expect(pick?.opts[0]).toMatchObject({ on: true, fw: 800, hasSub: false, sub: '' });
    pick?.opts[1]?.onClick();
    await tick();
    expect(prefs.values.region).toBe('AT');
    expect(ui.menu).toBeNull();
    expect(region).toHaveTextContent('Austria');
    // The button's keys do nothing on mobile.
    await fireEvent.keyDown(region, { key: 'ArrowDown' });
    expect(ui.menu).toBeNull();

    await fireEvent.click(view.getByRole('switch', { name: 'Set time zone automatically' }));
    await fireEvent.click(view.getByRole('button', { name: /^Time zone / }));
    expect(ui.menu).toBe('pick');
    expect(ui.pick?.().title).toBe('Time zone');
    expect(ui.pick?.().opts[0]).toMatchObject({ label: 'Berlin, Vienna, Zurich', sub: 'CET', hasSub: true, on: true });

    view.unmount();
    expect(ui.menu).toBeNull();
    expect(ui.pick).toBeNull();
  });
});
