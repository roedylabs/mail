import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMailboxPath, type MailboxLocation } from '#lib/routes.ts';
import { followGone, openList, openThread, type GoneCheck } from '#lib/thread-nav.ts';

const nav = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));

afterEach(() => {
  nav.goto.mockClear();
});

function at(path: string): MailboxLocation {
  const location = parseMailboxPath(path);
  if (!location) throw new Error(`not a mailbox address: ${path}`);
  return location;
}

const OPENED = { account: 'a1', threadId: 't1' };
const missing = (movedTo: string | null): GoneCheck => ({ ...OPENED, status: 'missing', movedTo });

describe('Navigation of the reading view', () => {
  it('opens a thread with a new entry, in "Alle Konten" with its account', () => {
    openThread(at('/mailbox/a1/inbox'), 'a1', 't1');
    expect(nav.goto).toHaveBeenLastCalledWith('/mailbox/a1/inbox/t1', { replace: false });
    openThread(at('/mailbox/all/inbox'), 'a2', 't7');
    expect(nav.goto).toHaveBeenLastCalledWith('/mailbox/all/inbox/a2%2Ft7', { replace: false });
  });

  it('closes to the list of the view', () => {
    openList(at('/mailbox/a1/f/folder%201/t1'), false);
    expect(nav.goto).toHaveBeenLastCalledWith('/mailbox/a1/f/folder%201', { replace: false });
  });

  it('opens the new thread after a merge and replaces the entry', () => {
    const location = at('/mailbox/a1/inbox/t1');
    expect(followGone(missing('t9'), OPENED, () => location)).toBe('moved');
    expect(nav.goto).toHaveBeenCalledTimes(1);
    expect(nav.goto).toHaveBeenLastCalledWith('/mailbox/a1/inbox/t9', { replace: true });
  });

  it('returns to the list without a new thread and replaces the entry', () => {
    const location = at('/mailbox/all/inbox/a1%2Ft1');
    expect(followGone(missing(null), OPENED, () => location)).toBe('gone');
    expect(nav.goto).toHaveBeenLastCalledWith('/mailbox/all/inbox', { replace: true });
  });

  it('leaves loaded, other and already left threads alone', () => {
    const location = at('/mailbox/a1/inbox/t1');
    expect(followGone({ ...missing('t9'), status: 'ready' }, OPENED, () => location)).toBeNull();
    expect(followGone(missing('t9'), { account: 'a1', threadId: 't2' }, () => location)).toBeNull();
    expect(followGone(missing('t9'), null, () => location)).toBeNull();
    expect(followGone(null, OPENED, () => location)).toBeNull();
    expect(followGone(missing('t9'), OPENED, () => null)).toBeNull();
    expect(nav.goto).not.toHaveBeenCalled();
  });
});
