import { afterEach, describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { returnable, returnBackLabel, returnLabel, returnToSearch } from '#lib/search-return.ts';
import { search } from '#lib/state/search.svelte.ts';

const nav = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));

afterEach(() => {
  nav.goto.mockClear();
  search.reset();
});

describe('Return path to the search', () => {
  it('only an open message or a page outside the mailbox lists, start and search', () => {
    expect(returnable('/mailbox/a1/inbox/t1')).toBe(true);
    expect(returnable('/mailbox/all/f/a1/f1/t1')).toBe(true);
    expect(returnable('/settings/general')).toBe(true);
    expect(returnable('/admin/users')).toBe(true);
    for (const path of ['/mailbox/a1/inbox', '/mailbox/a1/t/tag1', '/start', '/search', '/'])
      expect(returnable(path), path).toBe(false);
  });

  it('"Search" from the mobile search, "Search results" from the results page', () => {
    expect([returnLabel('search'), returnLabel('results')]).toEqual([m.shell_search(), m.search_kicker()]);
    expect([returnBackLabel('search'), returnBackLabel('results')]).toEqual([
      m.search_back_search(),
      m.search_back_results(),
    ]);
    expect(m.search_back_search()).toBe('Back to search');
    expect(m.search_back_results()).toBe('Back to search results');
  });

  it('goes back to the search with text and filters, only at the target', () => {
    search.q = 'invoice';
    search.set({ st: ['st'] });
    search.expectReturn('results');
    search.done();
    search.navigating('/mailbox/a1/inbox/t1', true);
    expect(returnToSearch('/mailbox/a1/inbox/t2')).toBe(false);
    expect(nav.goto).not.toHaveBeenCalled();

    search.q = 'invoice';
    search.expectReturn('results');
    search.done();
    search.navigating('/mailbox/a1/inbox/t1', true);
    expect(returnToSearch('/mailbox/a1/inbox/t1')).toBe(true);
    expect(nav.goto).toHaveBeenCalledWith('/search');
    expect(search.q).toBe('invoice');
  });
});
