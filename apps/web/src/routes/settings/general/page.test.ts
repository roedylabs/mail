import { createEvent, fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { tooltips } from '#lib/actions/tooltip.ts';
import { general } from '#lib/general.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session, type Me } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

// The tabs scroll to the section; jsdom has no layout (`offsetParent`), hence only the call.
const scrollToSection = vi.hoisted(() => vi.fn());
vi.mock('#lib/sections.ts', () => ({ scrollToSection }));

const ASK = 'Images from external servers load only after you allow them.';
const NEVER = 'Images from external servers never load automatically, not even from allowed senders.';
const ALWAYS = 'Images load right away. Senders can tell when you open a message.';
const NOTE = 'Images from these senders always load.';
const NOTE_INACTIVE = m.ext_list_note_inactive();
const EMPTY = m.ext_empty();

const TABS = ['Startup', 'Behavior', 'Gestures', 'External content', 'Data', 'Delete account'];
const SECTIONS = ['start', 'behavior', 'swipe', 'ext', 'data', 'danger'];
const SWIPES = ['No action', 'Delete', 'Read / unread', 'Flag', 'Report spam', 'Move to folder'];
const UNDO = 'This can’t be undone.';
const SOLE =
  'You’re the only administrator. Make someone else an administrator first, then you can delete your account.';
const SOLE_TIP = 'Only possible once there’s another administrator';
const MB = 1024 * 1024;

const ME: Me = {
  id: 'u1',
  username: 'jane',
  email: 'jane@example.com',
  display_name: 'Jane Doe',
  role: 'user',
  mfa_enabled: false,
  password_changed_at: '2026-10-01T10:00:00Z',
  email_change: null,
  sole_admin: false,
};

function group(name: string) {
  return within(screen.getByRole('radiogroup', { name }));
}

function hiLabel(list: HTMLElement) {
  return list.querySelector('.opt.hi .opt-label')?.textContent;
}

function mobile() {
  vi.stubGlobal('innerWidth', 390);
  window.dispatchEvent(new Event('resize'));
}

let measure: MockInstance<() => Promise<void>>;

beforeEach(() => {
  // The tests set the device storage themselves (jsdom does not know `navigator.storage`).
  measure = vi.spyOn(general, 'measure').mockResolvedValue(undefined);
  session.user = ME;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  scrollToSection.mockClear();
  general.localBytes = null;
  general.clearing = false;
  general.deleting = false;
  session.user = null;
  ui.reset();
  prefs.reset();
  window.dispatchEvent(new Event('resize'));
});

describe('General page', () => {
  it('shows header, tabs and the sections in the order of the tabs', () => {
    const view = render(Page);
    expect(measure).toHaveBeenCalledOnce();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('General');
    expect(view.getByText('Basic app settings.')).toBeInTheDocument();
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(TABS);
    for (const t of TABS.slice(0, -1)) expect(view.getByRole('button', { name: t })).toHaveClass('tab');
    expect(view.container.querySelectorAll('.tab')).toHaveLength(6);
    expect(Array.from(view.container.querySelectorAll('[data-sec]'), (s) => s.getAttribute('data-sec'))).toEqual(
      SECTIONS,
    );
    expect(view.getByText('What you see after signing in.')).toBeInTheDocument();
    expect(view.getByText('Confirmations and notices while you work.')).toBeInTheDocument();
    expect(
      view.getByText('Actions when you swipe across a message. Applies on tablets and phones.'),
    ).toBeInTheDocument();
    expect(view.getByText('Download your data or remove it from this device.')).toBeInTheDocument();
    expect(view.getByText('Your account and all its data will be permanently removed.')).toBeInTheDocument();
  });

  it('scrolls to the section via the tabs, instantly without animations', async () => {
    const view = render(Page);
    const tabs = Array.from(view.container.querySelectorAll<HTMLElement>('.tab'));
    expect(tabs.map((t) => t.textContent)).toEqual(TABS);
    for (const [i, tab] of tabs.entries()) {
      await fireEvent.click(tab);
      expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), SECTIONS[i], true);
    }
    prefs.set({ animations: false });
    await fireEvent.click(tabs[4]!);
    expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'data', false);
  });

  it('selects "Open on startup" in the popover', async () => {
    const view = render(Page);
    expect(view.getByText('First page after sign-in')).toBeInTheDocument();
    // Name from the row label and the visible value (WCAG 2.5.3).
    const btn = view.getByRole('combobox', { name: 'Open on startup Inbox' });
    expect(btn).toHaveTextContent('Inbox');
    expect(btn).toHaveAttribute('role', 'combobox');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-disabled', 'false');
    btn.focus();
    await fireEvent.click(btn);
    expect(ui.menu).toBe('pick');
    expect(btn).toHaveClass('open');
    const list = view.getByRole('listbox', { name: 'Open on startup' });
    expect(list.closest('[data-pop]')).not.toBeNull();
    const opts = within(list).getAllByRole('option');
    expect(opts.map((o) => o.textContent.trim())).toEqual(['Inbox', 'Last opened page']);
    expect(within(list).getByRole('option', { selected: true })).toHaveTextContent('Inbox');
    expect(hiLabel(list)).toBe('Inbox');
    await fireEvent.mouseMove(opts[1]!);
    expect(hiLabel(list)).toBe('Last opened page');
    // The mouse click does not take the focus from the button, otherwise it would fall to `body` with the list.
    const down = createEvent.mouseDown(opts[1]!);
    await fireEvent(opts[1]!, down);
    expect(down.defaultPrevented).toBe(true);
    await fireEvent.click(opts[1]!);
    expect(prefs.values.gStart).toBe('last');
    expect(ui.menu).toBeNull();
    expect(view.queryByRole('listbox')).toBeNull();
    expect(btn).toHaveTextContent('Last opened page');
    expect(btn).toHaveAccessibleName('Open on startup Last opened page');
    expect(btn).toHaveFocus();
  });

  it('selects the swipe gestures with mouse and keyboard', async () => {
    const view = render(Page);
    expect(view.getByText('Right to left across the message')).toBeInTheDocument();
    expect(view.getByText('Left to right across the message')).toBeInTheDocument();
    const left = view.getByRole('combobox', { name: 'Swipe left Move to folder' });
    const right = view.getByRole('combobox', { name: 'Swipe right Delete' });
    expect(left).toHaveTextContent('Move to folder');
    expect(right).toHaveTextContent('Delete');

    await fireEvent.click(left);
    const list = view.getByRole('listbox', { name: 'Swipe left' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent.trim()),
    ).toEqual(SWIPES);
    expect(within(list).getByRole('option', { selected: true })).toHaveTextContent('Move to folder');
    await fireEvent.click(within(list).getByRole('option', { name: 'Report spam' }));
    expect(prefs.values.swL).toBe('spam');
    expect(left).toHaveTextContent('Report spam');
    expect(left).toHaveAccessibleName('Swipe left Report spam');

    // Only one list at a time: the keys open the right list on the selected row.
    await fireEvent.keyDown(right, { key: 'ArrowDown' });
    const listR = view.getByRole('listbox', { name: 'Swipe right' });
    expect(view.getAllByRole('listbox')).toHaveLength(1);
    expect(hiLabel(listR)).toBe('Delete');
    await fireEvent.keyDown(right, { key: 'ArrowDown' });
    await fireEvent.keyDown(right, { key: 'ArrowDown' });
    expect(hiLabel(listR)).toBe('Flag');
    await fireEvent.keyDown(right, { key: 'Enter' });
    expect(prefs.values.swR).toBe('star');
    expect(view.queryByRole('listbox')).toBeNull();
    expect(right).toHaveTextContent('Flag');
  });

  it('refers to separate IDs per list for aria-controls and aria-activedescendant', async () => {
    const view = render(Page);
    const left = view.getByRole('combobox', { name: /^Swipe left / });
    const right = view.getByRole('combobox', { name: /^Swipe right / });
    for (const btn of [left, right]) {
      expect(btn).toHaveAttribute('aria-expanded', 'false');
      expect(btn).not.toHaveAttribute('aria-controls');
      expect(btn).not.toHaveAttribute('aria-activedescendant');
    }

    await fireEvent.keyDown(left, { key: 'ArrowDown' });
    const listL = view.getByRole('listbox', { name: 'Swipe left' });
    expect(left).toHaveAttribute('aria-controls', listL.id);
    expect(left).toHaveAttribute('aria-activedescendant', within(listL).getByRole('option', { selected: true }).id);
    await fireEvent.keyDown(left, { key: 'Tab' });

    await fireEvent.keyDown(right, { key: 'ArrowDown' });
    const listR = view.getByRole('listbox', { name: 'Swipe right' });
    expect(listR.id).not.toBe(listL.id);
    expect(left).not.toHaveAttribute('aria-controls');
    expect(right).toHaveAttribute('aria-controls', listR.id);
    const optsR = within(listR).getAllByRole('option');
    const at = optsR.findIndex((o) => o.getAttribute('aria-selected') === 'true');
    expect(right).toHaveAttribute('aria-activedescendant', optsR[at]!.id);
    await fireEvent.keyDown(right, { key: 'ArrowDown' });
    expect(right).toHaveAttribute('aria-activedescendant', optsR[(at + 1) % optsR.length]!.id);
  });

  it('toggles confirmations and keyboard shortcuts and selects the duration of the undo notice', async () => {
    const view = render(Page);
    const confirm = view.getByRole('switch', { name: 'Ask before deleting' });
    const keys = view.getByRole('switch', { name: 'Keyboard shortcuts' });
    expect(view.getByText('Confirm before anything is removed or suspended')).toBeInTheDocument();
    expect(view.getByText('Single keys like / or C trigger commands')).toBeInTheDocument();
    expect(view.getByText('How long you can undo an action')).toBeInTheDocument();
    expect(confirm).toHaveAttribute('aria-checked', 'true');
    expect(confirm).toHaveClass('on');
    expect(keys).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(confirm);
    expect(prefs.values.gConfirm).toBe(false);
    expect(confirm).toHaveAttribute('aria-checked', 'false');
    expect(confirm).not.toHaveClass('on');
    await fireEvent.click(keys);
    expect(prefs.values.gKeys).toBe(false);
    expect(keys).toHaveAttribute('aria-checked', 'false');

    const undo = group('Undo period');
    expect(undo.getAllByRole('radio').map((r) => r.textContent)).toEqual(['3 s', '5 s', '10 s']);
    expect(undo.getByRole('radio', { checked: true })).toHaveTextContent('5 s');
    await fireEvent.click(undo.getByRole('radio', { name: '10 s' }));
    expect(prefs.values.gUndo).toBe('10 s');
    expect(undo.getByRole('radio', { checked: true })).toHaveTextContent('10 s');
    expect(undo.getByRole('radio', { checked: true })).toHaveClass('on');
  });

  it('exports the data and deletes local data via the actions of the state', async () => {
    const doExport = vi.spyOn(general, 'doExport').mockReturnValue(undefined);
    const clearLocal = vi.spyOn(general, 'clearLocal').mockReturnValue(undefined);
    const view = render(Page);
    expect(view.getByText('Account and settings as a JSON file')).toBeInTheDocument();
    const exp = view.getByRole('button', { name: 'Export' });
    expect(exp).toHaveAttribute('aria-disabled', 'false');
    expect(exp.querySelector('svg')).toHaveClass('tabler-icon-download');
    await fireEvent.click(exp);
    expect(doExport).toHaveBeenCalledOnce();

    // Dimmed without local data.
    expect(view.getByText('No local data on this device')).toBeInTheDocument();
    const local = view.getByRole('button', { name: 'Clear' });
    expect(local).toHaveClass('dim');
    expect(local.querySelector('svg')).toHaveClass('tabler-icon-eraser');

    general.localBytes = 184 * MB;
    await tick();
    expect(view.getByText('184 MB on this device')).toBeInTheDocument();
    expect(local).not.toHaveClass('dim');
    await fireEvent.click(local);
    expect(clearLocal).toHaveBeenCalledOnce();

    // While deleting, the icon spins and the button is locked.
    general.clearing = true;
    await tick();
    const busy = view.getByRole('button', { name: 'Clearing' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toHaveClass('busy');
    expect(busy.querySelector('.act-icon')).toHaveClass('spin');
    expect(busy.querySelector('svg')).toHaveClass('tabler-icon-loader-2');
  });

  it('delete account as a user: notice, button enabled, confirmation with "DELETE"', async () => {
    const view = render(Page);
    expect(view.getByText('jane@example.com')).toBeInTheDocument();
    expect(view.getByText(UNDO)).toBeInTheDocument();
    expect(view.queryByRole('link', { name: 'Manage users' })).toBeNull();
    const del = view.getAllByRole('button', { name: 'Delete account' }).find((b) => b.classList.contains('del'))!;
    expect(del).toHaveAttribute('aria-disabled', 'false');
    expect(del).not.toHaveClass('locked');
    expect(tooltips.targets.get(del)?.text).toBeUndefined();
    await fireEvent.click(del);
    expect(ui.confirm).toMatchObject({
      title: 'Permanently delete account?',
      text: 'Your account jane@example.com and all its data will be deleted. This can’t be undone.',
      word: 'DELETE',
      danger: true,
      force: true,
    });
  });

  it('delete account as an administrator among others: as for users', async () => {
    session.user = { ...ME, role: 'admin' };
    const view = render(Page);
    expect(view.getByText(UNDO)).toBeInTheDocument();
    expect(view.queryByText(SOLE)).toBeNull();
    expect(view.queryByRole('link', { name: 'Manage users' })).toBeNull();
    const del = view.container.querySelector<HTMLElement>('.del')!;
    expect(del).toHaveAttribute('aria-disabled', 'false');
    await fireEvent.click(del);
    expect(ui.confirm?.title).toBe('Permanently delete account?');
  });

  it('delete account as the sole administrator: notice, link, locked button, no dialog', async () => {
    session.user = { ...ME, role: 'admin', sole_admin: true };
    const deleteAccount = vi.spyOn(general, 'deleteAccount');
    const view = render(Page);
    expect(view.getByText(SOLE)).toBeInTheDocument();
    expect(view.queryByText(UNDO)).toBeNull();
    const link = view.getByRole('link', { name: 'Manage users' });
    expect(link).toHaveAttribute('href', '/admin/users');
    expect(link.querySelector('svg')).toHaveClass('tabler-icon-arrow-right');
    const del = view.container.querySelector<HTMLElement>('.del')!;
    expect(del).toHaveTextContent('Delete account');
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveClass('locked');
    expect(tooltips.targets.get(del)?.text).toBe(SOLE_TIP);
    await fireEvent.click(del);
    expect(deleteAccount).toHaveBeenCalledOnce();
    expect(ui.confirm).toBeNull();
  });

  it('shows "Deleting …" on the locked button while deleting', async () => {
    const view = render(Page);
    general.deleting = true;
    await tick();
    const del = view.container.querySelector<HTMLElement>('.del')!;
    expect(del).toHaveTextContent('Deleting …');
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveAttribute('aria-busy', 'true');
    expect(del).toHaveClass('busy');
    expect(del).not.toHaveClass('locked');
    await fireEvent.click(del);
    expect(ui.confirm).toBeNull();
  });

  it('shows the "External content" section with "Ask" and without senders', () => {
    const view = render(Page);
    expect(view.getByRole('heading', { level: 2, name: 'External content' })).toBeInTheDocument();
    expect(
      view.getByText('Images and tracking pixels that HTML messages load from external servers.'),
    ).toBeInTheDocument();
    const group = view.getByRole('radiogroup', { name: 'External content in emails' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Ask', 'Always load', 'Never load']);
    expect(within(group).getByRole('radio', { checked: true })).toHaveTextContent('Ask');
    expect(view.getByText(ASK)).toBeInTheDocument();
    expect(view.getByText('Allowed senders')).toBeInTheDocument();
    expect(view.getByText(NOTE).parentElement).not.toHaveClass('dim');
    expect(view.getByText(EMPTY)).toBeInTheDocument();
  });

  it('switches the setting and adapts description and notice of the list', async () => {
    const view = render(Page);
    const group = view.getByRole('radiogroup', { name: 'External content in emails' });
    await fireEvent.click(within(group).getByRole('radio', { name: 'Never load' }));
    expect(prefs.values.extMode).toBe('never');
    expect(within(group).getByRole('radio', { checked: true })).toHaveTextContent('Never load');
    expect(view.getByText(NEVER)).toBeInTheDocument();
    expect(view.getByText(NOTE_INACTIVE).parentElement).toHaveClass('dim');
    await fireEvent.click(within(group).getByRole('radio', { name: 'Always load' }));
    expect(prefs.values.extMode).toBe('always');
    expect(view.getByText(ALWAYS)).toBeInTheDocument();
    expect(view.getByText(NOTE_INACTIVE)).toBeInTheDocument();
    await fireEvent.click(within(group).getByRole('radio', { name: 'Ask' }));
    expect(prefs.values.extMode).toBe('ask');
    expect(view.getByText(ASK)).toBeInTheDocument();
    expect(view.getByText(NOTE).parentElement).not.toHaveClass('dim');
  });

  it('lists allowed senders and removes one with undo at the old position', async () => {
    prefs.set({ extAllow: ['hello@oss-week.example', 'news@example.com'] });
    const view = render(Page);
    expect(view.queryByText(EMPTY)).toBeNull();
    expect(view.getByText('H')).toBeInTheDocument();
    expect(view.getByText('N')).toBeInTheDocument();
    expect(view.getByText('news@example.com')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Remove hello@oss-week.example from allowed senders' }));
    expect(prefs.values.extAllow).toEqual(['news@example.com']);
    expect(ui.toast).toMatchObject({ text: 'hello@oss-week.example removed from allowed senders', undo: true });
    expect(view.queryByText('hello@oss-week.example')).toBeNull();
    ui.toasts.undo();
    await tick();
    expect(prefs.values.extAllow).toEqual(['hello@oss-week.example', 'news@example.com']);
    expect(view.getByText('hello@oss-week.example')).toBeInTheDocument();
    expect(ui.toast).toBeNull();
  });

  it('shows the empty text once the last sender is removed', async () => {
    prefs.set({ extAllow: ['hello@oss-week.example'] });
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: 'Remove hello@oss-week.example from allowed senders' }));
    expect(prefs.values.extAllow).toEqual([]);
    expect(view.getByText(EMPTY)).toBeInTheDocument();
  });

  it('shows the shorter texts without keyboard shortcuts on mobile', () => {
    mobile();
    const view = render(Page);
    expect(view.container.querySelector('.page')).toHaveClass('mobile');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('General');
    expect(view.getByText('Basic app settings.')).toBeInTheDocument();
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(TABS);
    expect(view.getByText('Images and tracking pixels from external servers in HTML messages.')).toBeInTheDocument();
    expect(view.getByText('No allowed senders yet.')).toBeInTheDocument();
    expect(view.queryByText(EMPTY)).toBeNull();
    expect(
      within(view.getByRole('radiogroup', { name: 'External content in emails' })).getAllByRole('radio'),
    ).toHaveLength(3);
    expect(view.getByText('Confirm before removing')).toBeInTheDocument();
    expect(view.getByText('Actions when you swipe across a message.')).toBeInTheDocument();
    expect(view.getByText('Right to left')).toBeInTheDocument();
    expect(view.getByText('Left to right')).toBeInTheDocument();
    expect(view.getAllByRole('switch').map((s) => s.getAttribute('aria-label'))).toEqual(['Ask before deleting']);
    expect(view.queryByRole('switch', { name: 'Keyboard shortcuts' })).toBeNull();
  });

  it('shows the pick lists in the sheet on mobile (ui.pick)', async () => {
    mobile();
    const view = render(Page);
    const right = view.getByRole('button', { name: /^Swipe right / });
    // On mobile the button opens the sheet: no combobox.
    expect(right).toHaveAttribute('aria-haspopup', 'dialog');
    await fireEvent.click(right);
    expect(ui.menu).toBe('pick');
    expect(view.queryByRole('listbox')).toBeNull();
    expect(right).not.toHaveAttribute('aria-expanded');
    const pick = ui.pick?.();
    expect(pick?.title).toBe('Swipe right');
    expect(pick?.opts.map((o) => o.label)).toEqual(SWIPES);
    expect(pick?.opts[1]).toMatchObject({ on: true, fw: 800 });
    pick?.opts[0]?.onClick();
    await tick();
    expect(prefs.values.swR).toBe('none');
    expect(ui.menu).toBeNull();
    expect(right).toHaveTextContent('No action');

    await fireEvent.click(view.getByRole('button', { name: /^Open on startup / }));
    expect(ui.pick?.().title).toBe('Open on startup');
    await fireEvent.click(view.getByRole('button', { name: /^Swipe left / }));
    expect(ui.pick?.().title).toBe('Swipe left');

    view.unmount();
    expect(ui.menu).toBeNull();
    expect(ui.pick).toBeNull();
  });

  it('locks without a tooltip as the sole administrator on mobile', () => {
    mobile();
    session.user = { ...ME, role: 'admin', sole_admin: true };
    const view = render(Page);
    const del = view.container.querySelector<HTMLElement>('.del')!;
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveClass('locked');
    expect(tooltips.targets.get(del)?.text).toBeUndefined();
    expect(view.getByRole('link', { name: 'Manage users' })).toBeInTheDocument();
  });
});
