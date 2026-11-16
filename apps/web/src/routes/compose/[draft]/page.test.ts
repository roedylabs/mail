import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { compose } from '#lib/state/compose.svelte.ts';
import Page from './+page.svelte';

const nav = vi.hoisted(() => ({
  page: { url: new URL('http://localhost/compose/new'), params: { draft: 'new' } },
  goto: vi.fn(() => Promise.resolve()),
}));
vi.mock('$app/state', () => ({ page: nav.page }));
vi.mock('$app/navigation', () => ({ goto: nav.goto, replaceState: vi.fn() }));
// The page has its own tests; what counts here is what compose takes from the address.
vi.mock('#lib/components/ComposeView.svelte', () => ({ default: () => {} }));

afterEach(() => {
  compose.reset();
  accounts.reset();
});

describe('Compose from a mailto: link', () => {
  it('prefills a new email from the address', async () => {
    accounts.fromCopy([{ id: 'a1', email: 'me@example.test', color: 0 } as MailAccount]);
    nav.page.url = new URL('http://localhost/compose/new?mailto=mailto%3Aa%40example.test%3Fsubject%3DHello%2520there');
    render(Page);
    await vi.waitFor(() => expect(compose.current?.subject).toBe('Hello there'));
    expect(compose.current?.to.map((r) => r.email)).toEqual(['a@example.test']);
  });

  it('opens an empty email without parameters', async () => {
    accounts.fromCopy([{ id: 'a1', email: 'me@example.test', color: 0 } as MailAccount]);
    nav.page.url = new URL('http://localhost/compose/new');
    render(Page);
    await vi.waitFor(() => expect(compose.current?.subject).toBe(''));
    expect(compose.current?.to).toEqual([]);
  });
});
