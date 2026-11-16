import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { folderKey, SF0, type FilterEnv } from '#lib/search-filter.ts';
import { searchCats } from '#lib/search.ts';
import { type Contact, contacts } from '#lib/state/contacts.svelte.ts';
import { search } from '#lib/state/search.svelte.ts';
import SearchFilters from './SearchFilters.svelte';

const ENV: FilterEnv = {
  accounts: [
    { id: 'k1', email: 'anna@example.com', color: 2 },
    { id: 'k2', email: 'team@example.org', color: 1 },
  ],
  allowed: searchCats(false),
  folders: [
    { key: 'role:inbox', label: 'Inbox', icon: 'ti-inbox' },
    { key: 'role:trash', label: 'Trash', icon: 'ti-trash' },
    { key: folderKey('k1', 'p1'), label: 'Projects', path: [] },
    { key: folderKey('k1', 'p1a'), label: 'Old', path: ['Projects'] },
  ],
  tags: [
    { id: 't1', label: 'Work', color: 3, path: [] },
    { id: 't1a', label: 'Customer A', color: 3, path: ['Work'] },
  ],
  folderBoxes: () => [],
  tagBoxes: () => [],
  tz: 'Europe/Berlin',
};

// The real state with fixed filter values instead of the mailboxes.
const fx = vi.hoisted(() => ({ env: null as unknown as FilterEnv }));
vi.mock('#lib/state/search.svelte.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('#lib/state/search.svelte.ts')>();
  return {
    ...mod,
    search: new mod.Search(
      { page: () => Promise.resolve({ hits: [], positions: 0, total: 0 }), counts: () => Promise.resolve([]) },
      () => fx.env,
      () => Promise.resolve(),
    ),
  };
});

const contact = (name: string, email: string): Contact => ({
  name,
  email,
  count: 1,
  at: 0,
  match: `${name}\n${email}`.toLowerCase(),
});

let ensure: MockInstance<() => Promise<void>>;

beforeEach(() => {
  fx.env = ENV;
  ensure = vi.spyOn(contacts, 'ensure').mockResolvedValue();
  contacts.list = [contact('Anna Bell', 'anna@example.com'), contact('Joe Miller', 'joe@example.org')];
});

afterEach(() => {
  vi.restoreAllMocks();
  contacts.list = [];
  search.reset();
});

/** Visible text without the spaces of the markup. */
const txt = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim();

function setup(props: { total?: number; idle?: boolean } = {}) {
  const close = vi.fn();
  const view = render(SearchFilters, { total: 0, idle: true, close, ...props });
  const row = (label: string) => view.getByRole('button', { name: new RegExp(`^${label}`) });
  const cta = () => view.getByRole('button', { name: /Choose filters|result/ });
  return { view, close, row, cta };
}

describe('search filters', () => {
  it('shows status, period and the narrowing rows', async () => {
    const { view, row, cta, close } = setup();
    expect(ensure).toHaveBeenCalled();
    expect(view.getByText('Filters')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Reset' })).toHaveAttribute('aria-disabled', 'true');
    const states = within(view.getByRole('group', { name: 'Status' })).getAllByRole('button');
    expect(states.map((b) => [txt(b), b.getAttribute('aria-pressed')])).toEqual([
      ['Unread', 'false'],
      ['Flagged', 'false'],
      ['Attachment', 'false'],
    ]);
    const times = within(view.getByRole('radiogroup', { name: 'Date' })).getAllByRole('radio');
    expect(times.map((b) => [txt(b), b.getAttribute('aria-checked')])).toEqual([
      ['Any time', 'true'],
      ['Today', 'false'],
      ['7 days', 'false'],
      ['30 days', 'false'],
      ['This year', 'false'],
    ]);
    expect(view.getByText('Refine')).toBeInTheDocument();
    expect(row('Category')).toHaveTextContent('Category Everywhere');
    expect(row('Account')).toHaveTextContent('Account All accounts');
    expect(row('Folder')).toHaveTextContent('Folder All folders');
    expect(row('Tags')).toHaveTextContent('Tags All tags');
    expect(row('Sender')).toHaveTextContent('Sender Any sender');
    expect(row('Search in')).toHaveTextContent('Search in All fields');
    expect(view.queryByRole('button', { name: /^Status/ })).toBeNull();
    expect(row('Category')).not.toHaveClass('set');
    expect(cta()).toHaveTextContent('Choose filters');
    expect(cta()).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.click(cta());
    expect(close).not.toHaveBeenCalled();
  });

  it('no "Account" row without several accounts', () => {
    fx.env = { ...ENV, accounts: [ENV.accounts[0]!] };
    const { view } = setup();
    expect(view.queryByRole('button', { name: /^Account/ })).toBeNull();
  });

  it('chips set filters, counter and "Reset" clears everything', async () => {
    const { view } = setup();
    await fireEvent.click(view.getByRole('button', { name: 'Unread' }));
    await fireEvent.click(view.getByRole('button', { name: 'Attachment' }));
    await fireEvent.click(view.getByRole('radio', { name: '7 days' }));
    expect(search.sf.st).toEqual(['u', 'at']);
    expect(search.sf.time).toBe('7d');
    expect(view.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    expect(view.getByRole('radio', { name: '7 days' })).toHaveAttribute('aria-checked', 'true');
    expect(view.getByText(String(search.chips.length))).toHaveClass('badge');
    expect(search.chips.length).toBeGreaterThan(0);
    const reset = view.getByRole('button', { name: 'Reset' });
    expect(reset).toHaveAttribute('aria-disabled', 'false');
    await fireEvent.click(view.getByRole('button', { name: 'Unread' }));
    expect(search.sf.st).toEqual(['at']);
    search.set({ cats: ['mail'] });
    await fireEvent.click(reset);
    expect(search.sf).toEqual(SF0);
    expect(reset).toHaveAttribute('aria-disabled', 'true');
    expect(view.container.querySelector('.badge')).toBeNull();
  });

  it('bottom button by hit count; it closes only with hits', async () => {
    const none = setup({ idle: false, total: 0 });
    expect(none.cta()).toHaveTextContent('No results');
    expect(none.cta()).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.click(none.cta());
    expect(none.close).not.toHaveBeenCalled();
    none.view.unmount();

    const one = setup({ idle: false, total: 1 });
    expect(one.cta()).toHaveTextContent('Show 1 result');
    one.view.unmount();

    const many = setup({ idle: false, total: 12 });
    expect(many.cta()).toHaveTextContent('Show 12 results');
    expect(many.cta()).toHaveAttribute('aria-disabled', 'false');
    await fireEvent.click(many.cta());
    expect(many.close).toHaveBeenCalledOnce();
  });

  it('multiple choice: subpage stays open, "Done" and back lead to the list', async () => {
    const { view, row } = setup();
    await fireEvent.click(row('Category'));
    expect(view.queryByText('Refine')).toBeNull();
    const list = view.getByRole('listbox', { name: 'Category' });
    expect(list).toHaveAttribute('aria-multiselectable', 'true');
    const opts = within(list).getAllByRole('option');
    expect(opts.map(txt)).toEqual([
      'Everywhere',
      'Messages',
      'Contacts',
      'Attachments',
      'Folders',
      'Tags',
      'Settings',
      'Actions',
      'Notifications',
    ]);
    expect(opts[0]).toHaveAttribute('aria-selected', 'true');
    await fireEvent.click(opts[1]!);
    await fireEvent.click(within(list).getByRole('option', { name: 'Attachments' }));
    expect(search.sf.cats).toEqual(['mail', 'files']);
    expect(within(list).getByRole('option', { name: 'Messages' })).toHaveAttribute('aria-selected', 'true');
    expect(within(list).getByRole('option', { name: 'Everywhere' })).toHaveAttribute('aria-selected', 'false');
    await fireEvent.click(view.getByRole('button', { name: 'Done' }));
    expect(row('Category')).toHaveTextContent('Category Messages & Attachments');
    expect(row('Category')).toHaveClass('set');

    await fireEvent.click(row('Tags'));
    expect(view.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    const tags = within(view.getByRole('listbox', { name: 'Tags' })).getAllByRole('option');
    // Indent: "All tags" 10 px, tags 13 px plus 16 px per level.
    expect(tags.map((o) => [txt(o), o.style.getPropertyValue('--pl')])).toEqual([
      ['All tags', '10px'],
      ['Work', '13px'],
      ['Customer A', '29px'],
    ]);
    expect(tags[1]!.querySelector('.dot')).not.toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Back to filters' }));
    expect(view.getByText('Refine')).toBeInTheDocument();
  });

  it('single choice: without "Done", the choice leads back to the list', async () => {
    const { view, row } = setup();
    await fireEvent.click(row('Folder'));
    expect(view.queryByRole('button', { name: 'Done' })).toBeNull();
    const list = view.getByRole('listbox', { name: 'Folder' });
    expect(list).toHaveAttribute('aria-multiselectable', 'false');
    const opts = within(list).getAllByRole('option');
    expect(opts.map((o) => [txt(o), o.style.getPropertyValue('--pl')])).toEqual([
      ['All folders', '10px'],
      ['Inbox', '10px'],
      ['Trash', '10px'],
      ['Projects', '10px'],
      ['Old', '26px'],
    ]);
    await fireEvent.click(opts[1]!);
    expect(search.sf.folder).toBe('role:inbox');
    expect(view.queryByRole('listbox')).toBeNull();
    expect(row('Folder')).toHaveTextContent('Folder Inbox');

    await fireEvent.click(row('Account'));
    const accts = within(view.getByRole('listbox', { name: 'Account' })).getAllByRole('option');
    expect(accts.map((o) => !!o.querySelector('.dot'))).toEqual([false, true, true]);
    await fireEvent.click(accts[2]!);
    expect(search.sf.account).toBe('k2');
    expect(row('Account')).toHaveTextContent('Account team@example.org');
  });

  it('sender: field sets the filter, suggestions with avatar', async () => {
    const { view, row } = setup();
    await fireEvent.click(row('Sender'));
    const input = view.getByRole('textbox', { name: 'Sender' });
    expect(input).toHaveAttribute('placeholder', 'Name or email address');
    expect(within(view.getByRole('listbox', { name: 'Sender' })).getAllByRole('option')).toHaveLength(3);
    await fireEvent.input(input, { target: { value: 'jo' } });
    expect(search.sf.from).toBe('jo');
    const opts = within(view.getByRole('listbox', { name: 'Sender' })).getAllByRole('option');
    expect(opts.map(txt)).toEqual(['Any sender', 'JM Joe Miller']);
    expect(opts[1]!.querySelector('.av')).toHaveTextContent('JM');
    await fireEvent.click(opts[1]!);
    expect(search.sf.from).toBe('joe@example.org');
    expect(view.queryByRole('textbox')).toBeNull();
    expect(row('Sender')).toHaveTextContent('Sender joe@example.org');
  });
});
