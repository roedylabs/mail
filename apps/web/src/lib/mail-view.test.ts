import type { Mailbox } from '@roedy/jmap';
import { describe, expect, it } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { listView, type ViewDeps } from './mail-view.ts';
import { ALL_ACCOUNTS, type MailboxLocation, type RoleId } from './routes.ts';
import type { AccountMailboxes } from './state/mailboxes.svelte.ts';
import type { Tag } from './state/tags.svelte.ts';

const box = (id: string, name: string, role: string | null = null): Mailbox =>
  ({ id, name, role, parentId: null, sortOrder: 0 }) as Mailbox;

const BOXES: Record<string, Mailbox[]> = {
  k1: [box('in1', 'Inbox', 'inbox'), box('tr1', 'Trash', 'trash'), box('sp1', 'Junk', 'junk'), box('f1', 'Projects')],
  k2: [box('in2', 'Inbox', 'inbox')],
};

const TAGS: Tag[] = [
  { id: 'tg1', name: 'Customers', parent_id: null, color: 0, position: 0, links: [], created_at: '' },
];

function deps(overrides: Partial<ViewDeps> = {}): ViewDeps {
  const roles: Record<RoleId, string> = {
    inbox: 'inbox',
    sent: 'sent',
    drafts: 'drafts',
    scheduled: 'scheduled',
    trash: 'trash',
    spam: 'junk',
  };
  return {
    status: (a) => (BOXES[a] ? 'ready' : undefined),
    role: (a, r) => BOXES[a]?.find((b) => b.role === roles[r]) ?? null,
    list: (a) => BOXES[a] ?? [],
    tags: TAGS,
    tagsFailed: false,
    tagBoxes: (_, a) => (a === 'k1' ? ['tb1', 'tb2'] : []),
    ...overrides,
  };
}

const K1 = { id: 'k1' };
const K2 = { id: 'k2' };

describe('listView', () => {
  it('reads a mailbox via the role in every account of the view', () => {
    const v = listView({ account: 'all', role: 'inbox', thread: null }, [K1, K2], true, deps());
    expect(v).toEqual({
      kind: { role: 'inbox' },
      title: m.mailbox_inbox(),
      multi: true,
      sources: [
        { account: 'k1', boxes: ['in1'], exclude: [] },
        { account: 'k2', boxes: ['in2'], exclude: [] },
      ],
      unavailable: false,
    });
  });

  it('skips accounts without the mailbox and waits for loading mailboxes', () => {
    expect(listView({ account: 'k2', role: 'trash', thread: null }, [K2], false, deps()).sources).toEqual([]);
    const loading = deps({ status: (a) => (a === 'k2' ? 'loading' : 'ready') });
    expect(listView({ account: 'all', role: 'inbox', thread: null }, [K1, K2], true, loading).sources).toBeNull();
    const failed = deps({ status: (a) => (a === 'k2' ? 'error' : 'ready') });
    expect(listView({ account: 'all', role: 'inbox', thread: null }, [K1, K2], true, failed).sources).toHaveLength(1);
  });

  it('reads a folder of its account, also in "All accounts"', () => {
    const v = listView({ account: 'all', folder: 'f1', owner: 'k1', thread: null }, [K1, K2], true, deps());
    expect(v).toMatchObject({ kind: { folder: true }, title: 'Projects', sources: [{ account: 'k1', boxes: ['f1'] }] });
    expect(listView({ account: 'k1', folder: 'gone', thread: null }, [K1], false, deps()).sources).toEqual([]);
  });

  it('reads a tag from its mailboxes without trash and spam', () => {
    const v = listView({ account: 'all', tag: 'tg1', thread: null }, [K1, K2], true, deps());
    expect(v).toEqual({
      kind: { tag: true },
      title: 'Customers',
      multi: true,
      sources: [{ account: 'k1', boxes: ['tb1', 'tb2'], exclude: ['tr1', 'sp1'] }],
      unavailable: false,
    });
    expect(listView({ account: 'k1', tag: 'tg1', thread: null }, [K1], false, deps({ tags: null })).sources).toBeNull();
    expect(listView({ account: 'k1', tag: 'gone', thread: null }, [K1], false, deps()).sources).toEqual([]);
  });

  it('is "unavailable" instead of empty without a reachable account or without tags', () => {
    const failed = deps({ status: () => 'error' });
    expect(listView({ account: 'k1', role: 'inbox', thread: null }, [K1], false, failed)).toMatchObject({
      sources: [],
      unavailable: true,
    });
    expect(listView({ account: 'k1', role: 'inbox', thread: null }, [], false, deps()).unavailable).toBe(true);
    expect(listView({ account: 'k1', folder: 'f1', thread: null }, [K1], false, failed).unavailable).toBe(true);
    const noTags = deps({ tags: null, tagsFailed: true });
    expect(listView({ account: 'k1', tag: 'tg1', thread: null }, [K1], false, noTags).unavailable).toBe(true);
  });

  it('does not count "All accounts" with one account as multiple', () => {
    expect(listView({ account: 'all', role: 'inbox', thread: null }, [K1], true, deps()).multi).toBe(false);
  });
});

describe('accounts without access', () => {
  it('marks their source as `frozen` and skips accounts without a store', () => {
    const deps = (status: (a: string) => AccountMailboxes['status'] | undefined): ViewDeps => ({
      status,
      role: (a) => ({ id: `in-${a}` }) as Mailbox,
      list: () => [],
      tags: [],
      tagsFailed: false,
      tagBoxes: () => null,
      frozen: (a) => a === 'old',
    });
    const accounts = [{ id: 'a' }, { id: 'old' }];
    const location: MailboxLocation = { account: ALL_ACCOUNTS, thread: null, role: 'inbox' };
    expect(
      listView(
        location,
        accounts,
        true,
        deps(() => 'ready'),
      ).sources,
    ).toEqual([
      { account: 'a', boxes: ['in-a'], exclude: [] },
      { account: 'old', boxes: ['in-old'], exclude: [], frozen: true },
    ]);
    const missing = deps((a) => (a === 'old' ? 'error' : 'ready'));
    expect(listView(location, accounts, true, missing).sources).toEqual([
      { account: 'a', boxes: ['in-a'], exclude: [] },
    ]);
    const none = listView(
      { ...location, account: 'old' },
      [{ id: 'old' }],
      false,
      deps(() => 'error'),
    );
    expect(none.unavailable).toBe(true);
  });
});
