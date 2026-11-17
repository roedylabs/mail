import { MA_COLORS, MODES } from '@roedy/tokens';
import { describe, expect, it, vi } from 'vitest';
import { readTime, type TimeContext } from '#lib/mail-list.ts';
import { renderMail } from '#lib/mail/render.ts';
import type { FolderNode } from '#lib/state/mailboxes.svelte.ts';
import type { MessageEmail, MessagePart } from '#lib/state/message.svelte.ts';
import type { TagNode } from '#lib/state/tags.svelte.ts';
import {
  fileExt,
  fileIcon,
  fileSize,
  limitText,
  moveValues,
  readTheme,
  readValues,
  sourceValues,
  truncSize,
  type ReadInput,
} from './message-view.ts';

/** Wednesday, 28 October 2026, 20:55 in Berlin (CET). */
const NOW = Date.parse('2026-10-28T19:55:00Z');
const T: TimeContext = { now: NOW, tz: 'Europe/Berlin', timeFmt: '24h', weekStart: 'monday', dateFmt: 'de' };
const ME = 'account1@s1.test';

const ROLES = { sent: 'sent', drafts: 'drafts', scheduled: 'sched', trash: 'trash', spam: 'spam' };

const text = (value: string) => ({
  textBody: [
    { partId: '1', blobId: 'b', size: 1, name: null, type: 'text/plain', charset: null, disposition: null, cid: null },
  ],
  bodyValues: { '1': { value, isEncodingProblem: false, isTruncated: false } },
});

function email(id: string, patch: Partial<MessageEmail> = {}): MessageEmail {
  return {
    id,
    blobId: `blob-${id}`,
    threadId: 't1',
    mailboxIds: ['in'],
    keywords: {},
    receivedAt: Date.parse('2026-10-20T06:56:00Z'),
    from: [{ name: 'Anna Baker', email: 'anna.baker@example.com' }],
    to: [{ name: null, email: ME }],
    cc: [],
    replyTo: [],
    messageId: [],
    inReplyTo: [],
    references: [],
    subject: 'Approve homepage by Friday?',
    preview: 'Preview',
    hasAttachment: false,
    htmlBody: [],
    attachments: [],
    ...text(`Text ${id}`),
    ...patch,
  };
}

function input(patch: Partial<ReadInput> = {}): ReadInput {
  return {
    emails: [email('e1')],
    repId: null,
    kind: { role: 'inbox' },
    title: 'Inbox',
    account: { email: ME, color: 2, state: 'ok' },
    roles: ROLES,
    multi: false,
    tagOf: () => undefined,
    menu: null,
    tagTree: [],
    tagPending: new Set(),
    move: { inbox: null, folders: [], on: () => false },
    time: T,
    folds: {},
    dark: true,
    inverted: false,
    isMobile: false,
    ext: { extMode: 'ask', extAllow: [] },
    once: new Set(),
    render: renderMail,
    images: {},
    loadingFull: new Set(),
    offline: false,
    nav: null,
    ...patch,
  };
}

const att = (patch: Partial<MessagePart>): MessagePart => ({
  partId: '2',
  blobId: 'b2',
  size: 123_904,
  name: 'Homepage_Draft_v1.pdf',
  type: 'application/pdf',
  charset: null,
  disposition: 'attachment',
  cid: null,
  ...patch,
});

describe('readValues', () => {
  it('shows a simple email with its attachment', () => {
    const rd = readValues(input({ emails: [email('e1', { attachments: [att({})] })] }));
    expect(rd).toMatchObject({
      id: 'e1',
      subj: 'Approve homepage by Friday?',
      folder: 'Inbox',
      hasN: false,
      nLabel: '1 message',
      hasPos: false,
      starIcon: 'ti-star',
      starTip: 'Flag',
      starOn: 'false',
      delTip: 'Delete',
      delIcon: 'ti-trash',
      canReply: true,
      hasChip: false,
      canTag: true,
      canMove: true,
      canSpam: true,
      spamIcon: 'ti-alert-octagon',
      spamTip: 'Report spam',
      reply: { id: 'e1', hasAll: false, base: expect.any(String) as string },
      tg: { open: false, exp: 'false' },
    });
    expect(rd.msgs).toHaveLength(1);
    expect(rd.msgs[0]).toMatchObject({
      who: 'Anna Baker',
      whoShort: 'Anna Baker',
      email: 'anna.baker@example.com',
      letter: 'AB',
      toText: 'To: me',
      toTip: ME,
      hasCc: false,
      time: 'Tue 20 Oct, 08:56',
      timeFull: 'Tuesday, 20 October 2026, 08:56',
      paras: [{ t: 'Text e1' }],
      open: true,
      canFold: false,
      cur: 'default',
      oBox: 'none',
      oPad: '0',
      notHtml: true,
      isHtml: false,
      hasAtts: true,
      attN: '1 attachment',
      atts: [{ name: 'Homepage_Draft_v1.pdf', icon: 'ti-file-type-pdf', size: '121 KB', ext: 'PDF' }],
    });
  });

  it('expands only the last and the representing email, `folds` wins', () => {
    const emails = ['e1', 'e2', 'e3'].map((id, i) => email(id, { receivedAt: NOW - (3 - i) * 3_600_000 }));
    const rd = readValues(input({ emails, repId: 'e1' }));
    expect(rd.msgs.map((x) => x.open)).toEqual([true, false, true]);
    expect(rd.msgs.map((x) => x.canFold)).toEqual([true, true, false]);
    expect(rd.msgs[0]).toMatchObject({ cur: 'pointer', oBox: 'inset 0 0 0 1.5px var(--bd)', oPad: '20px 22px 22px' });
    expect(rd.msgs[2]!.oPad).toBe('22px 0 0');
    expect(rd).toMatchObject({ hasN: true, nLabel: '3 messages', id: 'e1' });
    const folded = readValues(input({ emails, repId: 'e1', folds: { e1: false, e2: true, e3: false } }));
    expect(folded.msgs.map((x) => x.open)).toEqual([false, true, true]);
    expect(folded.msgs[1]!.snip).toBe('Text e2');
  });

  it('takes the newest without a representing email', () => {
    const rd = readValues(input({ emails: [email('e1'), email('e2', { subject: 'Re: New' })], repId: 'foreign' }));
    expect(rd).toMatchObject({ id: 'e2', subj: 'Re: New' });
  });

  it('hides trash and spam except there or as the representing email', () => {
    const emails = [email('e1'), email('e2', { mailboxIds: ['trash'] }), email('e3', { mailboxIds: ['spam'] })];
    expect(readValues(input({ emails })).msgs.map((x) => x.key)).toEqual(['e1']);
    expect(readValues(input({ emails, repId: 'e2' })).msgs.map((x) => x.key)).toEqual(['e1', 'e2']);
    expect(readValues(input({ emails, kind: { role: 'trash' } })).msgs).toHaveLength(3);
  });

  it('shows own emails with name, "You" and recipients', () => {
    const sent = email('e2', {
      mailboxIds: ['sent'],
      from: [{ name: 'Account One', email: ME }],
      to: [
        { name: 'Anna Baker', email: 'anna.baker@example.com' },
        { name: null, email: 'ben@example.com' },
      ],
    });
    const m = readValues(input({ emails: [email('e1'), sent] })).msgs[1]!;
    expect(m).toMatchObject({
      me: true,
      who: 'Account One',
      whoShort: 'You',
      email: ME,
      letter: 'AO',
      avBg: 'var(--acc)',
      avInk: 'var(--accink)',
      toText: 'To: Anna Baker, ben@example.com',
      toTip: 'anna.baker@example.com, ben@example.com',
    });
    // Own address as sender, without a name and without recipients.
    const bare = readValues(
      input({ emails: [email('e1', { from: [{ name: null, email: 'ACCOUNT1@s1.test' }], to: [] })] }),
    ).msgs[0]!;
    expect(bare).toMatchObject({ me: true, who: 'me', letter: 'M', toText: 'To: No recipient', toTip: '' });
  });

  it('shows "Unknown" without initials without a sender', () => {
    const m = readValues(input({ emails: [email('e1', { from: [] })] })).msgs[0]!;
    expect(m).toMatchObject({
      who: 'Unknown',
      whoShort: 'Unknown',
      letter: '',
      email: '',
      avBg: 'var(--sunken)',
      avInk: 'var(--mfg)',
    });
  });

  it('offers "Reply all" for own emails only from two recipients and shows the alias', () => {
    const own = (to: string[]) =>
      email('e1', {
        mailboxIds: ['sent'],
        from: [{ name: 'Account One', email: 'alias@s1.test' }],
        to: to.map((x) => ({ name: null, email: x })),
      });
    const one = readValues(input({ emails: [own(['anna@example.com'])] }));
    expect(one.reply.hasAll).toBe(false);
    expect(one.msgs[0]).toMatchObject({ me: true, email: 'alias@s1.test' });
    expect(readValues(input({ emails: [own(['anna@example.com', 'ben@example.com'])] })).reply.hasAll).toBe(true);
  });

  it('names further recipients, Cc and "Reply all"', () => {
    const e = email('e1', {
      to: [
        { name: null, email: ME },
        { name: 'Ben', email: 'ben@example.com' },
      ],
      cc: [{ name: 'Cara', email: 'cara@example.com' }],
    });
    const rd = readValues(input({ emails: [e] }));
    expect(rd.msgs[0]).toMatchObject({ toText: 'To: me, Ben', hasCc: true, ccText: 'Cc: Cara' });
    expect(rd.reply.hasAll).toBe(true);
  });

  it('knows drafts, Scheduled, trash and spam', () => {
    expect(readValues(input({ kind: { role: 'drafts' } }))).toMatchObject({
      hasChip: true,
      chip: 'Draft',
      chipIcon: 'ti-pencil',
      chipText: 'Last edited: Tue 20 Oct, 08:56',
      canReply: false,
      noReply: true,
      canMove: false,
      canSpam: false,
    });
    expect(
      readValues(input({ kind: { role: 'scheduled' }, emails: [email('e1', { receivedAt: NOW + 3_600_000 })] })),
    ).toMatchObject({
      chip: 'Scheduled',
      chipIcon: 'ti-clock',
      chipText: 'Scheduled: Today, 21:55',
      // "Send now" and "Cancel send" instead of unread, on mobile as a pill.
      sched: true,
      canUnread: false,
      canReply: false,
      noReplyGap: false,
      schedPill: true,
      schedIcon: false,
      delTip: 'Delete',
      delIcon: 'ti-trash',
    });
    // With a submission the send time instead of the save time, in the chip as at the message.
    const planned = readValues(
      input({
        kind: { role: 'scheduled' },
        emails: [email('e1')],
        sendAt: (id) => (id === 'e1' ? NOW + 86_400_000 : undefined),
      }),
    );
    expect(planned.chipText).toBe('Scheduled: Tomorrow, 20:55');
    expect(planned.msgs[0]).toMatchObject({ timeFull: 'Thursday, 29 October 2026, 20:55' });
    expect(readValues(input({ kind: { role: 'trash' } }))).toMatchObject({
      isTrash: true,
      notTrash: false,
      sched: false,
      canUnread: false,
      noReplyGap: true,
      schedPill: false,
      delTip: 'Delete permanently',
      delIcon: 'ti-trash-x',
      canReply: false,
      canTag: false,
      canSpam: false,
    });
    // A scheduled message or a draft in a tag view: no reply bar.
    for (const box of ['sched', 'drafts']) {
      expect(readValues(input({ emails: [email('e1', { mailboxIds: [box, 'tag1'] })] })).canReply).toBe(false);
    }
    // The scheduled one shows the same actions there as in Scheduled (per its mailbox),
    // the reply bar is missing, so never the round `schedIcon` button.
    expect(
      readValues(input({ kind: { tag: true }, emails: [email('e1', { mailboxIds: ['sched', 'tag1'] })] })),
    ).toMatchObject({ sched: true, canUnread: false, noReplyGap: false, schedPill: true, schedIcon: false });
    expect(
      readValues(input({ kind: { tag: true }, emails: [email('e1', { mailboxIds: ['drafts', 'tag1'] })] })),
    ).toMatchObject({ sched: false, canUnread: true, noReplyGap: true, schedPill: false });
    expect(readValues(input({ kind: { role: 'spam' } }))).toMatchObject({
      spamIcon: 'ti-shield-check',
      spamTip: 'Not spam',
    });
    expect(readValues(input({ kind: { role: 'sent' } })).canSpam).toBe(false);
    expect(readValues(input({ kind: { role: 'scheduled' } }))).toMatchObject({ canMove: false, canSpam: false });
    expect(readValues(input({ kind: { role: 'sent' } })).canMove).toBe(true);
    expect(readValues(input({ kind: { role: 'trash' } })).canMove).toBe(true);
    expect(readValues(input({ kind: { role: 'spam' } }))).toMatchObject({ canMove: true, canSpam: true });
    expect(readValues(input({ kind: { folder: true } }))).toMatchObject({ canMove: true, canSpam: true });
    // In a tag view "Move" and "Report spam" per the mailbox of the shown email.
    const inTag = (box: string) =>
      readValues(input({ kind: { tag: true }, emails: [email('e1', { mailboxIds: [box, 'tag1'] })] }));
    expect(inTag('sent')).toMatchObject({ canMove: true, canSpam: false });
    expect(inTag('drafts')).toMatchObject({ canMove: false, canSpam: false });
    expect(inTag('sched')).toMatchObject({ canMove: false, canSpam: false });
    expect(inTag('trash')).toMatchObject({ canMove: true, canSpam: false });
    expect(inTag('in')).toMatchObject({ canMove: true, canSpam: true });
    // Mailbox views go by their role only, even if the email is also in another role mailbox.
    for (const box of ['sent', 'drafts', 'sched']) {
      const inInbox = readValues(input({ emails: [email('e1', { mailboxIds: ['in', box] })] }));
      expect(inInbox).toMatchObject({ canMove: true, canSpam: true });
    }
    // The representing email counts, not others of the conversation.
    expect(
      readValues(
        input({
          kind: { tag: true },
          repId: 'e2',
          emails: [email('e1', { mailboxIds: ['sent', 'tag1'] }), email('e2', { mailboxIds: ['in', 'tag1'] })],
        }),
      ),
    ).toMatchObject({ canMove: true, canSpam: true });
    // A representing email in the trash stays shown and gets no "Report spam".
    expect(
      readValues(
        input({
          kind: { tag: true },
          repId: 'e1',
          emails: [email('e1', { mailboxIds: ['trash', 'tag1'] }), email('e2', { mailboxIds: ['in', 'tag1'] })],
        }),
      ),
    ).toMatchObject({ id: 'e1', canMove: true, canSpam: false });
    expect(readValues(input())).toMatchObject({
      sched: false,
      canUnread: true,
      canReply: true,
      noReplyGap: false,
      schedPill: false,
      schedIcon: false,
    });
  });

  it('flags as soon as one email is flagged and shows tags of the conversation', () => {
    const emails = [email('e1', { keywords: { $flagged: true }, mailboxIds: ['in', 'tag-w'] }), email('e2')];
    const rd = readValues(
      input({ emails, tagOf: (b) => (b === 'tag-w' ? { id: 't1', name: 'Important', color: 4 } : undefined) }),
    );
    expect(rd).toMatchObject({
      starIcon: 'ti-star-filled',
      starC: '#e3a93a',
      starTip: 'Remove flag',
      starOn: 'true',
    });
    expect(rd.tags).toEqual([{ label: 'Important', bg: MA_COLORS[4][1], ink: MA_COLORS[4][2] }]);
    expect(rd.hasTags).toBe(true);
  });

  it('shows the tags to set with check marks on the set and the pending ones (tag options)', () => {
    const node = (id: string, name: string, color: number, children: TagNode[] = []): TagNode => ({
      id,
      name,
      color,
      children,
      unread: 0,
      total: 0,
    });
    const emails = [email('e1', { mailboxIds: ['in', 'tag-w'] }), email('e2')];
    const rd = readValues(
      input({
        emails,
        tagOf: (b) => (b === 'tag-w' ? { id: 'w', name: 'Important', color: 4 } : undefined),
        tagTree: [node('w', 'Important', 4), node('p', 'Projects', 1, [node('n', 'New', 1)])],
        tagPending: new Set(['n']),
      }),
    );
    expect(rd.tags.map((t) => t.label)).toEqual(['Important']);
    expect(rd.tg).toEqual({ open: false, exp: 'false', bg: 'transparent', c: 'var(--mfg)' });
    expect(rd.tgOpts).toEqual([
      {
        id: 'w',
        label: 'Important',
        dot: MA_COLORS[4][1],
        pl: '12px',
        on: 'true',
        ckBg: 'var(--ink)',
        ckRing: 'none',
        ckOp: 1,
      },
      {
        id: 'p',
        label: 'Projects',
        dot: MA_COLORS[1][1],
        pl: '12px',
        on: 'false',
        ckBg: 'transparent',
        ckRing: 'inset 0 0 0 2px var(--bdhi)',
        ckOp: 0,
      },
      expect.objectContaining({ id: 'n', pl: '28px', on: 'true' }),
    ]);
    expect(readValues(input({ menu: 'tag' })).tg).toEqual({
      open: true,
      exp: 'true',
      bg: 'var(--accsoft)',
      c: 'var(--deep)',
    });
  });

  it('orders the tags in the header like the tag list', () => {
    const rank: Record<string, number> = { a: 0, c: 1, b: 2 };
    const emails = [email('e1', { mailboxIds: ['in', 'mb-c'] }), email('e2', { mailboxIds: ['in', 'mb-a', 'mb-b'] })];
    const rd = readValues(
      input({
        emails,
        tagOf: (b) => {
          const id = b.slice(3);
          return b.startsWith('mb-') ? { id, name: id.toUpperCase(), color: 0, rank: rank[id] ?? 9 } : undefined;
        },
      }),
    );
    expect(rd.tags.map((t) => t.label)).toEqual(['A', 'C', 'B']);
  });

  it('offers inbox and folders for moving, without effect where the emails are', () => {
    const folder = (id: string, name: string, children: FolderNode[] = []): FolderNode => ({
      id,
      name,
      children,
      unread: 0,
      total: 0,
    });
    const move = {
      inbox: 'in',
      folders: [folder('a', 'Archive', [folder('a1', '2025')]), folder('p', 'Projects')],
      on: (b: string) => b === 'in',
    };
    const rd = readValues(input({ move, menu: 'move' }));
    expect(rd.mv.open).toBe(true);
    expect(rd.mvOpts).toEqual([
      {
        id: 'in',
        label: 'Inbox',
        icon: 'ti-inbox',
        sep: false,
        pl: '12px',
        dis: 'true',
        ckOp: 1,
        color: 'var(--mfg)',
        cursor: 'default',
      },
      {
        id: 'a',
        label: 'Archive',
        icon: 'ti-folder',
        sep: true,
        pl: '12px',
        dis: 'false',
        ckOp: 0,
        color: 'var(--fg)',
        cursor: 'pointer',
      },
      expect.objectContaining({ id: 'a1', sep: false, pl: '28px' }),
      expect.objectContaining({ id: 'p', sep: false, pl: '12px' }),
    ]);
    // Move sheet: own indentation, subject below, back from "More actions"; without an inbox no divider at the top.
    const mvp = moveValues('  ', { ...move, inbox: null }, true);
    expect(mvp).toMatchObject({ sub: '(No subject)', hasBack: true, noBack: false });
    expect(mvp.opts.map((o) => [o.id, o.pl, o.sep])).toEqual([
      ['a', '14px', false],
      ['a1', '32px', false],
      ['p', '14px', false],
    ]);
  });

  it('names the position in the list and the account in "All accounts"', () => {
    const rd = readValues(input({ multi: true, nav: { index: 0, total: 16, hasPrev: false, hasNext: true } }));
    expect(rd).toMatchObject({
      pos: '1 of 16',
      hasPos: true,
      prevOp: 0.35,
      prevCur: 'default',
      nextOp: 1,
      nextCur: 'pointer',
      multi: true,
      acctBg: MA_COLORS[2][1],
      acctMail: ME,
    });
  });

  it('inverts the message theme', () => {
    expect(readValues(input())).toMatchObject({
      thIcon: 'ti-sun',
      thTip: 'Email in light mode',
      thOn: 'false',
      thBg: 'transparent',
    });
    expect(readValues(input({ inverted: true }))).toMatchObject({
      thIcon: 'ti-moon',
      thTip: 'Email in dark mode',
      thOn: 'true',
      thBg: 'var(--accsoft)',
      thC: 'var(--deep)',
    });
  });
});

describe('readTheme', () => {
  it('sets the colours of the message mode, inverted as a card', () => {
    expect(readTheme(true, false)).toMatchObject({ m: '0', r: '0', scheme: 'dark', surface: MODES.dark['--surface'] });
    const light = readTheme(true, true);
    expect(light).toMatchObject({ m: '0 10px 10px', r: '24px', scheme: 'light', fg: MODES.light['--fg'] });
    expect(light.accsoft).toContain('26%');
    expect(readTheme(false, true).scheme).toBe('dark');
  });
});

describe('attachments', () => {
  it('chooses icon and extension', () => {
    expect(fileIcon('a.PDF')).toBe('ti-file-type-pdf');
    expect(fileIcon('a.docx')).toBe('ti-file-type-doc');
    expect(fileIcon('a.csv')).toBe('ti-file-spreadsheet');
    expect(fileIcon('a.jpeg')).toBe('ti-photo');
    expect(fileIcon('a.log')).toBe('ti-file-text');
    expect(fileIcon('a.zip')).toBe('ti-file');
    expect(fileIcon('File', 'image/png')).toBe('ti-photo');
    expect(fileExt('report.xlsx')).toBe('XLSX');
    expect(fileExt('File')).toBe('FILE');
  });

  it('names the size in KB or MB', () => {
    expect(fileSize(10)).toBe('1 KB');
    expect(fileSize(123_904)).toBe('121 KB');
    expect(fileSize(1_258_291)).toBe('1.2 MB');
  });

  it('names the attachment limit rounded down and without a trailing ".0"', () => {
    expect(limitText(25 * 1024 * 1024)).toBe('25 MB');
    expect(limitText(50_000_000)).toBe('47.6 MB');
    expect(limitText(500 * 1024)).toBe('500 KB');
    expect(limitText(900_000)).toBe('878 KB');
    expect(limitText(1000)).toBe('1000 B');
  });

  it('skips parts without a blob and names nameless attachments "File"', () => {
    const e = email('e1', {
      attachments: [att({ blobId: null }), att({ partId: '3', name: null, type: 'image/png', size: 2_000_000 })],
    });
    expect(readValues(input({ emails: [e] })).msgs[0]!.atts).toMatchObject([
      { name: 'File', icon: 'ti-photo', ext: 'FILE', size: '1.9 MB' },
    ]);
  });
});

describe('readTime', () => {
  it('names today, yesterday, tomorrow, otherwise weekday and date', () => {
    expect(readTime(NOW, T)).toBe('Today, 20:55');
    expect(readTime(NOW - 86_400_000, T)).toBe('Yesterday, 20:55');
    expect(readTime(NOW + 86_400_000, T)).toBe('Tomorrow, 20:55');
    expect(readTime(Date.parse('2026-10-20T07:56:00Z'), T)).toBe('Tue 20 Oct, 09:56');
    expect(readTime(Date.parse('2025-03-04T07:56:00Z'), T)).toBe('4 Mar 2025, 08:56');
  });
});

describe('HTML emails', () => {
  const htmlPart = (partId: string): MessagePart => att({ partId, name: null, type: 'text/html', size: 100 });
  const html = (value: string, patch: Partial<MessageEmail> = {}) =>
    email('e1', {
      htmlBody: [htmlPart('2')],
      bodyValues: { ...text('Text').bodyValues, '2': { value, isEncodingProblem: false, isTruncated: false } },
      ...patch,
    });
  const IMG = '<p>Hello</p><img src="https://cdn.example.com/a.png" width="600" height="200">';

  it('shows text mails as paragraphs, HTML in the iframe', () => {
    expect(readValues(input()).msgs[0]).toMatchObject({ isHtml: false, notHtml: true, hb: null });
    const msg = readValues(input({ emails: [html('<p>Hello</p>')] })).msgs[0]!;
    expect(msg).toMatchObject({ isHtml: true, notHtml: false });
    expect(msg.hb?.doc).toContain('<p>Hello</p>');
    expect(msg.hb?.showBar).toBe(false);
  });

  it('no document yet without a loaded renderer, with it the sanitized one', () => {
    const e = html('<p>Hello</p><script>alert(1)</script>');
    const before = readValues(input({ emails: [e], render: null })).msgs[0]!;
    expect(before).toMatchObject({ isHtml: true, notHtml: false });
    expect(before.hb).toMatchObject({ doc: null, showBar: false });
    const render = vi.fn(renderMail);
    const after = readValues(input({ emails: [e], render })).msgs[0]!.hb!.doc;
    expect(render).toHaveBeenCalledOnce();
    expect(after).toContain('<p>Hello</p>');
    expect(after).not.toContain('<script>');
  });

  it('blocks external images in "ask" mode with a banner', () => {
    const hb = readValues(input({ emails: [html(IMG)] })).msgs[0]!.hb!;
    expect(hb).toMatchObject({
      showBar: true,
      barTitle: 'External content blocked.',
      barSub: '1 image and tracking pixels from external servers weren’t loaded.',
      canAlways: true,
      sender: 'anna.baker@example.com',
    });
    expect(hb.doc).toContain('<rm-blocked');
  });

  it('loads for an allowed sender, once or always', () => {
    const e = html(IMG);
    const allowed = { extMode: 'ask', extAllow: ['anna.baker@example.com'] } as const;
    for (const patch of [
      { ext: { ...allowed, extAllow: [...allowed.extAllow] } },
      { once: new Set(['e1']) },
      { ext: { extMode: 'always' as const, extAllow: [] } },
    ]) {
      const hb = readValues(input({ emails: [e], ...patch })).msgs[0]!.hb!;
      expect(hb.showBar).toBe(false);
      expect(hb.doc).toContain('src="https://cdn.example.com/a.png"');
    }
    const never = readValues(input({ emails: [e], ext: { extMode: 'never', extAllow: ['anna.baker@example.com'] } }))
      .msgs[0]!.hb!;
    expect(never).toMatchObject({ showBar: true, barTitle: 'External content turned off.', canAlways: false });
  });

  it('shows embedded images in the text instead of with the attachments, failed ones as attachments', () => {
    const logo = att({ partId: '3', blobId: 'logo', name: 'logo.png', type: 'image/png', cid: 'logo@example.com' });
    const pdf = att({ partId: '4', blobId: 'pdf', name: 'a.pdf', type: 'application/pdf' });
    const e = html('<img src="cid:logo@example.com">', { attachments: [logo, pdf] });
    // While they load: text already there (without the image), image not among the attachments.
    const loading = readValues(input({ emails: [e] })).msgs[0]!;
    expect(loading.hb?.doc).toContain('<img');
    expect(loading.hb?.doc).not.toContain('src="blob:');
    expect(loading.atts.map((a) => a.name)).toEqual(['a.pdf']);
    const images = { e1: new Map([['logo@example.com', 'blob:http://localhost/logo']]) };
    const loaded = readValues(input({ emails: [e], images })).msgs[0]!;
    expect(loaded.hb?.doc).toContain('src="blob:http://localhost/logo"');
    expect(loaded.atts.map((a) => a.name)).toEqual(['a.pdf']);
    const failed = readValues(input({ emails: [e], images: { e1: new Map() } })).msgs[0]!;
    expect(failed.atts.map((a) => a.name)).toEqual(['logo.png', 'a.pdf']);
  });

  it('names images from the body of a text mail as attachments (mixed emails)', () => {
    const photo = att({ partId: '2', blobId: 'photo', name: 'photo.jpg', type: 'image/jpeg' });
    const e = email('e1', {
      textBody: [...text('Hello').textBody, photo],
      htmlBody: [...text('Hello').textBody, photo],
    });
    expect(readValues(input({ emails: [e] })).msgs[0]!.atts.map((a) => a.name)).toEqual(['photo.jpg']);
  });

  it('does not render collapsed emails and follows the message theme', () => {
    const older = html('<p>Old</p>', { id: 'e0', receivedAt: NOW - 1000 });
    const rd = readValues(input({ emails: [older, html('<p>New</p>')] }));
    expect(rd.msgs[0]).toMatchObject({ closed: true, isHtml: true });
    expect(rd.msgs[0]!.hb?.doc).toBeNull();
    const light = readValues(input({ emails: [html('<p>x</p>')], dark: false })).msgs[0]!.hb!.doc!;
    const dark = readValues(input({ emails: [html('<p>x</p>')], dark: true })).msgs[0]!.hb!.doc!;
    expect(light).toContain('color-scheme:light');
    expect(dark).toContain('color-scheme:dark');
    expect(readValues(input({ emails: [html('<p>x</p>')], isMobile: true })).msgs[0]!.hb!.doc).toContain(
      'padding:18px 16px',
    );
  });
});

describe('truncated parts', () => {
  const MIB = 1 << 20;
  const part = (partId: string, type: string, size: number): MessagePart =>
    att({ partId, blobId: `b${partId}`, name: null, type, size });
  const value = (v: string, isTruncated: boolean) => ({ value: v, isEncodingProblem: false, isTruncated });
  /** Text of 2.3 MB truncated; HTML of 4.5 MB and text of 1.1 MB truncated. */
  const longText = email('e1', {
    textBody: [part('1', 'text/plain', 2_411_724)],
    bodyValues: { '1': value('Log …', true) },
  });
  const longHtml = email('e1', {
    textBody: [part('1', 'text/plain', 1_153_434)],
    htmlBody: [part('2', 'text/html', 4_718_592)],
    bodyValues: { '1': value('Text', true), '2': value('<p>Issue 42</p><p>Typo', true) },
  });

  it('rounds the size in MB up to one decimal', () => {
    expect(truncSize(4_718_592)).toBe('4.5 MB');
    expect(truncSize(2_411_724)).toBe('2.3 MB');
    // Rounded up: just over 1.1 MB is 1.2 MB.
    expect(truncSize(1_153_434)).toBe('1.2 MB');
    expect(truncSize(MIB + 1)).toBe('1.1 MB');
    expect(truncSize(MIB * 3)).toBe('3.0 MB');
  });

  it('shows the notice for a truncated text', () => {
    const msg = readValues(input({ emails: [longText] })).msgs[0]!;
    expect(msg).toMatchObject({ notHtml: true, trunc: true });
    expect(msg.tr).toEqual({
      part: 'text',
      size: '2.3 MB',
      text: 'This message is very large (2.3 MB), so only part of it is shown.',
      busy: false,
      busyAttr: 'false',
      label: 'Load full message',
      cur: 'pointer',
    });
  });

  it('names only the shown HTML for truncated HTML and text', () => {
    const msg = readValues(input({ emails: [longHtml] })).msgs[0]!;
    expect(msg).toMatchObject({ isHtml: true, trunc: true });
    expect(msg.tr).toMatchObject({ part: 'html', size: '4.5 MB' });
    // Only the text truncated, the HTML complete: no notice.
    const textOnly = email('e1', {
      ...longHtml,
      bodyValues: { '1': value('Text', true), '2': value('<p>Complete</p>', false) },
    });
    expect(readValues(input({ emails: [textOnly] })).msgs[0]).toMatchObject({ trunc: false, tr: null });
  });

  it('adds up several truncated parts, text parts only', () => {
    const two = email('e1', {
      textBody: [part('1', 'text/plain', MIB * 2), part('2', 'text/plain', MIB), part('3', 'image/png', MIB * 9)],
      bodyValues: { '1': value('a', true), '2': value('b', true), '3': value('', true) },
    });
    expect(readValues(input({ emails: [two] })).msgs[0]!.tr?.size).toBe('3.0 MB');
  });

  it('shows nothing for complete parts and for collapsed emails', () => {
    expect(readValues(input()).msgs[0]).toMatchObject({ trunc: false, tr: null });
    const older = email('e0', { ...longText, id: 'e0', receivedAt: NOW - 1000 });
    const rd = readValues(input({ emails: [older, email('e1')] }));
    expect(rd.msgs[0]).toMatchObject({ closed: true, trunc: false, tr: null });
  });

  it('shows a spinner and "Loading …" while loading', () => {
    const tr = readValues(input({ emails: [longText], loadingFull: new Set(['e1']) })).msgs[0]!.tr;
    expect(tr).toMatchObject({ busy: true, busyAttr: 'true', label: 'Loading …', cur: 'progress' });
  });

  it('takes the app colours for the notice, even with an inverted message theme', () => {
    const app = readTheme(true, false);
    const rd = readValues(input({ dark: true, inverted: true }));
    expect(rd.tv.surface).not.toBe(app.surface);
    expect(rd.ui).toEqual({
      surface: app.surface,
      surface2: app.surface2,
      sunken: app.sunken,
      fg: app.fg,
      mfg: app.mfg,
      sh1: app.sh1,
    });
  });
});

describe('Offline', () => {
  const missing = (id: string, patch: Partial<MessageEmail> = {}) =>
    email(id, { textBody: [], bodyValues: {}, miss: true, ...patch });

  it('shows the card instead of the content for an email without text', () => {
    const [msg] = readValues(input({ emails: [missing('e1')] })).msgs;
    expect(msg).toMatchObject({
      miss: true,
      missText: 'It will load as soon as you’re back online.',
      isHtml: false,
      notHtml: false,
      hb: null,
      trunc: false,
      tr: null,
      paras: [],
    });
  });

  it('does not evaluate a known HTML without text either', () => {
    const html = {
      partId: '1',
      blobId: 'b',
      size: 1,
      name: null,
      type: 'text/html',
      charset: null,
      disposition: null,
      cid: null,
    };
    const [msg] = readValues(input({ emails: [missing('e1', { htmlBody: [html] })] })).msgs;
    expect(msg).toMatchObject({ miss: true, isHtml: false, notHtml: false, hb: null });
  });

  it('leaves emails with text unchanged', () => {
    const [msg] = readValues(input({ offline: true })).msgs;
    expect(msg).toMatchObject({ miss: false, isHtml: false, notHtml: true, paras: [{ t: 'Text e1' }] });
  });

  it('names the account when a sign-in is required', () => {
    const account = { email: ME, color: 2, state: 'needs_reauth' } as const;
    const [msg] = readValues(input({ emails: [missing('e1')], account })).msgs;
    expect(msg!.missText).toBe(`It will load as soon as you sign in to ${ME} again.`);
  });

  it('shows the preview when collapsed', () => {
    const emails = [missing('e1', { preview: 'Preview  from the list' }), email('e2')];
    const { msgs } = readValues(input({ emails, repId: 'e2' }));
    expect(msgs[0]).toMatchObject({ closed: true, miss: true, snip: 'Preview from the list' });
  });

  it('dims attachments without a connection', () => {
    const emails = [email('e1', { attachments: [att({})] })];
    expect(readValues(input({ emails })).msgs[0]!.atts[0]).toMatchObject({
      op: 1,
      dis: 'false',
      cur: 'pointer',
      tip: 'Download',
      dlIcon: 'ti-download',
      icon: 'ti-file-type-pdf',
    });
    expect(readValues(input({ emails, offline: true })).msgs[0]!.atts[0]).toMatchObject({
      op: 0.5,
      dis: 'true',
      cur: 'default',
      tip: 'Not saved offline',
      dlIcon: 'ti-cloud-off',
      icon: 'ti-file-type-pdf',
    });
  });

  it('keeps the attachments of an email without text', () => {
    const emails = [missing('e1', { attachments: [att({})] })];
    const [msg] = readValues(input({ emails, offline: true })).msgs;
    expect(msg).toMatchObject({ miss: true, hasAtts: true, attN: '1 attachment' });
  });
});

describe('sourceValues', () => {
  const actions = () => ({ close: vi.fn(), copy: vi.fn(), download: vi.fn() });

  it('is empty and `busy` while the source is loading', () => {
    expect(sourceValues(null, 'Subject', actions())).toMatchObject({ sub: 'Subject', head: [], body: '', busy: true });
  });

  it('shows header and body and closes only via the backdrop itself', () => {
    const a = actions();
    const parts = { head: [{ k: 'Subject', v: 'Hello' }], body: 'Text' };
    const src = sourceValues(parts, 'Hello', a);
    expect(src).toMatchObject({ head: parts.head, body: 'Text', busy: false, copy: a.copy, download: a.download });
    const scrim = {} as EventTarget;
    const preventDefault = vi.fn();
    src.overlay({ target: {} as EventTarget, currentTarget: scrim, preventDefault });
    expect(a.close).not.toHaveBeenCalled();
    src.overlay({ target: scrim, currentTarget: scrim, preventDefault });
    expect(a.close).toHaveBeenCalledOnce();
    // Otherwise `mousedown` would take the focus away from the button again.
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
