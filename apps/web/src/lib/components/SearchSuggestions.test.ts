import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import type { Candidate, MailHit, SearchActions } from '#lib/search.ts';
import type { SearchScope } from '#lib/search-filter.ts';
import type { MailPage } from '#lib/state/search.svelte.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { contacts } from '#lib/state/contacts.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { search } from '#lib/state/search.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import SearchSuggestions from './SearchSuggestions.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

// Local scopes come from `search-items` (own tests).
const local = vi.hoisted(() => ({ candidates: [] as Candidate[] }));
vi.mock('#lib/search-items.ts', () => ({
  searchCandidates: () => local.candidates,
  hitBox: () => ({ label: 'Inbox', role: 'inbox', target: { role: 'inbox' } }),
}));

// The real state with a mail server to control.
const server = vi.hoisted(() => ({ page: vi.fn<(...args: unknown[]) => Promise<MailPage>>() }));
vi.mock('#lib/state/search.svelte.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('#lib/state/search.svelte.ts')>();
  return {
    ...mod,
    search: new mod.Search(
      { page: (...args) => server.page(...args), counts: () => Promise.resolve([]) },
      undefined,
      () => Promise.resolve(),
    ),
  };
});

function account(id: string): MailAccount {
  return {
    id,
    email: `${id}@example.com`,
    username: `${id}@example.com`,
    url: 'https://mail.example.com',
    host: 'mail.example.com',
    server_id: 's1',
    auth_kind: 'oauth',
    color: 0,
    state: 'ok',
    blocked: false,
    quota_used: null,
    quota_total: null,
    last_check_at: null,
    created_at: '2026-10-27T10:00:00Z',
  };
}

function person(i: number, name: string, run = vi.fn()): Candidate {
  return {
    id: `c${i}`,
    cat: 'contacts',
    label: name,
    icon: 'ti-user',
    av: { text: name.slice(0, 2).toUpperCase(), bg: '#e8d5c4', ink: '#3d2a00' },
    path: `contact${i}@example.com`,
    extra: '',
    run,
  };
}

function item(cat: Candidate['cat'], i: number, label: string, patch: Partial<Candidate> = {}): Candidate {
  return {
    id: `${cat}${i}`,
    cat,
    label,
    icon: 'ti-settings',
    path: 'Settings',
    extra: '',
    run: vi.fn(),
    ...patch,
  };
}

function hit(id: string, subject: string): MailHit {
  return {
    account: 'a1',
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    receivedAt: '2026-11-01T09:30:00Z',
    from: [{ name: 'Anna Brown', email: 'anna@example.com' }],
    to: [{ name: 'Me', email: 'a1@example.com' }],
    subject,
    attachments: [],
    snippet: null,
  };
}

const answer = (hits: MailHit[], total = hits.length) =>
  server.page.mockResolvedValue({ hits, positions: hits.length, total });

const SETTINGS_SCOPE: SearchScope = { here: 'Settings only', icon: 'ti-settings', patch: { cats: ['settings'] } };

let input: HTMLInputElement;

function show(props: { onAll?: () => void } = {}) {
  return render(SearchSuggestions, { listId: 'res', input, ...props });
}

const key = (k: string) => new KeyboardEvent('keydown', { key: k, cancelable: true });
/** The component's `key()`; the type by hand, because ESLint does not know the exports of Svelte components. */
const press = (view: { component: unknown }, event: KeyboardEvent) =>
  (view.component as { key: (event: KeyboardEvent) => boolean }).key(event);

beforeEach(() => {
  accounts.list = [account('a1')];
  vi.spyOn(contacts, 'ensure').mockResolvedValue();
  search.actions = {} as SearchActions;
  local.candidates = [];
  answer([]);
  input = document.createElement('input');
  document.body.append(input);
  ui.menu = 'results';
});

afterEach(() => {
  input.remove();
  vi.restoreAllMocks();
  server.page.mockReset();
  search.reset();
  search.actions = null;
  search.context = null;
  search.scope = 'here';
  network.simulate(false);
  accounts.reset();
  contacts.reset();
  ui.reset();
});

describe('search suggestions', () => {
  it('shows "Recent searches" (at most four) and the operators when idle', async () => {
    search.recent = ['anna', 'invoice', 'vacation', 'contract', 'old'];
    const view = show();
    const pop = view.getByRole('dialog', { name: 'Search' });
    expect(within(pop).getByText('Search')).toHaveClass('title');
    expect(view.container.querySelector('.count')).toBeNull();
    const list = view.getByRole('listbox', { name: 'Search results' });
    expect(list).toHaveAttribute('id', 'res');
    expect(view.getByText('Recent searches')).toBeInTheDocument();
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim()),
    ).toEqual(['anna', 'invoice', 'vacation', 'contract']);
    expect(view.getByText('Search operators')).toBeInTheDocument();
    const ops = ['from:', 'tag:', 'in:', 'is:unread', 'has:attachment'];
    for (const op of ops) expect(view.getByRole('button', { name: op })).toBeInTheDocument();
    // No footer without rows.
    expect(view.queryByRole('button', { name: 'All results' })).toBeNull();

    // × removes the entry without running it.
    await fireEvent.click(view.getAllByRole('button', { name: 'Remove from history' })[1]!);
    expect(search.recent).toEqual(['anna', 'vacation', 'contract', 'old']);
    expect(search.q).toBe('');

    // An entry takes the text and focuses the field.
    await fireEvent.click(view.getByRole('option', { name: 'vacation' }));
    expect(search.q).toBe('vacation');
    expect(document.activeElement).toBe(input);
  });

  it('inserts an operator at the end and focuses the field', async () => {
    search.q = 'anna ';
    const view = show();
    search.q = '';
    await tick();
    await fireEvent.click(view.getByRole('button', { name: 'from:' }));
    expect(search.q).toBe('from:');
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it('shows quick filters and "Browse" in filter mode and toggles them', async () => {
    const view = show();
    const quick = view.getByRole('group', { name: 'Quick filters' });
    expect(
      within(quick)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Unread', 'Flagged', 'Attachment', 'Today', 'Last 7 days']);
    expect(within(quick).getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'false');
    await fireEvent.click(within(quick).getByRole('button', { name: 'Unread' }));
    expect(search.sf.st).toEqual(['u']);
    // With a filter the app searches: no longer idle, the filter sits as a chip at the top.
    await fireEvent.click(await view.findByRole('button', { name: 'Remove Unread' }));
    expect(search.sf.st).toEqual([]);

    const browse = await view.findByRole('group', { name: 'Browse' });
    // No administration without administrator rights.
    expect(within(browse).getAllByRole('button')).toHaveLength(8);
    expect(within(browse).queryByRole('button', { name: 'Administration' })).toBeNull();
    await fireEvent.click(within(browse).getByRole('button', { name: 'Messages' }));
    expect(search.sf.cats).toEqual(['mail']);
    expect(await view.findByRole('button', { name: 'Remove Messages only' })).toBeInTheDocument();
    expect(view.queryByRole('group', { name: 'Browse' })).toBeNull();
  });

  it('switches between "Only in …" and "Everywhere" via the segment', async () => {
    search.context = SETTINGS_SCOPE;
    local.candidates = [item('settings', 1, 'Appearance', { desc: 'Mode and accent color' }), person(1, 'Anna Brown')];
    const view = show();
    const tabs = view.getByRole('tablist', { name: 'Search scope' });
    const here = within(tabs).getByRole('tab', { name: 'Settings only' });
    const all = within(tabs).getByRole('tab', { name: 'Everywhere' });
    expect(here).toHaveAttribute('aria-selected', 'true');
    expect(all).toHaveAttribute('aria-selected', 'false');
    // Only in the settings: their hits, without quick filters; the subline is the description.
    const group = await view.findByRole('group', { name: 'Settings' });
    expect(within(group).getByText('Mode and accent color')).toHaveClass('sub');
    expect(view.queryByRole('group', { name: 'Contacts' })).toBeNull();
    expect(view.queryByRole('group', { name: 'Quick filters' })).toBeNull();

    await fireEvent.click(all);
    expect(search.scope).toBe('all');
    expect(all).toHaveAttribute('aria-selected', 'true');
    expect(view.getByRole('group', { name: 'Quick filters' })).toBeInTheDocument();

    // The segment counts set filters at "Everywhere".
    search.set({ st: ['u', 'st'] });
    await tick();
    expect(all.querySelector('.seg-n')).toHaveTextContent('2');
    await fireEvent.click(here);
    expect(search.scope).toBe('here');
  });

  it('groups the hits and caps them at nine rows', async () => {
    local.candidates = [
      ...Array.from({ length: 7 }, (_, i) => person(i, `Anna ${i}`)),
      ...Array.from({ length: 4 }, (_, i) => item('settings', i, `Anna Setting ${i}`)),
      ...Array.from({ length: 4 }, (_, i) => item('actions', i, `Anna Action ${i}`, { icon: 'ti-bolt' })),
    ];
    search.q = 'anna';
    const view = show();
    const contactsGroup = await view.findByRole('group', { name: 'Contacts' });
    expect(view.getByText('Search results')).toHaveClass('title');
    expect(view.getByText('15 results')).toHaveClass('count');
    // Three groups: three rows each; the group's number names all.
    expect(within(contactsGroup).getAllByRole('option')).toHaveLength(3);
    expect(within(contactsGroup).getByText('7')).toHaveClass('group-n');
    expect(within(view.getByRole('group', { name: 'Settings' })).getAllByRole('option')).toHaveLength(3);
    expect(within(view.getByRole('group', { name: 'Actions' })).getAllByRole('option')).toHaveLength(3);
    expect(view.getAllByRole('option')).toHaveLength(9);
    expect([...contactsGroup.querySelectorAll('.hl')].map((e) => e.textContent)).toEqual(['Anna', 'Anna', 'Anna']);
    // Avatars round with their own colors, tiles without colors from the tokens.
    expect(contactsGroup.querySelector('.tile')).toHaveClass('round');
    expect(contactsGroup.querySelector('.tile')).not.toHaveClass('plain');
    expect(view.getByRole('group', { name: 'Settings' }).querySelector('.tile')).toHaveClass('plain');
    expect(view.getByRole('button', { name: 'Show all 15' })).toBeInTheDocument();
  });

  it('shows up to nine rows with one group', async () => {
    local.candidates = Array.from({ length: 12 }, (_, i) => person(i, `Anna ${i}`));
    search.q = 'anna';
    const view = show();
    const group = await view.findByRole('group', { name: 'Contacts' });
    expect(within(group).getAllByRole('option')).toHaveLength(9);
    expect(within(group).getByText('12')).toHaveClass('group-n');
  });

  it('shows five rows per group with two groups, messages with a path', async () => {
    local.candidates = Array.from({ length: 7 }, (_, i) => person(i, `Anna ${i}`));
    answer([hit('m1', 'Meeting with Anna')]);
    search.q = 'anna';
    const view = show();
    const mail = await view.findByRole('group', { name: 'Messages' });
    expect(within(mail).getAllByRole('option')).toHaveLength(1);
    expect(within(view.getByRole('group', { name: 'Contacts' })).getAllByRole('option')).toHaveLength(5);
  });

  it('moves cyclically with the arrow keys and runs the marked row with Enter', async () => {
    const first = vi.fn();
    const second = vi.fn();
    local.candidates = [person(1, 'Anna Brown', first), person(2, 'Anna Short', second)];
    search.q = 'anna';
    const onAll = vi.fn();
    const view = show({ onAll });
    const options = async () => {
      await view.findByRole('group', { name: 'Contacts' });
      return view.getAllByRole('option');
    };
    expect((await options()).map((o) => o.getAttribute('aria-selected'))).toEqual(['false', 'false']);
    // Without a mark Enter stays with the search field.
    expect(press(view, key('Enter'))).toBe(false);
    expect(press(view, key('a'))).toBe(false);

    const down = key('ArrowDown');
    expect(press(view, down)).toBe(true);
    expect(down.defaultPrevented).toBe(true);
    await tick();
    expect((await options())[0]).toHaveAttribute('aria-selected', 'true');
    expect((await options())[0]).toHaveClass('sel');
    press(view, key('ArrowDown'));
    press(view, key('ArrowDown'));
    press(view, key('ArrowUp'));
    await tick();
    expect((await options())[1]).toHaveAttribute('aria-selected', 'true');

    // The mouse marks too.
    await fireEvent.mouseMove((await options())[0]!);
    expect((await options())[0]).toHaveAttribute('aria-selected', 'true');
    press(view, key('ArrowDown'));

    input.focus();
    const enter = key('Enter');
    expect(press(view, enter)).toBe(true);
    expect(enter.defaultPrevented).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    // `search.done()`: search remembered, text empty; the suggestions close, the field loses focus.
    expect([search.q, search.recent]).toEqual(['', ['anna']]);
    expect(ui.menu).toBeNull();
    expect(document.activeElement).not.toBe(input);
    expect(onAll).not.toHaveBeenCalled();
  });

  it('resets the mark as soon as text, filter or scope change', async () => {
    local.candidates = [person(1, 'Anna Brown'), person(2, 'Anna Short')];
    search.q = 'anna';
    const view = show();
    await view.findByRole('group', { name: 'Contacts' });
    press(view, key('ArrowDown'));
    await tick();
    expect(view.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    search.q = 'anna b';
    await tick();
    expect(view.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'false');
  });

  it('shows the action "Open command palette" with a key and without a subline', async () => {
    local.candidates = [
      item('actions', 1, 'Open command palette', {
        icon: 'ti-command',
        path: 'Keyboard shortcuts Ctrl K',
        k: 'Ctrl K',
      }),
    ];
    search.q = 'command palette';
    const view = show();
    const row = within(await view.findByRole('group', { name: 'Actions' })).getByRole('option');
    expect(within(row).getByText('Ctrl K')).toHaveClass('key');
    expect(row.querySelector('.sub')).toBeNull();
    expect(row).not.toHaveTextContent('Keyboard shortcuts');
  });

  it('shows the empty state without hits with and without search text', async () => {
    answer([], 0);
    search.q = 'zzz';
    const view = show();
    expect(await view.findByText(m.search_suggest_empty_q({ q: 'zzz' }))).toBeInTheDocument();
    expect(view.getByText('Check the spelling or try a different search term.')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'All results' })).toBeNull();

    search.q = '';
    search.set({ st: ['u'] });
    expect(await view.findByText('No results for these filters')).toBeInTheDocument();
    expect(view.getByText('Try fewer filters or a different search term.')).toBeInTheDocument();
  });

  it('shows no empty state as long as the first response is missing', async () => {
    server.page.mockReturnValue(new Promise(() => {}));
    search.q = 'anna';
    const view = show();
    await tick();
    await new Promise((done) => setTimeout(done, 300));
    expect(server.page).toHaveBeenCalled();
    expect(view.queryByText(m.search_suggest_empty_q({ q: 'anna' }))).toBeNull();
  });

  it('shows its own empty text offline without hits', async () => {
    network.simulate(true);
    answer([], 0);
    search.q = 'zzz';
    const view = show();
    expect(
      await view.findByText('Not all messages are saved offline. Once you’re back online, you may find more.'),
    ).toHaveClass('empty-text');
  });

  it('removes filters via their chips', async () => {
    search.set({ st: ['u'] });
    const view = show();
    const chip = view.getByRole('button', { name: 'Remove Unread' });
    expect(chip).toHaveClass('chip');
    await fireEvent.click(chip);
    expect(search.sf.st).toEqual([]);
    expect(view.queryByRole('button', { name: 'Remove Unread' })).toBeNull();
  });

  it('opens the results with "Show all ‹n›" and takes focus from the field', async () => {
    local.candidates = [person(1, 'Anna Brown'), person(2, 'Anna Short')];
    search.q = 'anna';
    const onAll = vi.fn();
    const view = show({ onAll });
    input.focus();
    await fireEvent.click(await view.findByRole('button', { name: 'Show all 2' }));
    expect(onAll).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(input);
  });

  it('closes via "Close"', async () => {
    const view = show();
    await fireEvent.click(view.getByRole('button', { name: 'Close' }));
    expect(ui.menu).toBeNull();
  });
});
