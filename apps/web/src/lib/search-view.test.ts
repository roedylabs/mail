import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HitBox, MailHit } from '#lib/search.ts';

const nav = vi.hoisted(() => ({ goto: vi.fn() }));
const openDraft = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<boolean>>());
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
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
    openHit(hit({ id: 'e2', mailboxIds: { drafts: true } }), box);
    expect(openDraft).toHaveBeenCalledWith('a1', 'e2', { href: '/mailbox/a1/drafts', label: 'Drafts' });
    await vi.waitFor(() => expect(nav.goto).toHaveBeenCalledWith('/compose/a1%2Fe2'));
  });

  it('stays if the draft does not open', async () => {
    openDraft.mockResolvedValue(false);
    openHit(hit({ mailboxIds: { drafts: true } }), { label: 'Drafts', role: 'drafts', target: { role: 'drafts' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(nav.goto).not.toHaveBeenCalled();
  });
});
