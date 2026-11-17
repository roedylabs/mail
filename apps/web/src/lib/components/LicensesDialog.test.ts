import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideTooltip, TIP_DELAY, TIP_FADE } from '#lib/actions/tooltip.ts';
import { licenseValues, parseLicenseList, type LicenseInput, type LicenseList } from '#lib/licenses.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import LicensesDialog from './LicensesDialog.svelte';

/** Made-up packages in the format of `licenses.json`. */
const LIST = parseLicenseList({
  version: 1,
  generated: '2026-11-12T00:00:00.000Z',
  packages: [
    {
      name: '@example/font-variable',
      version: '2.1.0',
      license: 'OFL-1.1',
      url: 'https://font.example.test',
      origin: 'web',
      texts: [0],
    },
    { name: 'little-helper', version: '0.4.2', license: 'MIT', origin: 'web', texts: [1] },
    { name: 'no-text', version: '1.0.0', license: 'ISC', url: 'javascript:alert(1)', origin: 'web', texts: [] },
    {
      name: 'net-core',
      version: '3.0.1',
      license: 'MIT OR Apache-2.0',
      url: 'https://net.example.test/core',
      origin: 'server',
      texts: [1],
    },
    {
      name: 'crypto-parts',
      version: '0.9.0',
      license: 'Apache-2.0 AND ISC AND MIT AND BSD-3-Clause AND Unicode-3.0',
      origin: 'server',
      texts: [2, 1],
    },
  ],
  texts: ['Copyright 2020 Font Authors\n\nSIL Open Font License', 'MIT License …', 'Apache License 2.0 …'],
})!;

function values(patch: Partial<LicenseInput> = {}) {
  const ctx = { close: vi.fn(), retry: vi.fn(), setQ: vi.fn(), setSeg: vi.fn(), setExp: vi.fn() };
  const input: LicenseInput = {
    status: 'ok',
    list: LIST,
    appName: 'Roedy Mail',
    q: '',
    seg: 'web',
    exp: null,
    ...patch,
  };
  return { ctx, lic: licenseValues(input, ctx) };
}

function open(patch: Partial<LicenseInput> = {}, mobile = false) {
  const { ctx, lic } = values(patch);
  const view = render(LicensesDialog, { lic, mobile });
  return { ctx, lic, view };
}

async function tipOf(el: Element): Promise<string | undefined> {
  vi.useFakeTimers();
  await fireEvent.pointerEnter(el, { pointerType: 'mouse' });
  vi.advanceTimersByTime(TIP_DELAY);
  const text = ui.tip?.text;
  await fireEvent.pointerLeave(el, { pointerType: 'mouse' });
  vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);
  vi.useRealTimers();
  return text;
}

/** Text and `aria-expanded` of the row buttons. */
function rows(root: Element) {
  return [...root.querySelectorAll('.toggle')].map((b) => [
    b.textContent.replace(/\s+/g, ' ').trim(),
    b.getAttribute('aria-expanded'),
  ]);
}

afterEach(() => {
  hideTooltip();
  ui.reset();
  vi.useRealTimers();
});

describe('LicensesDialog', () => {
  it('shows search, segment and rows on desktop when loaded; focus is in the search field', async () => {
    const { ctx, view } = open();
    const dialog = view.getByRole('dialog', { name: 'All licenses' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(view.getByRole('heading', { level: 2, name: 'All licenses' })).not.toHaveAttribute('tabindex');
    expect(view.getByText('5 packages that Roedy Mail ships')).toBeInTheDocument();

    const search = view.getByRole('textbox', { name: 'Search packages or licenses' });
    expect(search).toHaveAttribute('placeholder', 'Search packages or licenses');
    expect(search).toHaveValue('');
    expect(document.activeElement).toBe(search);

    const group = view.getByRole('radiogroup', { name: 'Origin' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => [r.textContent, r.getAttribute('aria-checked'), r.getAttribute('tabindex')])).toEqual([
      ['Web app 3', 'true', '0'],
      ['Server 2', 'false', '-1'],
    ]);
    expect(radios[0]).toHaveClass('on');
    expect(radios[1]).not.toHaveClass('on');

    const list = dialog.querySelector('.scroll')!;
    expect(list).toHaveAttribute('aria-busy', 'false');
    expect(list).toHaveClass('no-scrollbar');
    expect(rows(list)).toEqual([
      ['@example/font-variable 2.1.0 OFL-1.1', 'false'],
      ['little-helper 0.4.2 MIT', 'false'],
      ['no-text 1.0.0 ISC', 'false'],
    ]);
    expect(view.getByRole('button', { name: /^little-helper 0\.4\.2/ })).toBeInTheDocument();
    expect(list.querySelector('.tag')).toHaveTextContent('OFL-1.1');
    expect(list.querySelector('.row.on')).toBeNull();
    expect(view.queryByRole('region')).toBeNull();
    expect(view.queryByRole('status')).toBeNull();
    expect(view.queryByRole('alert')).toBeNull();

    const close = view.getByRole('button', { name: 'Close' });
    expect(await tipOf(close)).toBe('Close (Esc)');
    await fireEvent.click(close);
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('searches, chooses the origin by click and arrow key and expands rows', async () => {
    const { ctx, view } = open();
    await fireEvent.input(view.getByRole('textbox'), { target: { value: 'helper' } });
    expect(ctx.setQ).toHaveBeenCalledWith('helper');
    expect(ctx.setExp).toHaveBeenLastCalledWith(null);

    await fireEvent.click(view.getByRole('radio', { name: 'Server 2' }));
    expect(ctx.setSeg).toHaveBeenLastCalledWith('server');
    ctx.setSeg.mockClear();
    await fireEvent.keyDown(view.getByRole('radio', { name: 'Web app 3' }), { key: 'ArrowRight' });
    expect(ctx.setSeg).toHaveBeenCalledWith('server');

    await fireEvent.click(view.getByRole('button', { name: /^little-helper/ }));
    expect(ctx.setExp).toHaveBeenLastCalledWith('web:little-helper@0.4.2');
  });

  it('reports the backdrop to `overlay`, but not clicks in the dialog', async () => {
    const { ctx, view } = open();
    await fireEvent.mouseDown(view.getByRole('dialog'));
    expect(ctx.close).not.toHaveBeenCalled();
    await fireEvent.mouseDown(view.getByRole('presentation'));
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('shows an expanded row with two license texts, without a project page', () => {
    const { view } = open({ seg: 'server', exp: 'server:crypto-parts@0.9.0' });
    const toggle = view.getByRole('button', { name: /^crypto-parts/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const row = toggle.closest('.row')!;
    expect(row).toHaveClass('on');
    expect(view.getByRole('button', { name: /^net-core/ })).toHaveAttribute('aria-expanded', 'false');
    // Long SPDX expression complete in the DOM, truncated only via CSS and without a tooltip.
    const long = 'Apache-2.0 AND ISC AND MIT AND BSD-3-Clause AND Unicode-3.0';
    expect(row.querySelector('.tag')).toHaveTextContent(long);
    expect(row.querySelector('.tag')).not.toHaveAttribute('title');
    // The expanded row shows it in full as the first line, before the license texts.
    const expr = row.querySelector('.detail > .expr')!;
    expect(row.querySelector('.detail')!.firstElementChild).toBe(expr);
    expect(expr.textContent).toBe(`License: ${long}`);
    expect(expr.querySelector('.expr-label')).toHaveTextContent('License:');
    expect(expr.querySelector('.expr-value')).toHaveTextContent(long);
    expect(within(row as HTMLElement).queryByRole('link')).toBeNull();
    const texts = within(row as HTMLElement).getAllByRole('region');
    expect(
      texts.map((t) => [t.tagName, t.getAttribute('aria-label'), t.getAttribute('tabindex'), t.textContent]),
    ).toEqual([
      ['PRE', 'License text of crypto-parts (1 of 2)', '0', 'Apache License 2.0 …'],
      ['PRE', 'License text of crypto-parts (2 of 2)', '0', 'MIT License …'],
    ]);
    expect(view.queryByText('This package has no license text of its own.')).toBeNull();
  });

  it('links the project page in a new tab', () => {
    const { view } = open({ exp: 'web:@example/font-variable@2.1.0' });
    const link = view.getByRole('link', { name: 'Project page' });
    // "License: …" sits above the project page.
    expect(link.previousElementSibling).toHaveClass('expr');
    expect(link.previousElementSibling!.textContent).toBe('License: OFL-1.1');
    expect(link).toHaveAttribute('href', 'https://font.example.test/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    const [text] = view.getAllByRole('region');
    expect(text).toHaveAccessibleName('License text of @example/font-variable');
    expect(text!.textContent).toBe('Copyright 2020 Font Authors\n\nSIL Open Font License');
  });

  it('names a package without license text and without a valid address', () => {
    const { view } = open({ exp: 'web:no-text@1.0.0' });
    const row = view.getByRole('button', { name: /^no-text/ }).closest('.row') as HTMLElement;
    expect(within(row).getByText('This package has no license text of its own.')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).toBeNull();
    expect(within(row).queryByRole('region')).toBeNull();
  });

  it('shows placeholders and status while loading; once the list is there, once into the search field', async () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const busy = values({ status: 'busy', list: null });
    const view = render(LicensesDialog, { lic: busy.lic, mobile: false });
    const dialog = view.getByRole('dialog');
    expect(document.activeElement).toBe(dialog);
    expect(view.getAllByText('Loading licenses …').map((e) => e.className)).toEqual([
      expect.stringContaining('sub'),
      expect.stringContaining('sr-only'),
    ]);
    expect(view.getByRole('status')).toHaveTextContent('Loading licenses …');
    const list = dialog.querySelector('.scroll')!;
    expect(list).toHaveAttribute('aria-busy', 'true');
    const skel = [...list.querySelectorAll('.skel')];
    expect(skel.every((s) => s.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(skel.map((s) => (s.querySelector('.bar') as HTMLElement).style.width)).toEqual([
      '46%',
      '34%',
      '52%',
      '28%',
      '40%',
      '36%',
    ]);
    expect(view.queryByRole('textbox')).toBeNull();
    expect(view.queryByRole('radiogroup')).toBeNull();

    await view.rerender({ lic: values().lic, mobile: false });
    const search = view.getByRole('textbox');
    expect(document.activeElement).toBe(search);
    expect(list).toHaveAttribute('aria-busy', 'false');
    expect(list.querySelector('.skel')).toBeNull();

    // Only once: further changes (search, origin) do not pull focus back.
    const server = view.getByRole('radio', { name: 'Server 2' });
    server.focus();
    await view.rerender({ lic: values({ seg: 'server' }).lic, mobile: false });
    expect(document.activeElement).toBe(server);

    // Return on close via the focus trap.
    view.unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('shows the error card with "Try again" on failure, without a connection the offline text', async () => {
    const { ctx, view } = open({ status: 'fail', list: null });
    const alert = view.getByRole('alert');
    expect(within(alert).getByText('Couldn’t load the license list')).toBeInTheDocument();
    expect(within(alert).getByText('That didn’t work. Please try again.')).toBeInTheDocument();
    expect(alert.querySelector('.tabler-icon-cloud-off')).not.toBeNull();
    expect(view.queryByRole('textbox')).toBeNull();
    expect(view.queryByRole('radiogroup')).toBeNull();
    expect(view.getByRole('dialog').querySelector('.scroll')).toHaveAttribute('aria-busy', 'false');
    expect(document.activeElement).toBe(view.getByRole('dialog'));
    await fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(ctx.retry).toHaveBeenCalledOnce();

    view.unmount();
    const offline = open({ status: 'offline', list: null }).view;
    expect(offline.getByRole('alert')).toHaveTextContent('No connection. Please try again.');
  });

  it('reports a build without a server list under "Server"', () => {
    const list: LicenseList = { packages: LIST.packages.filter((p) => p.origin === 'web'), texts: LIST.texts };
    const { view } = open({ list, seg: 'server' });
    expect(view.getByRole('radio', { name: 'Server 0' })).toHaveAttribute('aria-checked', 'true');
    const note = view.getByRole('status');
    expect(within(note).getByText('The list of server packages is missing')).toBeInTheDocument();
    expect(
      within(note).getByText('This build was created without it. The published image includes it.'),
    ).toBeInTheDocument();
    expect(note.querySelector('.tabler-icon-server-off')).not.toBeNull();
    expect(within(note).queryByRole('button')).toBeNull();
    expect(view.container.querySelector('.toggle')).toBeNull();
  });

  it('shows the card "No packages found" without hits', () => {
    const { view } = open({ q: 'does-not-exist' });
    expect(view.getByRole('textbox')).toHaveValue('does-not-exist');
    expect(view.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Web app 0', 'Server 0']);
    const note = view.getByRole('status');
    expect(note).toHaveTextContent('No packages found Check the spelling or try a different search term.');
    expect(note.querySelector('.tabler-icon-search-off')).not.toBeNull();
  });
});

describe('LicensesDialog mobile', () => {
  it('shows only the sheet content; focus is on the heading, not in the search field', async () => {
    const { ctx, view } = open({}, true);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.queryByRole('presentation')).toBeNull();
    const heading = view.getByRole('heading', { level: 2, name: 'All licenses' });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(heading);
    expect(view.getByText('5 packages that Roedy Mail ships')).toBeInTheDocument();
    expect(view.getByRole('textbox', { name: 'Search packages or licenses' })).toBeInTheDocument();
    expect(view.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Web app 3', 'Server 2']);
    const list = view.container.querySelector('.m-list')!;
    expect(list).toHaveAttribute('aria-busy', 'false');
    expect(rows(list)).toHaveLength(3);

    const close = view.getByRole('button', { name: 'Close' });
    expect(await tipOf(close)).toBeUndefined();
    await fireEvent.click(close);
    expect(ctx.close).toHaveBeenCalledOnce();
  });

  it('expands a row with project page and license text on mobile', () => {
    const { view } = open({ seg: 'server', exp: 'server:net-core@3.0.1' }, true);
    const toggle = view.getByRole('button', { name: /^net-core/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const expr = toggle.closest('.row')!.querySelector('.m-list .detail > .expr');
    expect(expr!.textContent).toBe('License: MIT OR Apache-2.0');
    expect(view.getByRole('link', { name: 'Project page' })).toHaveAttribute('href', 'https://net.example.test/core');
    expect(view.getByRole('region', { name: 'License text of net-core' })).toHaveAttribute('tabindex', '0');
  });

  it('shows loading, error and hint on mobile', async () => {
    const busy = open({ status: 'busy', list: null }, true);
    expect(busy.view.getByRole('status')).toHaveTextContent('Loading licenses …');
    expect(busy.view.container.querySelectorAll('.skel')).toHaveLength(6);
    expect(busy.view.container.querySelector('.m-list')).toHaveAttribute('aria-busy', 'true');
    expect(busy.view.queryByRole('textbox')).toBeNull();
    // No keyboard on mobile: focus stays on the heading after loading too.
    await busy.view.rerender({ lic: values().lic, mobile: true });
    expect(document.activeElement).toBe(busy.view.getByRole('heading', { level: 2 }));
    busy.view.unmount();

    const fail = open({ status: 'offline', list: null }, true);
    const again = within(fail.view.getByRole('alert')).getByRole('button', { name: 'Try again' });
    again.focus();
    await fireEvent.click(again);
    expect(fail.ctx.retry).toHaveBeenCalledOnce();
    // The button disappears while loading; focus is already on the heading before.
    expect(document.activeElement).toBe(fail.view.getByRole('heading', { level: 2 }));
    fail.view.unmount();

    const none = open({ q: 'does-not-exist' }, true);
    expect(none.view.getByRole('status')).toHaveTextContent('No packages found');
  });
});
