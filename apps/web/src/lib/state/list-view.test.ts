import { describe, expect, it } from 'vitest';
import { DEFAULT_SORT } from '#lib/mail-list.ts';
import { ListView } from '#lib/state/list-view.svelte.ts';

const INBOX = '/mailbox/a1/inbox';
const SENT = '/mailbox/a1/sent';

describe('ListView', () => {
  it('starts with “All” and the default sorting', () => {
    const v = new ListView();
    expect(v.segment).toBe('all');
    expect(v.sort).toEqual(DEFAULT_SORT);
    expect(v.segmentAt(INBOX)).toBe('all');
  });

  it('keeps segment and sorting without a choice, also on other addresses', () => {
    const v = new ListView();
    v.segment = 'unread';
    v.sort = { key: 'from', dir: 1 };
    v.reached(SENT);
    expect(v.segmentAt(SENT)).toBe('unread');
    expect(v.segment).toBe('unread');
    expect(v.sort).toEqual({ key: 'from', dir: 1 });
  });

  it('choosing the open list again resets the segment at once, the sorting stays', () => {
    const v = new ListView();
    v.segment = 'flagged';
    v.sort = { key: 'date', dir: 1 };
    v.choose(INBOX, INBOX);
    expect(v.segment).toBe('all');
    expect(v.chosen).toBe(1);
    expect(v.sort).toEqual({ key: 'date', dir: 1 });
  });

  it('another list starts with “All” once it is shown; the previous one keeps its segment meanwhile', () => {
    const v = new ListView();
    v.segment = 'unread';
    v.choose(SENT, INBOX);
    // Still on the previous list: no reload in "All".
    expect(v.segmentAt(INBOX)).toBe('unread');
    expect(v.chosen).toBe(0);
    // The target shows "All" as soon as the page is there.
    expect(v.segmentAt(SENT)).toBe('all');
    v.reached(SENT);
    expect(v.segment).toBe('all');
    expect(v.segmentAt(SENT)).toBe('all');
    expect(v.chosen).toBe(1);
    // Completed: a later segment holds again.
    v.segment = 'flagged';
    v.reached(SENT);
    expect(v.segmentAt(SENT)).toBe('flagged');
    expect(v.chosen).toBe(1);
  });

  it('the thread of a chosen list (search hit) also starts its list with “All”', () => {
    const v = new ListView();
    v.segment = 'unread';
    v.choose(`${SENT}/t1`, '/search');
    v.reached(`${SENT}/t1`);
    expect(v.segment).toBe('all');
  });

  it('the latest choice counts', () => {
    const v = new ListView();
    v.segment = 'unread';
    v.choose(SENT, INBOX);
    v.choose('/mailbox/a1/drafts', INBOX);
    v.reached(SENT);
    expect(v.segment).toBe('unread');
    v.reached('/mailbox/a1/drafts');
    expect(v.segment).toBe('all');
  });
});
