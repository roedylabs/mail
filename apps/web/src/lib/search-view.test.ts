import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HitBox, MailHit } from '#lib/search.ts';

const nav = vi.hoisted(() => ({ goto: vi.fn(), page: { url: new URL('http://app.test/search') } }));
const openDraft = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<boolean>>());
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
vi.mock('$app/state', () => ({ page: nav.page }));
vi.mock('#lib/state/mailboxes.svelte.ts', async (original) => ({
  ...(await original<object>()),
  mailboxes: { role: (_account: string, role: string) => (role === 'drafts' ? { id: 'mb-drafts' } : null) },
}));
vi.mock('#lib/state/compose.svelte.ts', () => ({
  compose: { openDraft },
  draftRef: (d: { account: string; id: string }) => `${d.account}/${d.id}`,
}));

const { openHit } = await import('#lib/search-view.svelte.ts');

const hit = (overrides: Partial<MailHit> = {}): MailHit => ({
  account: 'a1',
  id: 'e1',
  threadId: 't1',
  mailboxIds: { inbox: true },
  keywords: {},
  receivedAt: '2026-10-28T19:55:00Z',
  from: null,
  to: null,
  subject: 'Offer',
  attachments: [],
  snippet: null,
  ...overrides,
});

afterEach(() => {
  nav.goto.mockClear();
  nav.page.url = new URL('http://app.test/search');
  openDraft.mockReset();
});

describe('Opening a found email', () => {
  it('opens the conversation in its folder', () => {
    openHit(hit(), { label: 'Inbox', role: 'inbox', target: { role: 'inbox' } });
    expect(nav.goto).toHaveBeenCalledWith('/mailbox/a1/inbox/t1');
    expect(openDraft).not.toHaveBeenCalled();
  });

  it('opens a draft in compose, back to "Drafts"', async () => {
    openDraft.mockResolvedValue(true);
    const box: HitBox = { label: 'Drafts', role: 'drafts', target: { role: 'drafts' } };
    openHit(hit({ id: 'e2', mailboxIds: { 'mb-drafts': true } }), box);
    expect(openDraft).toHaveBeenCalledWith('a1', 'e2', { href: '/mailbox/a1/drafts', label: 'Drafts' });
    await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/compose/a1%2Fe2'));
  });

  it('opens a draft in compose even if it also lies in another folder', async () => {
    openDraft.mockResolvedValue(true);
    openHit(hit({ mailboxIds: { inbox: true, 'mb-drafts': true } }), {
      label: 'Inbox',
      role: 'inbox',
      target: { role: 'inbox' },
    });
    expect(openDraft).toHaveBeenCalledWith('a1', 'e1', { href: '/mailbox/a1/drafts', label: 'Drafts' });
    await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/compose/a1%2Fe1'));
  });

  it('stays if the draft does not open or another page opened meanwhile', async () => {
    const box: HitBox = { label: 'Drafts', role: 'drafts', target: { role: 'drafts' } };
    openDraft.mockResolvedValue(false);
    openHit(hit({ mailboxIds: { 'mb-drafts': true } }), box);
    await vi.waitFor(() => expect(openDraft).toHaveBeenCalledTimes(1));

    let done: (ok: boolean) => void = () => {};
    openDraft.mockReturnValue(new Promise<boolean>((r) => (done = r)));
    openHit(hit({ mailboxIds: { 'mb-drafts': true } }), box);
    nav.page.url = new URL('http://app.test/mailbox/a1/inbox');
    done(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(nav.goto).not.toHaveBeenCalled();
  });
});
