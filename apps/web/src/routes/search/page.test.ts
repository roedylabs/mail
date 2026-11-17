import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { searchCats, type Candidate, type MailHit, type SearchActions } from '#lib/search.ts';
import { type FilterEnv, folderKey, SF0 } from '#lib/search-filter.ts';
import type { MailPage } from '#lib/state/search.svelte.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { contacts } from '#lib/state/contacts.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { search } from '#lib/state/search.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

const nav = vi.hoisted(() => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));

// Local areas and folders of an email come from `search-items` (own tests).
const local = vi.hoisted(() => ({ candidates: [] as Candidate[] }));
// Notifications of the bell: none, without a fetch.
vi.mock('#lib/state/notifications.svelte.ts', () => ({ notifications: { list: [], load: vi.fn() } }));

vi.mock('#lib/search-items.ts', () => ({
  searchCandidates: () => local.candidates,
  notifItems: () => [],
  hitBox: () => ({ label: 'Inbox', role: 'inbox', target: { role: 'inbox' } }),
}));

// The real state with a mail server to control.
const server = vi.hoisted(() => ({ page: vi.fn<(...args: unknown[]) => Promise<MailPage>>() }));
vi.mock('#lib/state/search.svelte.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('#lib/state/search.svelte.ts')>();
  return {
    ...mod,
    // Without mailboxes and counters; the tests set the tiles via `tileCounts`.
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

function hit(id: string, subject: string): MailHit {
  return {
    account: 'a1',
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords: { $seen: true },
    receivedAt: '2026-11-01T09:30:00Z',
    from: [{ name: 'Anna Berg', email: 'anna@example.com' }],
    to: [{ name: 'Me', email: 'a1@example.com' }],
    subject,
    attachments: [],
    snippet: null,
  };
}

const answer = (hits: MailHit[], total = hits.length) =>
  server.page.mockResolvedValue({ hits, positions: hits.length, total });

function mobile() {
  vi.stubGlobal('innerWidth', 390);
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => {
  accounts.list = [account('a1')];
  vi.spyOn(contacts, 'ensure').mockResolvedValue();
  search.actions = {} as SearchActions;
  local.candidates = [];
  answer([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.dispatchEvent(new Event('resize'));
  vi.restoreAllMocks();
  nav.goto.mockClear();
  server.page.mockReset();
  search.reset();
  search.actions = null;
  network.simulate(false);
  accounts.reset();
  contacts.reset();
  ui.reset();
});

describe('Search', () => {
  it('does not move the focus on desktop', () => {
    vi.useFakeTimers();
    try {
      render(Page);
      vi.advanceTimersByTime(30);
      expect(document.activeElement).toBe(document.body);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the hint and no areas when idle', () => {
    const view = render(Page);
    expect(view.getByText('Search results')).toBeInTheDocument();
    expect(view.getByRole('heading', { level: 1, name: 'Filtered search' })).toBeInTheDocument();
    expect(view.getByText('Enter a search term or choose filters.')).toBeInTheDocument();
    expect(within(view.getByRole('toolbar', { name: 'Categories' })).queryAllByRole('button')).toHaveLength(0);
    expect(server.page).not.toHaveBeenCalled();
  });

  it('shows pills and groups with the search term highlighted', async () => {
    local.candidates = [person(1, 'Anna Berg')];
    answer([hit('m1', 'Meeting with Anna')]);
    search.q = 'anna';
    const view = render(Page);
    await waitFor(() => expect(view.getByRole('heading', { level: 2, name: 'Messages' })).toBeInTheDocument());
    expect(view.getByRole('heading', { level: 2, name: 'Contacts' })).toBeInTheDocument();
    expect(view.getByRole('heading', { level: 1, name: '“anna”' })).toBeInTheDocument();
    expect(view.getByText('2 results')).toBeInTheDocument();
    const pills = within(view.getByRole('toolbar', { name: 'Categories' })).getAllByRole('button');
    expect(pills.map((p) => p.textContent)).toEqual(['All2', 'Messages1', 'Contacts1']);
    expect(pills[0]).toHaveAttribute('aria-pressed', 'true');
    expect([...view.container.querySelectorAll('.hl')].map((e) => e.textContent)).toEqual(['Anna', 'Anna']);
  });

  it('selects the area via a pill', async () => {
    local.candidates = [person(1, 'Anna Berg')];
    answer([hit('m1', 'Meeting with Anna')]);
    search.q = 'anna';
    const view = render(Page);
    // The skeleton shows until the mail server answers.
    const toolbar = await view.findByRole('toolbar', { name: 'Categories' });
    await waitFor(() => expect(within(toolbar).getAllByRole('button')).toHaveLength(3));
    await fireEvent.click(within(toolbar).getByText('Contacts'));
    expect(search.sf.cats).toEqual(['contacts']);
    await waitFor(() => expect(view.queryByRole('heading', { level: 2, name: 'Messages' })).toBeNull());
    expect(within(toolbar).getByText('Contacts').closest('button')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows five rows per area and the whole area with “Show all ‹n›”', async () => {
    local.candidates = Array.from({ length: 7 }, (_, i) => person(i, `Anna ${i}`));
    answer([hit('m1', 'Meeting with Anna')]);
    search.q = 'anna';
    const view = render(Page);
    const more = await view.findByRole('button', { name: 'Show all 7' });
    expect(view.getAllByText(/^contact\d@example\.com$/)).toHaveLength(5);
    await fireEvent.click(more);
    expect(search.sf.cats).toEqual(['contacts']);
    await waitFor(() => expect(view.getAllByText(/^contact\d@example\.com$/)).toHaveLength(7));
    expect(view.queryByRole('button', { name: 'Show all 7' })).toBeNull();
  });

  it('runs a row, remembers the search and opens a message in its folder', async () => {
    const run = vi.fn();
    local.candidates = [person(1, 'Anna Berg', run)];
    answer([hit('m1', 'Meeting with Anna')]);
    search.q = 'anna';
    const view = render(Page);
    await fireEvent.click(await view.findByText('contact1@example.com'));
    expect(run).toHaveBeenCalledOnce();
    expect(search.q).toBe('');
    expect(search.recent).toEqual(['anna']);

    search.q = 'anna';
    await waitFor(() => expect(view.getByRole('heading', { level: 2, name: 'Messages' })).toBeInTheDocument());
    await fireEvent.click(view.getByText(/^Anna Berg · Inbox$/));
    expect(nav.goto).toHaveBeenCalledWith('/mailbox/a1/inbox/t-m1');
  });

  it('an opened hit remembers the search as "Search results", on mobile as "Search"', async () => {
    const THREAD = '/mailbox/a1/inbox/t-m1';
    for (const [setup, kind] of [
      [() => {}, 'results'],
      [mobile, 'search'],
    ] as const) {
      setup();
      answer([hit('m1', 'Meeting with Anna')]);
      search.q = 'anna';
      search.set({ st: ['u'] });
      const view = render(Page);
      await fireEvent.click(await view.findByText(/^Anna Berg · Inbox$/));
      // The layout reports the navigation the hit started (`beforeNavigate`).
      search.navigating(THREAD, true);
      expect(search.ret).toMatchObject({ kind, target: THREAD, snap: { q: 'anna', sf: { st: ['u'] } } });
      view.unmount();
      search.reset();
    }
  });

  it('removes the “From” filter via its chip', async () => {
    answer([hit('m1', 'Meeting')]);
    search.searchFrom('anna@example.com');
    // The chips only show without the filter panel.
    search.panelHidden = true;
    const view = render(Page);
    const chip = await view.findByRole('button', { name: 'Remove From: anna@example.com' });
    expect(view.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
    await fireEvent.click(chip);
    expect(search.sf.from).toBe('');
    expect(search.sf.cats).toEqual(['mail']);
  });

  it('shows the empty state without hits and resets the filters', async () => {
    answer([], 0);
    search.searchFrom('nobody@example.com');
    const view = render(Page);
    expect(await view.findByText('No results', { selector: '.empty-title' })).toBeInTheDocument();
    expect(view.getByText('Try fewer filters or a different search term.')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Clear filters' }));
    expect(search.sf).toEqual(SF0);
  });

  it('shows the skeleton until the mail server answers', async () => {
    server.page.mockReturnValue(new Promise(() => {}));
    search.q = 'anna';
    const view = render(Page);
    expect(await view.findByRole('status', { name: 'Loading search results' })).toBeInTheDocument();
    expect(view.queryByRole('toolbar')).toBeNull();
  });

  it('closes the results to the return path, otherwise to the start page', async () => {
    search.back = '/mailbox/a1/inbox';
    search.set({ cats: ['contacts'] });
    const view = render(Page);
    await fireEvent.click(view.getByRole('button', { name: 'Close search results' }));
    expect(nav.goto).toHaveBeenLastCalledWith('/mailbox/a1/inbox');
    expect(search.sf.cats).toEqual([]);
    await fireEvent.click(view.getByRole('button', { name: 'Close search results' }));
    expect(nav.goto).toHaveBeenLastCalledWith('/start');
  });

  describe('offline', () => {
    const HINT = 'While offline, you can only search saved messages by subject, sender, and preview.';
    const EMPTY = 'Not all messages are saved offline. Once you’re back online, you may find more.';
    const saved = (hits: MailHit[]) =>
      server.page.mockResolvedValue({ hits, positions: hits.length, total: hits.length, local: true });

    it('shows no notice while the server answers', async () => {
      answer([hit('m1', 'Meeting')]);
      search.q = 'meeting';
      const view = render(Page);
      await view.findByRole('heading', { level: 2, name: 'Messages' });
      expect(view.queryByText(HINT)).toBeNull();
    });

    it('shows the notice above the hits without a connection', async () => {
      network.simulate(true);
      answer([hit('m1', 'Meeting')]);
      search.q = 'meeting';
      const view = render(Page);
      const note = (await view.findByText(HINT)).closest<HTMLElement>('[role="status"]')!;
      expect(note).toHaveClass('off-hint');
      expect(note.querySelector('.tabler-icon-cloud-off')).not.toBeNull();
      expect(note.closest('.head-text')).not.toBeNull();
    });

    it('shows the notice for hits from storage too, when the browser reports online', async () => {
      saved([hit('m1', 'Meeting')]);
      search.q = 'meeting';
      const view = render(Page);
      expect(await view.findByText(HINT)).toBeInTheDocument();
      expect(network.offline).toBe(false);
    });

    it('shows its own empty text instead of the notice without hits', async () => {
      network.simulate(true);
      answer([], 0);
      search.searchFrom('nobody@example.com');
      const view = render(Page);
      expect(await view.findByText('No results', { selector: '.empty-title' })).toBeInTheDocument();
      expect(view.getByText(EMPTY)).toHaveClass('empty-text');
      expect(view.queryByText(HINT)).toBeNull();
      expect(view.queryByText('Try fewer filters or a different search term.')).toBeNull();
    });

    it('fetches hits from storage from the server once the network returns', async () => {
      network.simulate(true);
      saved([hit('m1', 'Meeting')]);
      search.q = 'meeting';
      const view = render(Page);
      expect(await view.findByText(HINT)).toBeInTheDocument();
      expect(server.page).toHaveBeenCalledOnce();

      answer([hit('m1', 'Meeting'), hit('m2', 'Meeting in May')]);
      network.simulate(false);
      await waitFor(() => expect(view.queryByText(HINT)).toBeNull());
      expect(server.page).toHaveBeenCalledTimes(2);
      expect(view.getByText('2 results')).toBeInTheDocument();
    });

    it('stops listening for the network returning when leaving the page', () => {
      const resume = vi.spyOn(search, 'resume');
      network.simulate(true);
      render(Page).unmount();
      // Once on returning to the page so that hits from storage do not linger.
      expect(resume).toHaveBeenCalledOnce();
      network.simulate(false);
      expect(resume).toHaveBeenCalledOnce();
    });

    it('shows notice and empty text on mobile', async () => {
      mobile();
      network.simulate(true);
      answer([hit('m1', 'Meeting')]);
      search.q = 'meeting';
      const view = render(Page);
      expect((await view.findByText(HINT)).closest('.m-res')).not.toBeNull();

      answer([], 0);
      search.q = 'nothing';
      expect(await view.findByText(EMPTY)).toHaveClass('m-empty-text');
      expect(view.queryByText(HINT)).toBeNull();
    });
  });

  describe('Filter panel', () => {
    const panel = () => screen.getByRole('complementary', { name: 'Filters' });
    const group = (name: string) => within(panel()).getByRole('group', { name });
    const labels = (el: HTMLElement) =>
      within(el)
        .getAllByRole('button')
        .map((b) => b.textContent);

    /** Custom folders and subtags for expanding. */
    const env: FilterEnv = {
      accounts: [{ id: 'a1', email: 'a1@example.com', color: 0 }],
      allowed: searchCats(false),
      folders: [
        { key: 'role:inbox', label: 'Inbox', icon: 'ti-inbox' },
        { key: folderKey('a1', 'p1'), label: 'Projects', path: [] },
        { key: folderKey('a1', 'p1a'), label: 'Old', path: ['Projects'] },
      ],
      tags: [
        { id: 't1', label: 'Work', color: 3, path: [] },
        { id: 't1a', label: 'Customer A', color: 3, path: ['Work'] },
      ],
      folderBoxes: () => [],
      tagBoxes: () => [],
      tz: 'Europe/Berlin',
    };

    it('shows all sections when docked, account only with several accounts', async () => {
      const view = render(Page);
      const aside = panel();
      expect(labels(group('Status'))).toEqual(['Unread', 'Flagged', 'Attachment']);
      const time = within(aside).getByRole('radiogroup', { name: 'Date' });
      expect(
        within(time)
          .getAllByRole('radio')
          .map((r) => r.textContent?.trim()),
      ).toEqual(['Today', '7 days', '30 days', 'This year', 'Any time']);
      expect(within(time).getByRole('radio', { name: 'Any time' })).toHaveAttribute('aria-checked', 'true');
      expect(within(aside).queryByRole('group', { name: 'Account' })).toBeNull();
      expect(labels(group('Folder'))[0]).toBe('All');
      expect(group('Tags')).toBeInTheDocument();
      const fields = group('Search in');
      expect(labels(fields)).toEqual(['Subject', 'Sender', 'Body', 'Attachments']);
      for (const b of within(fields).getAllByRole('button')) expect(b).toHaveAttribute('aria-pressed', 'true');
      // Docked: no filter button on the page, no CTA, "Reset" locked without filters.
      expect(view.queryByRole('button', { name: 'Filters' })).toBeNull();
      expect(within(aside).queryByRole('button', { name: 'Done' })).toBeNull();
      expect(within(aside).getByRole('button', { name: 'Reset' })).toHaveAttribute('aria-disabled', 'true');

      accounts.list = [account('a1'), account('a2')];
      const acct = await waitFor(() => group('Account'));
      expect(labels(acct)).toEqual(['All accounts', 'a1@example.com', 'a2@example.com']);
      await fireEvent.click(within(acct).getByRole('button', { name: 'a2@example.com' }));
      expect(search.sf.account).toBe('a2');
      await fireEvent.click(view.getByRole('button', { name: 'Clear Reset Account' }));
      expect(search.sf.account).toBeNull();
    });

    it('hides and shows again via the filter button', async () => {
      const view = render(Page);
      await fireEvent.click(view.getByRole('button', { name: 'Hide filters' }));
      expect(view.queryByRole('complementary', { name: 'Filters' })).toBeNull();
      expect(search.panelHidden).toBe(true);
      const btn = view.getByRole('button', { name: 'Filters' });
      expect(btn).toHaveAttribute('aria-expanded', 'false');
      await fireEvent.click(btn);
      expect(panel()).toBeInTheDocument();
      expect(view.queryByRole('button', { name: 'Filters' })).toBeNull();
    });

    it('toggles filters and resets per section and overall', async () => {
      search.set({ cats: ['mail'] });
      render(Page);
      const aside = panel();
      expect(within(aside).queryByRole('button', { name: /^Clear Reset / })).toBeNull();

      await fireEvent.click(within(group('Status')).getByRole('button', { name: 'Unread' }));
      expect(search.sf.st).toEqual(['u']);
      expect(within(group('Status')).getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
      await fireEvent.click(within(aside).getByRole('radio', { name: '7 days' }));
      expect(search.sf.time).toBe('7d');
      expect(within(aside).getByRole('radio', { name: '7 days' })).toHaveAttribute('aria-checked', 'true');
      await fireEvent.click(within(group('Search in')).getByRole('button', { name: 'Subject' }));
      expect(search.sf.fields).toEqual(['from', 'body', 'att']);
      expect(within(group('Search in')).getByRole('button', { name: 'Subject' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      // Counter without the areas.
      expect(within(aside).getByText('3')).toBeInTheDocument();

      // The visible text "Clear" is in the name, the section as `.sr-only` (WCAG 2.5.3).
      const clear = within(aside).getByRole('button', { name: 'Clear Reset Status' });
      expect(clear).not.toHaveAttribute('aria-label');
      await fireEvent.click(clear);
      expect(search.sf.st).toEqual([]);
      expect(within(aside).queryByRole('button', { name: 'Clear Reset Status' })).toBeNull();
      await fireEvent.click(within(aside).getByRole('button', { name: 'Clear Reset Search in' }));
      expect(search.sf.fields).toEqual([]);

      const reset = within(aside).getByRole('button', { name: 'Reset' });
      expect(reset).toHaveAttribute('aria-disabled', 'false');
      await fireEvent.click(reset);
      // The areas stay; the pills show them.
      expect(search.sf).toEqual({ ...SF0, cats: ['mail'] });
      expect(reset).toHaveAttribute('aria-disabled', 'true');
    });

    it('shows the filter button with counter and the chips without panel', async () => {
      search.panelHidden = true;
      search.set({ st: ['u'] });
      const view = render(Page);
      // The skeleton shows until the mail server answers.
      const btn = await view.findByRole('button', { name: 'Filters, 1 active' });
      expect(btn).toHaveAttribute('aria-expanded', 'false');
      expect(btn).toHaveTextContent('Filters1');
      expect(view.getByRole('button', { name: 'Clear all' })).toBeInTheDocument();
      await fireEvent.click(btn);
      expect(panel()).toBeInTheDocument();
      expect(view.queryByRole('button', { name: 'Clear all' })).toBeNull();
      expect(view.queryByRole('button', { name: 'Filters, 1 active' })).toBeNull();
    });

    it('overlays the results with backdrop and hit count without room', async () => {
      vi.stubGlobal('innerWidth', 900);
      window.dispatchEvent(new Event('resize'));
      const view = render(Page);
      await waitFor(() => expect(search.dock).toBe(false));
      expect(view.queryByRole('complementary', { name: 'Filters' })).toBeNull();
      const btn = view.getByRole('button', { name: 'Filters' });
      await fireEvent.click(btn);
      const aside = panel();
      // The button stays, the CTA sits at the bottom, close instead of hide.
      expect(btn).toHaveAttribute('aria-expanded', 'true');
      expect(within(aside).getByRole('button', { name: 'Close' })).toBeInTheDocument();
      expect(within(aside).getByRole('button', { name: 'Done' })).toBeInTheDocument();

      answer([hit('m1', 'One'), hit('m2', 'Two')]);
      await fireEvent.click(within(group('Status')).getByRole('button', { name: 'Unread' }));
      const cta = await within(panel()).findByRole('button', { name: 'Show 2 results' });
      await fireEvent.click(cta);
      expect(search.panelOver).toBe(false);
      expect(view.queryByRole('complementary', { name: 'Filters' })).toBeNull();

      answer([hit('m1', 'One')]);
      search.set({ st: ['st'] });
      await fireEvent.click(view.getByRole('button', { name: 'Filters, 1 active' }));
      expect(await within(panel()).findByRole('button', { name: 'Show 1 result' })).toBeInTheDocument();
      answer([], 0);
      search.set({ st: ['at'] });
      expect(await within(panel()).findByRole('button', { name: 'No results' })).toBeInTheDocument();
      await fireEvent.click(view.container.querySelector('.scrim')!);
      expect(view.queryByRole('complementary', { name: 'Filters' })).toBeNull();
      // Whoever leaves the search otherwise finds the overlay closed next time.
      await fireEvent.click(view.getByRole('button', { name: 'Filters, 1 active' }));
      expect(search.panelOverlaid).toBe(true);
      view.unmount();
      expect([search.panelOver, search.filtered]).toEqual([false, false]);
    });

    it('suggests senders from the contacts and clears the field', async () => {
      contacts.list = [
        { name: 'Anna Berg', email: 'anna@example.com', count: 3, at: 0, match: '' },
        { name: 'Gwen Miller', email: 'gwen@firm.example', count: 1, at: 0, match: '' },
      ];
      const view = render(Page);
      const field = within(panel()).getByRole('textbox', { name: 'Sender' });
      expect(field).toHaveAttribute('placeholder', 'Name or email address');
      await fireEvent.input(field, { target: { value: 'a' } });
      expect(search.sf.from).toBe('a');
      expect(view.queryByRole('button', { name: /Anna Berg/ })).toBeNull();
      await fireEvent.input(field, { target: { value: 'an' } });
      const sug = view.getByRole('button', { name: /Anna Berg.*anna@example\.com/ });
      expect(view.queryByRole('button', { name: /Gwen/ })).toBeNull();
      await fireEvent.click(sug);
      expect(search.sf.from).toBe('anna@example.com');
      expect(field).toHaveValue('anna@example.com');
      expect(view.queryByRole('button', { name: /Anna Berg/ })).toBeNull();
      await fireEvent.click(view.getByRole('button', { name: 'Clear sender' }));
      expect(search.sf.from).toBe('');
      expect(view.queryByRole('button', { name: 'Clear sender' })).toBeNull();
    });

    it('expands custom folders and subtags, open on appearing with a selection', async () => {
      vi.spyOn(search, 'env', 'get').mockReturnValue(env);
      const view = render(Page);
      const folders = group('Folder');
      const custom = within(folders).getByRole('button', { name: 'Custom folders' });
      expect(custom).toHaveAttribute('aria-expanded', 'false');
      expect(view.queryByRole('button', { name: 'Old' })).toBeNull();
      await fireEvent.click(custom);
      expect(custom).toHaveAttribute('aria-expanded', 'true');
      await fireEvent.click(view.getByRole('button', { name: 'Old' }));
      expect(search.sf.folder).toBe(folderKey('a1', 'p1a'));
      expect(within(folders).getByRole('button', { name: 'Old', expanded: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      const tagGroup = group('Tags');
      expect(labels(tagGroup)).toEqual(['Work', 'Subtags']);
      await fireEvent.click(within(tagGroup).getByRole('button', { name: 'Subtags' }));
      await fireEvent.click(view.getByRole('button', { name: 'Customer A' }));
      expect(search.sf.tags).toEqual(['t1a']);
      expect(within(tagGroup).getByRole('button', { name: 'Customer A', expanded: true })).toBeInTheDocument();

      // Hide and show again: expanded with a selection.
      await fireEvent.click(view.getByRole('button', { name: 'Hide filters' }));
      await fireEvent.click(view.getByRole('button', { name: 'Filters, 2 active' }));
      expect(within(group('Folder')).getByRole('button', { name: 'Old', expanded: true })).toBeInTheDocument();
      expect(within(group('Tags')).getByRole('button', { name: 'Customer A', expanded: true })).toBeInTheDocument();

      // "Reset" only resets the filters: both sections stay expanded.
      await fireEvent.click(within(panel()).getByRole('button', { name: 'Reset' }));
      expect(search.sf.folder).toBeNull();
      expect(search.sf.tags).toEqual([]);
      expect(within(group('Folder')).getByRole('button', { name: 'Custom folders' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      expect(within(panel()).getByRole('button', { name: 'Old' })).toHaveAttribute('aria-pressed', 'false');
      expect(within(group('Tags')).getByRole('button', { name: 'Subtags' })).toHaveAttribute('aria-expanded', 'true');
      expect(within(panel()).getByRole('button', { name: 'Customer A' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('"Reset" leaves collapsed sections collapsed', async () => {
      vi.spyOn(search, 'env', 'get').mockReturnValue(env);
      search.set({ st: ['u'] });
      const view = render(Page);
      await fireEvent.click(within(panel()).getByRole('button', { name: 'Reset' }));
      expect(search.sf.st).toEqual([]);
      expect(within(group('Folder')).getByRole('button', { name: 'Custom folders' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      expect(within(group('Tags')).getByRole('button', { name: 'Subtags' })).toHaveAttribute('aria-expanded', 'false');
      expect(view.queryByRole('button', { name: 'Old' })).toBeNull();
    });
  });

  describe('mobile', () => {
    let loadTiles: MockInstance<typeof search.loadTiles>;
    beforeEach(() => {
      mobile();
      loadTiles = vi.spyOn(search, 'loadTiles').mockResolvedValue();
    });

    it('searches via the page field, remembers the search with Enter and clears the field', async () => {
      const view = render(Page);
      const field = view.getByRole('textbox', { name: 'Search' });
      expect(field).toHaveAttribute('enterkeyhint', 'search');
      expect(view.queryByRole('button', { name: 'Clear search' })).toBeNull();
      await fireEvent.input(field, { target: { value: 'Invoice' } });
      expect(search.q).toBe('Invoice');
      await fireEvent.keyDown(field, { key: 'Enter' });
      expect(search.recent).toEqual(['Invoice']);
      await fireEvent.click(view.getByRole('button', { name: 'Clear search' }));
      expect(search.q).toBe('');
      expect(field).toHaveFocus();
    });

    it('filter button in the search field opens the “Search filters” sheet and counts all filters', async () => {
      const view = render(Page);
      const btn = view.getByRole('button', { name: 'Filters' });
      expect(btn).toHaveAttribute('aria-expanded', 'false');
      expect(ui.pageDialog?.()).toBeNull();
      await fireEvent.click(btn);
      expect(btn).toHaveAttribute('aria-expanded', 'true');
      const dialog = ui.pageDialog?.();
      expect(dialog?.title).toBe('Filters');
      dialog!.close();
      await waitFor(() => expect(btn).toHaveAttribute('aria-expanded', 'false'));
      // Areas count too (`nF`), even though no chip shows them on mobile.
      search.set({ cats: ['mail'], st: ['u'] });
      expect(await view.findByRole('button', { name: 'Filters, 2 active' })).toBeInTheDocument();
      view.unmount();
      expect(ui.pageDialog).toBeNull();
    });

    it('runs “Recent searches” and removes entries', async () => {
      search.recent = ['Invoice', 'Anna', 'Vacation', 'Appointment', 'Old'];
      const view = render(Page);
      expect(view.getByText('Recent searches')).toBeInTheDocument();
      expect(view.queryByText('Old')).toBeNull();
      await fireEvent.click(view.getAllByRole('button', { name: 'Remove from history' })[1]!);
      expect(search.recent).toEqual(['Invoice', 'Vacation', 'Appointment', 'Old']);
      await fireEvent.click(view.getByRole('button', { name: 'Invoice' }));
      expect(search.q).toBe('Invoice');
      expect(view.getByRole('textbox', { name: 'Search' })).toHaveValue('Invoice');
    });

    it('shows only the quick access without history, with a dash without counters', () => {
      const view = render(Page);
      expect(view.queryByText('Recent searches')).toBeNull();
      expect(view.queryByRole('toolbar')).toBeNull();
      expect(view.queryByRole('group', { name: 'Quick filters' })).toBeNull();
      expect(view.getByText('Quick access')).toBeInTheDocument();
      for (const name of ['Unread –', 'Flagged –', 'Attachment –', 'Today –'])
        expect(view.getByRole('button', { name })).toBeInTheDocument();
    });

    it('shows the tiles with counters and sets the filter on click', async () => {
      search.tileCounts = [12, 3, null, 0];
      const view = render(Page);
      expect(loadTiles).toHaveBeenCalled();
      for (const name of ['Unread 12', 'Flagged 3', 'Attachment –', 'Today 0'])
        expect(view.getByRole('button', { name })).toBeInTheDocument();
      await fireEvent.click(view.getByRole('button', { name: 'Unread 12' }));
      expect(search.sf.st).toEqual(['u']);
      await waitFor(() => expect(view.queryByText('Quick access')).toBeNull());
      const quick = view.getByRole('group', { name: 'Quick filters' });
      expect(within(quick).getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('shows the quick filters only with a filter and toggles them', async () => {
      const view = render(Page);
      expect(view.queryByRole('group', { name: 'Quick filters' })).toBeNull();
      search.set({ st: ['u'] });
      const quick = await view.findByRole('group', { name: 'Quick filters' });
      expect(
        within(quick)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Unread', 'Flagged', 'Attachment', 'Today', 'Last 7 days', 'Reset']);
      // The quick filters show status and period themselves, not as a chip.
      expect(within(quick).getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(quick).getByRole('button', { name: 'Flagged' })).toHaveAttribute('aria-pressed', 'false');
      await fireEvent.click(within(quick).getByRole('button', { name: 'Flagged' }));
      expect(search.sf.st).toEqual(['u', 'st']);
      expect(within(quick).getByRole('button', { name: 'Flagged' })).toHaveAttribute('aria-pressed', 'true');
      await fireEvent.click(within(quick).getByRole('button', { name: 'Last 7 days' }));
      expect(search.sf.time).toBe('7d');
      await fireEvent.click(within(quick).getByRole('button', { name: 'Today' }));
      expect(search.sf.time).toBe('today');
      await fireEvent.click(within(quick).getByRole('button', { name: 'Today' }));
      expect(search.sf.time).toBe('any');
      await fireEvent.click(within(quick).getByRole('button', { name: 'Unread' }));
      expect(search.sf.st).toEqual(['st']);
      expect(within(quick).queryByRole('button', { name: /^Remove / })).toBeNull();
    });

    it('shows the remaining filters as chips and resets everything', async () => {
      search.set({ cats: ['mail'], account: 'a1', st: ['at'] });
      const view = render(Page);
      const quick = await view.findByRole('group', { name: 'Quick filters' });
      const chips = within(quick).getAllByRole('button', { name: /^Remove / });
      // The pills show the area, not the chips see above.
      expect(chips.map((c) => c.getAttribute('aria-label'))).toEqual(['Remove Account: a1@example.com']);
      expect(within(quick).getByRole('button', { name: 'Attachment' })).toHaveAttribute('aria-pressed', 'true');
      await fireEvent.click(chips[0]!);
      expect(search.sf.account).toBeNull();
      expect(within(quick).queryByRole('button', { name: 'Remove Account: a1@example.com' })).toBeNull();
      await fireEvent.click(within(quick).getByRole('button', { name: 'Reset' }));
      expect(search.sf).toEqual(SF0);
      expect(view.queryByRole('group', { name: 'Quick filters' })).toBeNull();
    });

    it('shows hits without pills and chips with “Reset”', async () => {
      answer([hit('m1', 'Meeting')]);
      search.searchFrom('anna@example.com');
      const view = render(Page);
      expect(await view.findByText('Messages')).toBeInTheDocument();
      expect(view.getByText('Search results')).toBeInTheDocument();
      expect(view.getByText('1 result')).toBeInTheDocument();
      expect(view.queryByRole('toolbar')).toBeNull();
      const quick = view.getByRole('group', { name: 'Quick filters' });
      expect(within(quick).queryByRole('button', { name: 'Remove Messages only' })).toBeNull();
      expect(within(quick).getByRole('button', { name: 'Remove From: anna@example.com' })).toBeInTheDocument();
      await fireEvent.click(within(quick).getByRole('button', { name: 'Reset' }));
      expect(search.sf).toEqual(SF0);
      expect(view.queryByRole('group', { name: 'Quick filters' })).toBeNull();
    });

    it('focuses the search field 30 ms after opening', () => {
      vi.useFakeTimers();
      try {
        const view = render(Page);
        const field = view.getByRole('textbox', { name: 'Search' });
        vi.advanceTimersByTime(29);
        expect(field).not.toHaveFocus();
        vi.advanceTimersByTime(1);
        expect(field).toHaveFocus();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not focus after leaving within 30 ms', () => {
      vi.useFakeTimers();
      try {
        const view = render(Page);
        const field = view.getByRole('textbox', { name: 'Search' });
        const focus = vi.spyOn(field, 'focus');
        view.unmount();
        vi.advanceTimersByTime(30);
        expect(focus).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps the search field with the skeleton', async () => {
      server.page.mockReturnValue(new Promise(() => {}));
      const view = render(Page);
      const field = view.getByRole('textbox', { name: 'Search' });
      field.focus();
      await fireEvent.input(field, { target: { value: 'anna' } });
      expect(await view.findByRole('status', { name: 'Loading search' })).toBeInTheDocument();
      expect(view.getByRole('textbox', { name: 'Search' })).toBe(field);
      expect(field).toHaveFocus();
    });
  });
});
