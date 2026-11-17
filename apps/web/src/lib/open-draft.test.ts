import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ goto: vi.fn() }));
const load = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<boolean>>());
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
vi.mock('#lib/state/compose.svelte.ts', () => ({
  compose: { openDraft: load },
  draftRef: (d: { account: string; id: string }) => `${d.account}/${d.id}`,
}));

const { openDraft } = await import('#lib/open-draft.ts');
const { search } = await import('#lib/state/search.svelte.ts');

const ret = { href: '/mailbox/a1/scheduled', label: 'Scheduled' };

/** Draft that loads until `done()`. */
function pending() {
  let done: (ok: boolean) => void = () => {};
  load.mockReturnValueOnce(new Promise<boolean>((r) => (done = r)));
  return (ok = true) => done(ok);
}

afterEach(() => {
  nav.goto.mockClear();
  load.mockReset();
});

describe('Opening a draft in compose', () => {
  it('opens compose once the draft has loaded, with "Send later" prefilled', async () => {
    load.mockResolvedValue(true);
    await openDraft('a1', 'e1', ret, { sendAt: 1_800_000_000_000 });
    expect(load).toHaveBeenCalledWith('a1', 'e1', ret, 1_800_000_000_000);
    expect(nav.goto).toHaveBeenCalledWith('/compose/a1%2Fe1');
  });

  it('opens nothing if the draft does not load', async () => {
    load.mockResolvedValue(false);
    await openDraft('a1', 'e1', ret);
    expect(nav.goto).not.toHaveBeenCalled();
  });

  it('opens nothing after another navigation while the draft loads', async () => {
    const done = pending();
    const opened = openDraft('a1', 'e1', ret);
    search.navigating('/mailbox/a1/inbox', false);
    done();
    await opened;
    expect(nav.goto).not.toHaveBeenCalled();
  });

  it('opens compose after closing the reading view ("Cancel send", "Send now")', async () => {
    const since = search.mark(1);
    search.navigating('/mailbox/a1/scheduled', false);
    const done = pending();
    const opened = openDraft('a1', 'e1', ret, { since });
    done();
    await opened;
    expect(nav.goto).toHaveBeenCalledWith('/compose/a1%2Fe1');
  });

  it('opens compose if the draft loads before the reading view has closed', async () => {
    const since = search.mark(1);
    const done = pending();
    const opened = openDraft('a1', 'e1', ret, { since });
    done();
    await opened;
    expect(nav.goto).toHaveBeenCalledWith('/compose/a1%2Fe1');
  });

  it('opens nothing after closing the reading view and another navigation', async () => {
    for (const before of [true, false]) {
      const since = search.mark(1);
      search.navigating('/mailbox/a1/scheduled', false);
      if (before) search.navigating('/mailbox/a1/inbox', false);
      const done = pending();
      const opened = openDraft('a1', 'e1', ret, { since });
      if (!before) search.navigating('/mailbox/a1/inbox', false);
      done();
      await opened;
      expect(nav.goto).not.toHaveBeenCalled();
    }
  });

  it('opens compose on undo after "Send now", even after navigations before it', async () => {
    const closed = search.mark(1);
    search.navigating('/mailbox/a1/scheduled', false);
    search.navigating('/mailbox/a1/inbox', false);
    const done = pending();
    const opened = openDraft('a1', 'e1', ret, { since: Math.max(closed, search.mark()) });
    done();
    await opened;
    expect(nav.goto).toHaveBeenCalledWith('/compose/a1%2Fe1');
  });
});
