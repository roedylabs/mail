import { fireEvent, render, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { search } from '#lib/state/search.svelte.ts';
import Header from './Header.svelte';
import { type HeaderValues } from '#lib/shell.ts';

// The search suggestions open hits via navigation.
vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

afterEach(() => search.reset());

function values(patch: Partial<HeaderValues> = {}): HeaderValues {
  return {
    isMobile: false,
    appName: 'Roedy Mail',
    logo: { isMark: true },
    sbToggleOn: true,
    hdrQ: '',
    hdrHasQ: false,
    searchPlaceholder: 'Search Roedy Mail',
    resOpen: false,
    resExp: false,
    sfBtn: { aria: 'Filter', exp: false, fill: false, hasN: false, n: '0' },
    bellBadge: true,
    bellBadgeN: '2',
    bellLabel: 'Notifications, 2 new',
    bellOpen: false,
    appsOpen: false,
    accountOpen: false,
    userName: 'Doe, Jane',
    initials: 'DJ',
    showAdmin: true,
    adminOn: false,
    settingsOn: false,
    ...patch,
  };
}

describe('header', () => {
  it('shows search, toolbar and avatar on desktop', () => {
    const { getByRole, getByText } = render(Header, values());
    // Keyboard shortcuts on "Sidebar" and "Settings".
    expect(getByRole('button', { name: 'Show or hide sidebar' })).toHaveAttribute('aria-keyshortcuts', '[');
    expect(getByRole('combobox', { name: 'Search' })).toHaveAttribute('placeholder', 'Search Roedy Mail');
    // Without open search suggestions neither list nor reference to it.
    expect(getByRole('combobox')).not.toHaveAttribute('aria-controls');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(getByRole('button', { name: 'Notifications, 2 new' })).toBeInTheDocument();
    expect(getByText('2')).toHaveClass('badge');
    expect(getByRole('button', { name: 'Administration' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-keyshortcuts', ',');
    expect(getByRole('button', { name: 'Apps' })).toBeInTheDocument();
    // Initials as decoration, the name only for screen readers (WCAG 2.5.3).
    const avatar = getByRole('button', { name: 'Doe, Jane' });
    expect(avatar).not.toHaveAttribute('aria-label');
    expect(getByText('DJ')).toHaveAttribute('aria-hidden', 'true');
    expect(getByText('Roedy Mail')).toBeInTheDocument();
  });

  it('connects bell and avatar with their popups (disclosure pattern)', async () => {
    const accountPop = createRawSnippet((id: () => string) => ({
      render: () => `<div id="${id()}"><button>Manage account</button></div>`,
    }));
    const { getByRole, rerender } = render(Header, { ...values(), accountPop });
    const bell = getByRole('button', { name: 'Notifications, 2 new' });
    const avatar = getByRole('button', { name: 'Doe, Jane' });
    expect(bell).toHaveAttribute('aria-expanded', 'false');
    expect(avatar).toHaveAttribute('aria-expanded', 'false');
    expect(avatar).not.toHaveAttribute('aria-controls');
    await rerender({ ...values({ bellOpen: true }), accountPop });
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    await rerender({ ...values({ accountOpen: true }), accountPop });
    const manage = getByRole('button', { name: 'Manage account' });
    expect(document.getElementById(avatar.getAttribute('aria-controls') ?? '')).toContainElement(manage);
  });

  it('puts focus back on its toggle with Escape in the popup', async () => {
    const accountPop = createRawSnippet(() => ({ render: () => '<div><button>Manage account</button></div>' }));
    const bellPop = createRawSnippet(() => ({
      render: () => '<div><button>Mark all as read</button></div>',
    }));
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    try {
      const { getByRole, rerender } = render(Header, { ...values({ accountOpen: true }), accountPop, bellPop });
      const manage = getByRole('button', { name: 'Manage account' });
      manage.focus();
      await fireEvent.keyDown(manage, { key: 'Escape' });
      expect(getByRole('button', { name: 'Doe, Jane' })).toHaveFocus();
      // Closing stays with the layout: the key goes on.
      expect(onWindow).toHaveBeenCalledOnce();
      await rerender({ ...values({ bellOpen: true }), accountPop, bellPop });
      const markAll = getByRole('button', { name: 'Mark all as read' });
      markAll.focus();
      await fireEvent.keyDown(markAll, { key: 'Tab' });
      expect(markAll).toHaveFocus();
      await fireEvent.keyDown(markAll, { key: 'Escape' });
      expect(getByRole('button', { name: 'Notifications, 2 new' })).toHaveFocus();
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });

  it('shows the popovers of apps and account only while they are open', async () => {
    const appsPop = createRawSnippet(() => ({ render: () => '<div>Apps popover</div>' }));
    const accountPop = createRawSnippet(() => ({ render: () => '<div>Account menu</div>' }));
    const toggleApps = vi.fn();
    const { queryByText, getByRole, rerender } = render(Header, { ...values(), appsPop, accountPop, toggleApps });
    expect(queryByText('Apps popover')).toBeNull();
    expect(queryByText('Account menu')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Apps' }));
    expect(toggleApps).toHaveBeenCalled();
    await rerender({ ...values({ appsOpen: true }), appsPop, accountPop, toggleApps });
    expect(queryByText('Apps popover')).toBeInTheDocument();
    expect(getByRole('button', { name: 'Apps' })).toHaveAttribute('aria-expanded', 'true');
    await rerender({ ...values({ accountOpen: true }), appsPop, accountPop, toggleApps });
    expect(queryByText('Apps popover')).toBeNull();
    expect(queryByText('Account menu')).toBeInTheDocument();
  });

  it('hides administration for users without administrator rights', () => {
    const { queryByRole } = render(Header, values({ showAdmin: false }));
    expect(queryByRole('button', { name: 'Administration' })).toBeNull();
  });

  it('shows the clear button only with search text and reports input', async () => {
    const onSearch = vi.fn();
    const clearSearch = vi.fn();
    const { getByRole, queryByRole, rerender } = render(Header, { ...values(), onSearch, clearSearch });
    expect(queryByRole('button', { name: 'Clear search' })).toBeNull();
    await fireEvent.input(getByRole('combobox'), { target: { value: 'Invoice' } });
    expect(onSearch).toHaveBeenCalled();
    await rerender({ ...values({ hdrQ: 'Invoice', hdrHasQ: true }), onSearch, clearSearch });
    await fireEvent.click(getByRole('button', { name: 'Clear search' }));
    expect(clearSearch).toHaveBeenCalled();
  });

  it('marks open menus and the active page', () => {
    const { getByRole } = render(
      Header,
      values({
        accountOpen: true,
        settingsOn: true,
        sfBtn: { aria: 'Filters, 2 active', exp: false, fill: false, hasN: true, n: '2' },
      }),
    );
    expect(getByRole('button', { name: 'Doe, Jane' })).toHaveClass('ring');
    expect(getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(getByRole('button', { name: 'Filters, 2 active' })).toHaveClass('on');
  });

  it('fills the filter button while the search suggestions are open in filter mode', async () => {
    const { getByRole, rerender } = render(Header, values());
    const btn = getByRole('button', { name: 'Filter' });
    expect(btn).not.toHaveClass('fill');
    await rerender(
      values({ resOpen: true, resExp: true, sfBtn: { aria: 'Filter', exp: true, fill: true, hasN: false, n: '0' } }),
    );
    expect(btn).toHaveClass('fill');
    expect(btn).toHaveClass('on');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the filter button --mfg while only the search page panel is open, --deep with filters', async () => {
    const { getByRole, rerender } = render(
      Header,
      values({ sfBtn: { aria: 'Filter', exp: true, fill: false, hasN: false, n: '0' } }),
    );
    const btn = getByRole('button', { name: 'Filter' });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).not.toHaveClass('on');
    expect(btn).not.toHaveClass('fill');
    await rerender(values({ sfBtn: { aria: 'Filters, 1 active', exp: true, fill: false, hasN: true, n: '1' } }));
    expect(getByRole('button', { name: 'Filters, 1 active' })).toHaveClass('on');
    expect(getByRole('button', { name: 'Filters, 1 active' })).not.toHaveClass('fill');
  });

  it('shows the search suggestions only with resOpen, with the list behind aria-controls', async () => {
    const { getByRole, queryByRole, rerender } = render(Header, values());
    expect(queryByRole('dialog', { name: 'Search' })).toBeNull();
    await rerender(values({ resOpen: true, resExp: true }));
    const pop = getByRole('dialog', { name: 'Search' });
    const input = getByRole('combobox');
    expect(input).toHaveAttribute('aria-expanded', 'true');
    const list = document.getElementById(input.getAttribute('aria-controls') ?? '');
    expect(list).toHaveAttribute('role', 'listbox');
    expect(pop).toContainElement(list);
    await rerender(values());
    expect(queryByRole('dialog', { name: 'Search' })).toBeNull();
  });

  it('gives arrow keys and Enter first to the search suggestions, otherwise to onSearchKey', async () => {
    search.recent = ['anna', 'invoice'];
    const onSearchKey = vi.fn();
    const { getByRole } = render(Header, { ...values({ resOpen: true, resExp: true }), onSearchKey });
    const input = getByRole('combobox');
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    const option = within(getByRole('listbox')).getByRole('option', { name: 'anna' });
    expect(option).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', option.id);
    // Cyclic: from the first row upwards to the last.
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    const last = within(getByRole('listbox')).getByRole('option', { name: 'invoice' });
    expect(input).toHaveAttribute('aria-activedescendant', last.id);
    expect(onSearchKey).not.toHaveBeenCalled();
    // Enter on the marked row takes the text; the header does not call onSearchKey.
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(search.q).toBe('invoice');
    expect(onSearchKey).not.toHaveBeenCalled();
    // Afterwards nothing is marked: Enter goes to the header.
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSearchKey).toHaveBeenCalledOnce();
    expect(input).not.toHaveAttribute('aria-activedescendant');
  });

  it('closes the search suggestions when focus leaves search field and suggestions', async () => {
    const closeSuggestions = vi.fn();
    const { getByRole, rerender } = render(Header, { ...values(), closeSuggestions });
    const input = getByRole('combobox');
    const bell = getByRole('button', { name: 'Notifications, 2 new' });
    // Closed: nothing to do.
    await fireEvent.focusOut(input, { relatedTarget: bell });
    expect(closeSuggestions).not.toHaveBeenCalled();
    await rerender({ ...values({ resOpen: true, resExp: true }), closeSuggestions });
    // Inside (filter button) and without a target (window loses focus) they stay open.
    await fireEvent.focusOut(input, { relatedTarget: getByRole('button', { name: 'Filter' }) });
    await fireEvent.focusOut(input, { relatedTarget: null });
    expect(closeSuggestions).not.toHaveBeenCalled();
    await fireEvent.focusOut(input, { relatedTarget: bell });
    expect(closeSuggestions).toHaveBeenCalledOnce();
  });

  it('shows only logo, notifications and avatar on mobile', async () => {
    const openAccountSheet = vi.fn();
    const { getByRole, queryByRole } = render(Header, { ...values({ isMobile: true }), openAccountSheet });
    expect(queryByRole('combobox')).toBeNull();
    expect(queryByRole('button', { name: 'Administration' })).toBeNull();
    expect(getByRole('button', { name: 'Notifications, 2 new' })).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Doe, Jane' }));
    expect(openAccountSheet).toHaveBeenCalled();
  });
});
