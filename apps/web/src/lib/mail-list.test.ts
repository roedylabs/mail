import { describe, expect, it } from 'vitest';
import {
  bucketOf,
  clock,
  dayLabel,
  draftOf,
  flatItems,
  fullTime,
  initials,
  bySendAt,
  listOrder,
  listValues,
  nextSort,
  rowOf,
  rowTimes,
  ROW_TIMES_MAX,
  selectionValues,
  baseValues,
  listNotice,
  senderText,
  shortTime,
  threadRef,
  type ListInput,
  type ListThread,
  type TimeContext,
} from './mail-list.ts';

/** Wednesday, 28 October 2026, 20:55 in Berlin (CET). */
const NOW = Date.parse('2026-10-28T19:55:00Z');
const T: TimeContext = { now: NOW, tz: 'Europe/Berlin', timeFmt: '24h', weekStart: 'monday', dateFmt: 'de' };
const at = (iso: string) => Date.parse(iso);

function thread(overrides: Partial<ListThread> = {}): ListThread {
  return {
    key: 'k1/e1',
    account: 'k1',
    id: 'e1',
    threadId: 't1',
    receivedAt: NOW,
    from: [{ name: 'Anna Baker', email: 'anna@example.com' }],
    to: [{ name: 'Me', email: 'me@example.com' }],
    subject: 'Approve homepage by Friday?',
    preview: 'Hello, the drafts …',
    hasAttachment: false,
    unread: true,
    flagged: false,
    count: 1,
    mailboxIds: ['inbox'],
    members: [],
    seq: 0,
    ...overrides,
  };
}

function input(overrides: Partial<ListInput> = {}): ListInput {
  return {
    kind: { role: 'inbox' },
    title: 'Inbox',
    segment: 'all',
    threads: [thread()],
    counts: { all: 15, unread: 4, flagged: 0 },
    total: 15,
    multi: false,
    accountOf: () => ({ email: 'account1@s1.test', color: 2 }),
    tagOf: () => undefined,
    time: T,
    ...overrides,
  };
}

describe('rowTimes', () => {
  const t = at('2026-10-26T12:00:00Z');

  it('returns the same values as shortTime, fullTime and bucketOf', () => {
    expect(rowTimes(t, T)).toEqual({ short: shortTime(t, T), full: fullTime(t, T), bucket: bucketOf(t, T) });
  });

  it('does not recompute on the same day, even with a new context per minute', () => {
    const first = rowTimes(t, T);
    expect(rowTimes(t, { ...T, now: NOW + 60_000 })).toBe(first);
  });

  it('recomputes on the next day and with other settings', () => {
    const first = rowTimes(t, T);
    const tomorrow = rowTimes(t, { ...T, now: NOW + 86_400_000 });
    expect(tomorrow).not.toBe(first);
    expect(tomorrow.short).toBe(shortTime(t, { ...T, now: NOW + 86_400_000 }));
    expect(rowTimes(t, { ...T, timeFmt: '12h' }).full).toBe(fullTime(t, { ...T, timeFmt: '12h' }));
    expect(rowTimes(t, { ...T, tz: 'UTC' }).bucket).toBe(bucketOf(t, { ...T, tz: 'UTC' }));
  });

  it('starts over above the upper limit', () => {
    const c = { ...T };
    const first = rowTimes(t, c);
    for (let i = 1; i <= ROW_TIMES_MAX; i++) rowTimes(t - i * 60_000, c);
    expect(rowTimes(t, c)).not.toBe(first);
    expect(rowTimes(t, c)).toEqual(first);
  });
});

describe('time in the time zone of the settings', () => {
  it('names days "Today", "Yesterday" or with weekday and date', () => {
    expect(dayLabel(NOW, T)).toBe('Today');
    expect(dayLabel(at('2026-10-27T12:00:00Z'), T)).toBe('Yesterday');
    expect(dayLabel(at('2026-10-26T12:00:00Z'), T)).toBe('Monday 26 October');
    expect(dayLabel(at('2026-10-27T23:30:00Z'), T)).toBe('Today');
    expect(dayLabel(at('2026-10-27T23:30:00Z'), { ...T, tz: 'UTC' })).toBe('Yesterday');
  });

  it('shows the time of day today, 24- or 12-hour', () => {
    expect(shortTime(NOW, T)).toBe('20:55');
    expect(clock(at('2026-10-28T07:05:00Z'), T)).toBe('08:05');
    expect(clock(NOW, { ...T, timeFmt: '12h' })).toMatch(/^8:55\s?PM$/);
  });

  it('computes the day in tz, not in the time zone of the browser', () => {
    // 23:30 UTC on the 28th is already the 29th in Berlin.
    expect(shortTime(at('2026-10-28T23:30:00Z'), T)).toBe('Tomorrow, 00:30');
    expect(shortTime(at('2026-10-28T23:30:00Z'), { ...T, tz: 'UTC' })).toBe('23:30');
  });

  it('names yesterday, weekdays and older dates', () => {
    expect(shortTime(at('2026-10-27T09:00:00Z'), T)).toBe('Yesterday');
    expect(shortTime(at('2026-10-25T09:00:00Z'), T)).toBe('Sunday');
    expect(shortTime(at('2026-10-30T09:00:00Z'), T)).toBe('Fri 10:00');
    expect(shortTime(at('2026-03-02T09:00:00Z'), T)).toBe('2 Mar');
    expect(shortTime(at('2025-12-24T09:00:00Z'), T)).toBe('24.12.25');
    // Date format from the language and region settings.
    expect(shortTime(at('2025-12-24T09:00:00Z'), { ...T, dateFmt: 'us' })).toBe('12/24/25');
    expect(shortTime(at('2025-12-24T09:00:00Z'), { ...T, dateFmt: 'iso' })).toBe('2025-12-24');
  });

  it('writes out the tooltip', () => {
    expect(fullTime(NOW, T)).toBe('Wednesday, 28 October 2026, 20:55');
  });

  it('groups by days and weeks with the week start', () => {
    expect(bucketOf(NOW, T)).toBe('today');
    expect(bucketOf(at('2026-10-27T09:00:00Z'), T)).toBe('yesterday');
    expect(bucketOf(at('2026-10-29T09:00:00Z'), T)).toBe('tomorrow');
    expect(bucketOf(at('2026-11-02T09:00:00Z'), T)).toBe('later');
    // Monday, 26 Oct: this week; Sunday, 25 Oct: last week (week starts Monday).
    expect(bucketOf(at('2026-10-26T09:00:00Z'), T)).toBe('week');
    expect(bucketOf(at('2026-10-25T09:00:00Z'), T)).toBe('lastWeek');
    expect(bucketOf(at('2026-10-25T09:00:00Z'), { ...T, weekStart: 'sunday' })).toBe('week');
    expect(bucketOf(at('2026-10-18T09:00:00Z'), T)).toBe('older');
  });
});

describe('rows', () => {
  it('takes initials without company suffixes', () => {
    expect(initials('Anna Baker')).toBe('AB');
    expect(initials('Acme GmbH')).toBe('A');
    expect(initials('Acme Ltd')).toBe('A');
    expect(initials('[Jira] (Project)')).toBe('JP');
    expect(initials('123')).toBe('');
  });

  it('shows sender, count, attachment, star and account', () => {
    const row = rowOf(thread({ count: 3, hasAttachment: true, flagged: true }), { ...input(), multi: true });
    expect(row).toMatchObject({
      who: 'Anna Baker',
      letter: 'AB',
      subj: 'Approve homepage by Friday?',
      time: '20:55',
      timeFull: 'Wednesday, 28 October 2026, 20:55',
      n: '3',
      hasN: true,
      nLabel: '3 messages',
      hasAtt: true,
      star: true,
      starIcon: 'ti-star-filled',
      starTip: 'Remove flag',
      multi: true,
      acctMail: 'account1@s1.test',
      fw: 800,
      hasChip: false,
      readTip: 'Mark as read',
    });
  });

  it('shows the recipient in the outbox, drafts with chip and without subject', () => {
    const drafts = rowOf(thread({ subject: ' ', to: [], unread: false }), { ...input(), kind: { role: 'drafts' } });
    expect(drafts).toMatchObject({
      who: 'No recipient',
      noLetter: true,
      subj: '(No subject)',
      hasChip: true,
      chip: 'Draft',
    });
    expect(drafts.avBg).toBe('var(--sunken)');
    const sent = rowOf(thread(), { ...input(), kind: { role: 'sent' } });
    expect(sent).toMatchObject({ who: 'To: Me', letter: 'M' });
    const planned = rowOf(thread(), { ...input(), kind: { role: 'scheduled' } });
    expect(planned.timeFull).toBe('Scheduled: Wednesday, 28 October 2026, 20:55');
    // With a submission the row shows its send time instead of the save time.
    const sendAt = (account: string, email: string) =>
      account === 'k1' && email === 'e1' ? NOW + 86_400_000 : undefined;
    expect(rowOf(thread(), { ...input(), kind: { role: 'scheduled' }, sendAt })).toMatchObject({
      time: 'Tomorrow, 20:55',
      timeFull: 'Scheduled: Thursday, 29 October 2026, 20:55',
    });
    // In Scheduled "Cancel send" takes the place of read.
    expect(planned).toMatchObject({
      sched: true,
      readIcon: 'ti-clock-x',
      readTip: 'Cancel send',
      isTrash: false,
    });
    expect(planned).toMatchObject({ delIcon: 'ti-trash', delTip: 'Delete' });
    expect(sent).toMatchObject({ sched: false, readIcon: 'ti-mail-opened', readTip: 'Mark as read' });
    expect(rowOf(thread(), { ...input(), kind: { role: 'trash' } })).toMatchObject({ sched: false, isTrash: true });
  });

  it('recognizes Scheduled in tag views by the mailbox of the conversation (`outboxOf`)', () => {
    const tagged = { ...input(), kind: { tag: true } as const };
    const outboxOf = (account: string, boxes: readonly string[]) =>
      account === 'k1' && boxes.includes('plan') ? ('scheduled' as const) : null;
    expect(rowOf(thread({ mailboxIds: ['plan', 'b1'] }), { ...tagged, outboxOf })).toMatchObject({
      sched: true,
      readIcon: 'ti-clock-x',
      readTip: 'Cancel send',
    });
    expect(rowOf(thread(), { ...tagged, outboxOf })).toMatchObject({ sched: false, readIcon: 'ti-mail-opened' });
    // Without `outboxOf` the row stays ordinary in tag views; in views with a role the role counts.
    expect(rowOf(thread({ mailboxIds: ['plan'] }), tagged).sched).toBe(false);
    expect(rowOf(thread({ mailboxIds: ['plan'] }), { ...input(), outboxOf }).sched).toBe(false);
  });

  it('sorts and groups "Scheduled" by the send time', () => {
    const a = thread({ key: 'k1/e1', id: 'e1', receivedAt: NOW - 3_600_000 });
    const b = thread({ key: 'k1/e2', id: 'e2', receivedAt: NOW - 7_200_000 });
    const c = thread({ key: 'k1/e3', id: 'e3', receivedAt: NOW - 60_000 });
    const times: Record<string, number> = { e1: NOW + 3 * 86_400_000, e2: NOW + 86_400_000 };
    const sendAt = (_account: string, email: string) => times[email];
    const kind = { role: 'scheduled' } as const;
    const order = listOrder(kind, false);
    // Without a submission `receivedAt` stays (here: a few minutes ago).
    expect(bySendAt([a, b, c], kind, order, sendAt).map((t) => t.id)).toEqual(['e3', 'e2', 'e1']);
    expect(bySendAt([a, b, c], kind, { ...order, ascending: false }, sendAt).map((t) => t.id)).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
    // Other views and sorting by recipient stay as the server returns them.
    const list = [a, b, c];
    expect(bySendAt(list, { role: 'inbox' }, listOrder({ role: 'inbox' }, false), sendAt)).toBe(list);
    expect(bySendAt(list, kind, { by: 'to', ascending: true }, sendAt)).toBe(list);
    const v = baseValues({ ...input(), kind, threads: bySendAt(list, kind, order, sendAt), sendAt });
    expect(v.groups.map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ['today', ['e3']],
      ['tomorrow', ['e2']],
      ['later', ['e1']],
    ]);
  });

  it('has swipe actions only with `swipe` (mobile and tablet)', () => {
    expect(rowOf(thread(), input())).toMatchObject({ swL: null, swR: null });
    const swipe = { left: 'move', right: 'read' };
    const row = rowOf(thread({ unread: true }), { ...input(), swipe });
    expect(row.swL).toMatchObject({ key: 'move', label: 'Move to folder' });
    expect(row.swR).toMatchObject({ key: 'read', label: 'Read' });
    // In Scheduled "Read" is dropped like "Move"; delete stays (it cancels the sending).
    expect(rowOf(thread(), { ...input(), kind: { role: 'scheduled' }, swipe })).toMatchObject({ swL: null, swR: null });
    expect(
      rowOf(thread(), { ...input(), kind: { role: 'scheduled' }, swipe: { left: 'del', right: 'star' } }),
    ).toMatchObject({ swL: { key: 'del', label: 'Delete', out: true }, swR: { key: 'star' } });
    expect(rowOf(thread(), { ...input(), swipe: { left: 'none', right: 'del' } })).toMatchObject({
      swL: null,
      swR: { key: 'del', ink: 'light-dark(#fffaf3, #2b0d07)' },
    });
    // In tag views the folder of the conversation counts.
    const tagged = { ...input(), kind: { tag: true } as const };
    const outboxOf = () => 'drafts' as const;
    expect(rowOf(thread(), { ...tagged, swipe })).toMatchObject({ swL: { key: 'move' } });
    expect(rowOf(thread(), { ...tagged, swipe, outboxOf })).toMatchObject({ swL: null });
  });

  it('shows "Unknown" without initials without a sender', () => {
    for (const kind of [{ role: 'inbox' }, { role: 'trash' }, { tag: true }, { folder: true }] as const) {
      const row = rowOf(thread({ from: [] }), { ...input(), kind });
      expect(row).toMatchObject({
        who: 'Unknown',
        letter: '',
        noLetter: true,
        avBg: 'var(--sunken)',
        avInk: 'var(--mfg)',
      });
    }
    expect(senderText(undefined)).toBe('Unknown');
    expect(senderText({ name: ' ', email: 'nas@example.com' })).toBe('nas@example.com');
    expect(rowOf(thread({ from: [{ name: ' ', email: 'nas@example.com' }] }), input()).who).toBe('nas@example.com');
  });

  it('shows at most two tags in their colours', () => {
    const tags: Record<string, { name: string; color: number }> = {
      b1: { name: 'Important', color: 0 },
      b2: { name: 'Project', color: 7 },
      b3: { name: 'Third', color: 1 },
    };
    const row = rowOf(thread({ mailboxIds: ['inbox', 'b1', 'b2', 'b3'] }), { ...input(), tagOf: (_, b) => tags[b] });
    expect(row.tags).toEqual([
      { label: 'Important', bg: '#f5a06e', ink: '#3a1b06', chip: 'var(--surface2)' },
      { label: 'Project', bg: '#94c48d', ink: '#13300f', chip: 'var(--surface2)' },
    ]);
    // With a position in the tag list in its order, not in that of the mailboxes.
    const ranked = { b1: { ...tags.b1!, rank: 2 }, b2: { ...tags.b2!, rank: 1 }, b3: { ...tags.b3!, rank: 0 } };
    const sorted = rowOf(thread({ mailboxIds: ['inbox', 'b1', 'b2', 'b3'] }), {
      ...input(),
      tagOf: (_, b) => ranked[b as keyof typeof ranked],
    });
    expect(sorted.tags.map((x) => x.label)).toEqual(['Third', 'Project']);
  });

  it('deletes permanently in the trash', () => {
    const row = rowOf(thread(), { ...input(), kind: { role: 'trash' } });
    expect(row).toMatchObject({ isTrash: true, delIcon: 'ti-trash-x', delTip: 'Delete permanently' });
  });
});

describe('list', () => {
  it('combines header, segments and groups', () => {
    const v = listValues(
      input({
        threads: [
          thread(),
          thread({ key: 'k1/e2', id: 'e2', receivedAt: at('2026-10-28T08:00:00Z') }),
          thread({ key: 'k1/e3', id: 'e3', receivedAt: at('2026-10-27T08:00:00Z') }),
        ],
      }),
    );
    expect(v).toMatchObject({
      title: 'Inbox',
      sub: '4 unread · 15 messages',
      range: '15 messages',
      hasSeg: true,
    });
    expect(v.seg).toEqual([
      { id: 'all', label: 'All', n: '15', hasN: false, on: true },
      { id: 'unread', label: 'Unread', n: '4', hasN: true, on: false },
      { id: 'flagged', label: 'Flagged', n: '0', hasN: false, on: false },
    ]);
    expect(v.groups.map((g) => [g.label, g.n])).toEqual([
      ['Today', '2'],
      ['Yesterday', '1'],
    ]);
    expect(flatItems(v.groups).map((i) => (i.type === 'head' ? i.key : `${i.key}:${i.first}:${i.last}`))).toEqual([
      'h:today',
      'k1/e1:true:false',
      'k1/e2:false:true',
      'h:yesterday',
      'k1/e3:true:true',
    ]);
  });

  it('counts in the segment and offers "Show all" in the empty state', () => {
    const v = listValues(input({ segment: 'flagged', threads: [], total: 0 }));
    expect(v).toMatchObject({ empty: true, eTitle: 'Nothing flagged', eHasAct: true, range: '0 of 15' });
  });

  it('has the mailbox text when empty without segments', () => {
    const v = listValues(input({ threads: [], counts: { all: 0, unread: 0, flagged: 0 }, total: 0 }));
    expect(v).toMatchObject({
      empty: true,
      hasSeg: false,
      eTitle: 'All done',
      eHasAct: false,
      range: '',
      sub: '0 messages',
    });
    expect(listValues(input({ kind: { tag: true }, threads: [], total: 0 })).eTitle).toBe('No messages');
    expect(listValues(input({ kind: { folder: true }, threads: [], total: 0 })).eTitle).toBe('This folder is empty');
  });

  it('names the icon of the empty state', () => {
    const empty = { threads: [], counts: { all: 0, unread: 0, flagged: 0 }, total: 0 };
    expect(listValues(input(empty)).eIcon).toBe('ti-inbox');
    expect(listValues(input({ ...empty, kind: { role: 'spam' } })).eIcon).toBe('ti-shield-check');
    expect(listValues(input({ ...empty, kind: { tag: true } })).eIcon).toBe('ti-tag');
    expect(listValues(input({ segment: 'unread', threads: [], total: 0 })).eIcon).toBe('ti-mail-opened');
  });

  it('shows no "Unread" in the outbox', () => {
    const v = listValues(input({ kind: { role: 'sent' }, counts: { all: 1, unread: 1, flagged: 0 } }));
    expect(v.sub).toBe('1 message');
    expect(v.seg.map((s) => s.id)).toEqual(['all', 'flagged']);
    expect(listValues(input({ kind: { role: 'drafts' }, counts: { all: 2, unread: 0, flagged: 0 } })).sub).toBe(
      '2 drafts',
    );
    expect(listValues(input({ kind: { role: 'trash' } })).hasClear).toBe(true);
  });
});

describe('compact', () => {
  it('returns the rows flat in list order and the column header', () => {
    const v = listValues(
      input({
        threads: [
          thread({ key: 'k1/e3', id: 'e3', receivedAt: at('2026-10-27T08:00:00Z') }),
          thread(),
          thread({ key: 'k1/e2', id: 'e2', receivedAt: at('2026-10-28T08:00:00Z') }),
        ],
      }),
    );
    expect(v.rows.map((r) => r.key)).toEqual(['k1/e3', 'k1/e1', 'k1/e2']);
    expect(v.hasHead).toBe(true);
    expect(v.sortFrom).toEqual({ key: 'from', label: 'Sender', aria: 'Sort by Sender', on: false, up: false });
    expect(v.sortDate).toEqual({ key: 'date', label: 'Date', aria: 'Sort by Date', on: true, up: false });
    expect(listValues(input({ threads: [], counts: { all: 0, unread: 0, flagged: 0 }, total: 0 })).hasHead).toBe(false);
  });

  it('labels the columns in the outbox and shows the direction', () => {
    const sent = listValues(input({ kind: { role: 'sent' }, sort: { key: 'from', dir: -1 } }));
    expect(sent.sortFrom).toMatchObject({ label: 'Recipient', aria: 'Sort by Recipient', on: true, up: true });
    expect(sent.sortDate).toMatchObject({ label: 'Date', on: false, up: false });
    const scheduled = listValues(input({ kind: { role: 'scheduled' }, sort: { key: 'date', dir: 1 } }));
    expect(scheduled.sortDate).toMatchObject({ label: 'Send time', on: true, up: true });
  });

  it('switches the column with its default and reverses the same one', () => {
    expect(nextSort({ key: 'date', dir: -1 }, 'date')).toEqual({ key: 'date', dir: 1 });
    expect(nextSort({ key: 'date', dir: 1 }, 'from')).toEqual({ key: 'from', dir: 1 });
    expect(nextSort({ key: 'from', dir: 1 }, 'from')).toEqual({ key: 'from', dir: -1 });
    expect(nextSort({ key: 'from', dir: -1 }, 'date')).toEqual({ key: 'date', dir: -1 });
  });

  it('queries by date, sender or recipient', () => {
    const inbox = { role: 'inbox' } as const;
    const scheduled = { role: 'scheduled' } as const;
    // Soft: always by date, Scheduled ascending.
    expect(listOrder(inbox, false, { key: 'from', dir: 1 })).toEqual({ by: 'date', ascending: false });
    expect(listOrder(scheduled, false)).toEqual({ by: 'date', ascending: true });
    // Compact: default like Soft, so that both share the same list.
    expect(listOrder(inbox, true)).toEqual({ by: 'date', ascending: false });
    expect(listOrder(scheduled, true)).toEqual({ by: 'date', ascending: true });
    expect(listOrder(inbox, true, { key: 'date', dir: 1 })).toEqual({ by: 'date', ascending: true });
    expect(listOrder(scheduled, true, { key: 'date', dir: 1 })).toEqual({ by: 'date', ascending: false });
    expect(listOrder({ tag: true }, true, { key: 'from', dir: 1 })).toEqual({ by: 'from', ascending: true });
    expect(listOrder({ role: 'drafts' }, true, { key: 'from', dir: -1 })).toEqual({ by: 'to', ascending: false });
  });
});

describe('selection and focus', () => {
  const t1 = thread();
  const t2 = thread({ key: 'k2/e5', account: 'k2', id: 'e5', threadId: 't5', unread: false, flagged: true });
  const t3 = thread({ key: 'k1/e7', id: 'e7', threadId: 't7', unread: false, flagged: true });

  it('shows segments without a selection and checkboxes only on hover', () => {
    const v = listValues(input({ threads: [t1, t2] }));
    expect(v).toMatchObject({ selOn: false, selText: '0 selected', focus: null });
    expect(v.chkAll).toEqual({ checked: 'false', icon: 'ti-minus', label: 'Select all', on: false, all: false });
    expect(v.rows[0]).toMatchObject({
      ref: 'k1/t1',
      checked: false,
      showCk: false,
      ckLabel: 'Select: Approve homepage by Friday?',
    });
  });

  it('counts only selected conversations of the list and chooses buttons by their state', () => {
    const v = listValues(input({ threads: [t1, t2, t3], selected: new Set([threadRef(t1), 'k9/gone']) }));
    expect(v).toMatchObject({ selOn: true, selText: '1 selected' });
    expect(v.chkAll).toMatchObject({
      checked: 'mixed',
      icon: 'ti-minus',
      label: 'Select all',
      on: true,
      all: false,
    });
    expect(v.rows[0]).toMatchObject({
      checked: true,
      showCk: true,
      ckLabel: 'Deselect: Approve homepage by Friday?',
      aBg: 'var(--accsoft)',
      aSh: 'none',
      bBg: 'var(--accsoft)',
    });
    expect(v.rows[1]).toMatchObject({ checked: false, showCk: true });
    // One unread: "Read"; not all flagged: "Flag".
    expect(v.bulk.map((b) => [b.id, b.label, b.tip])).toEqual([
      ['read', 'Read', 'Mark as read'],
      ['flag', 'Flag', 'Flag'],
      ['trash', 'Delete', 'Delete'],
    ]);

    const both = listValues(input({ threads: [t1, t2, t3], selected: new Set([threadRef(t2), threadRef(t3)]) }));
    expect(both.selText).toBe('2 selected');
    expect(both.bulk.map((b) => [b.id, b.icon, b.label])).toEqual([
      ['unread', 'ti-mail', 'Unread'],
      ['unflag', 'ti-star-off', 'Unflag'],
      ['trash', 'ti-trash', 'Delete'],
    ]);
  });

  it('clears the selection with "Select all" and knows trash and Scheduled', () => {
    const selected = new Set([threadRef(t1), threadRef(t2)]);
    const v = listValues(input({ threads: [t1, t2], selected }));
    expect(v.chkAll).toEqual({ checked: 'true', icon: 'ti-check', label: 'Clear selection', on: true, all: true });
    const trash = listValues(input({ kind: { role: 'trash' }, threads: [t1, t2], selected }));
    expect(trash.bulk.map((b) => b.id)).toEqual(['restore', 'purge']);
    // In Scheduled "Cancel send" replaces read, then flag and delete.
    const planned = listValues(input({ kind: { role: 'scheduled' }, threads: [t1, t2], selected }));
    expect(planned.bulk.map((b) => [b.id, b.icon, b.label, b.tip])).toEqual([
      ['cancel', 'ti-clock-x', 'Cancel send', 'Cancel send'],
      ['flag', 'ti-star', 'Flag', 'Flag'],
      ['trash', 'ti-trash', 'Delete', 'Delete'],
    ]);
  });

  it('marks the focused row while it is in the list', () => {
    const v = listValues(input({ threads: [t1, t2], focus: threadRef(t2) }));
    expect(v.focus).toBe('k2/t5');
    expect(v.rows[1]).toMatchObject({ focused: true, aSh: '0 0 0 2px var(--acc)', bBg: 'var(--surface2)' });
    expect(v.rows[0]).toMatchObject({ focused: false, aSh: 'var(--sh1)' });
    expect(listValues(input({ threads: [t1], focus: 'k2/t5' })).focus).toBeNull();
  });

  it('leaves the values without selection and focus and renews only affected rows and groups', () => {
    const t4 = thread({ key: 'k1/e8', id: 'e8', threadId: 't8', receivedAt: NOW - 86_400_000 });
    const base = baseValues(input({ threads: [t1, t4] }));
    expect(selectionValues(base, { kind: { role: 'inbox' }, threads: [t1, t4] })).toBe(base);
    const v = selectionValues(base, { kind: { role: 'inbox' }, threads: [t1, t4], focus: threadRef(t4) });
    expect(v.rows[0]).toBe(base.rows[0]);
    expect(v.groups[0]).toBe(base.groups[0]);
    expect(v.rows[1]).toMatchObject({ focused: true });
    expect(v.groups[1]?.rows[0]).toBe(v.rows[1]);
  });
});

describe('listNotice', () => {
  const ok = { email: 'a@example.com', host: 'mail.a.test', state: 'ok', blocked: false } as const;
  const stale = { email: 'b@example.com', host: 'mail.b.test', state: 'needs_reauth', blocked: false } as const;
  const blocked = { email: 'c@example.com', host: 'mail.c.test', state: 'ok', blocked: true } as const;
  const base = (threads: ListThread[] = [], tot = threads.length) =>
    baseValues({
      kind: { role: 'inbox' },
      title: 'Inbox',
      segment: 'all',
      threads,
      counts: { all: tot, unread: 0, flagged: 0 },
      total: tot,
      multi: false,
      accountOf: () => undefined,
      tagOf: () => undefined,
      time: T,
      compact: false,
    });
  const input = { offline: false, unsaved: false, truncated: false };

  it('leaves a list with access unchanged', () => {
    const values = base([thread()]);
    expect(listNotice(values, 1, { ...input, accounts: [ok] })).toBe(values);
  });

  it('shows the notice above a saved list', () => {
    const values = base([thread()]);
    expect(listNotice(values, 1, { ...input, accounts: [stale] }).note).toEqual({
      on: true,
      text: 'Sign-in to mail.b.test required. You’re seeing the last synced data.',
      isRe: true,
      isCon: false,
    });
    expect(listNotice(values, 1, { ...input, accounts: [blocked] }).note).toEqual({
      on: true,
      text: 'mail.c.test is no longer an approved server. You’re seeing the last synced data.',
      isRe: false,
      isCon: true,
    });
    expect(listNotice(values, 1, { ...input, accounts: [stale, blocked] }).note.text).toBe(
      'You need to sign in to 2 accounts again. You’re seeing the last synced data.',
    );
  });

  it('shows no notice if only some accounts are affected', () => {
    expect(listNotice(base([thread()]), 1, { ...input, accounts: [ok, stale] }).note.on).toBe(false);
  });

  it('shows the empty state without a saved list', () => {
    const values = { ...base(), empty: false };
    expect(listNotice(values, 0, { ...input, accounts: [stale] })).toMatchObject({
      empty: true,
      sub: 'Sign-in required',
      eIcon: 'ti-plug-connected-x',
      eTitle: 'Sign-in required',
      eText: 'You need to sign in to b@example.com again.',
      eHasRe: true,
      eHasCon: false,
    });
    expect(listNotice(values, 0, { ...input, accounts: [blocked] })).toMatchObject({
      eTitle: 'Server blocked',
      eText: 'mail.c.test is no longer an approved server.',
      eHasRe: false,
      eHasCon: true,
    });
    expect(listNotice(values, 0, { ...input, accounts: [stale, blocked] })).toMatchObject({
      eText: 'You need to sign in to 2 accounts again.',
      eHasRe: true,
    });
  });

  it('shows "not saved offline" without connection and storage', () => {
    const values = { ...base(), empty: false };
    expect(listNotice(values, 0, { ...input, accounts: [ok], offline: true, unsaved: true })).toMatchObject({
      empty: true,
      sub: 'Not saved offline',
      eIcon: 'ti-cloud-off',
      eTitle: 'This folder isn’t saved for offline use',
      eText: 'It will load as soon as you’re back online.',
      eHasRe: false,
      eHasCon: false,
    });
  });

  it('names below the list that older ones are missing offline', () => {
    const values = base([thread()], 10);
    expect(listNotice(values, 10, { ...input, accounts: [ok], offline: true, truncated: true }).footOn).toBe(true);
    expect(listNotice(values, 10, { ...input, accounts: [ok], truncated: true }).footOn).toBe(false);
    expect(listNotice(values, 10, { ...input, accounts: [ok], offline: true }).footOn).toBe(false);
  });
});

describe('draftOf', () => {
  const member = (id: string, mailboxIds: string[]) => ({ id, mailboxIds, keywords: {}, from: 'me@example.com' });

  it("is true if the email of the row lies in the account's drafts", () => {
    const t = thread({ id: 'e2', members: [member('e1', ['inbox']), member('e2', ['drafts', 'tag1'])] });
    expect(draftOf(t, 'drafts')).toBe(true);
  });

  it('follows the email of the row, not other emails of the conversation', () => {
    const t = thread({ id: 'e1', members: [member('e1', ['inbox', 'tag1']), member('e2', ['drafts'])] });
    expect(draftOf(t, 'drafts')).toBe(false);
  });

  it('is false without a drafts mailbox or without the email among the members', () => {
    expect(draftOf(thread({ members: [member('e1', ['drafts'])] }), null)).toBe(false);
    expect(draftOf(thread({ members: [] }), 'drafts')).toBe(false);
  });
});
