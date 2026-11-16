import { MA_COLORS } from '@roedy/tokens';
import { fireEvent, render, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { renderMail } from '#lib/mail/render.ts';
import { readValues, type ReadInput, type ReadValues } from '#lib/message-view.ts';
import type { MessageEmail } from '#lib/state/message.svelte.ts';
import type { TagNode } from '#lib/state/tags.svelte.ts';
import MessageMenu from './MessageMenu.svelte';

const NOW = Date.parse('2026-10-28T19:55:00Z');
const ME = 'account1@s1.test';

const EMAIL: MessageEmail = {
  id: 'e1',
  blobId: 'blob-e1',
  threadId: 't1',
  mailboxIds: ['in'],
  keywords: {},
  receivedAt: NOW - 3_600_000,
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
  textBody: [],
  htmlBody: [],
  attachments: [],
  bodyValues: {},
};

const tagNode = (id: string, name: string, color: number, children: TagNode[] = []): TagNode => ({
  id,
  name,
  color,
  children,
  unread: 0,
  total: 0,
});

/** Tag list: Important (on the email), Projects with New. */
const TAG_TREE = [tagNode('w', 'Important', 4), tagNode('p', 'Projects', 1, [tagNode('n', 'New', 1)])];

function values(patch: Partial<ReadInput> = {}): ReadValues {
  return readValues({
    emails: [{ ...EMAIL, mailboxIds: ['in', 'tag-w'] }],
    repId: null,
    kind: { role: 'inbox' },
    title: 'Inbox',
    account: { email: ME, color: 2, state: 'ok' },
    roles: { sent: 'sent', drafts: 'drafts', scheduled: 'sched', trash: 'trash', spam: 'spam' },
    multi: false,
    tagOf: (box) => (box === 'tag-w' ? { id: 'w', name: 'Important', color: 4 } : undefined),
    menu: null,
    tagTree: TAG_TREE,
    tagPending: new Set(),
    move: { inbox: 'in', folders: [], on: (box) => box === 'in' },
    time: { now: NOW, tz: 'Europe/Berlin', timeFmt: '24h', weekStart: 'monday', dateFmt: 'de' },
    folds: {},
    dark: false,
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
  });
}

function setup(rd: ReadValues = values(), level: 'more' | 'tag' = 'more') {
  const fns = {
    onSendNow: vi.fn(),
    onTag: vi.fn(),
    onMove: vi.fn(),
    onSpam: vi.fn(),
    onTheme: vi.fn(),
    onSource: vi.fn(),
    onBack: vi.fn(),
    onDone: vi.fn(),
    onTagPick: vi.fn(),
  };
  const view = render(MessageMenu, { rd, level, ...fns });
  const items = () => view.getAllByRole('menuitem').map((b) => b.textContent?.trim());
  return { view, items, ...fns };
}

describe('MessageMenu', () => {
  it('shows all actions in the inbox; each calls its action', async () => {
    const { view, items, onTag, onMove, onSpam, onTheme, onSource } = setup();
    expect(view.getByRole('menu', { name: 'More actions' })).toBeInTheDocument();
    expect(items()).toEqual(['Add tag', 'Move', 'Report spam', 'Email in dark mode', 'View source']);
    const pairs = [
      ['Add tag', onTag],
      ['Move', onMove],
      ['Report spam', onSpam],
      ['Email in dark mode', onTheme],
      ['View source', onSource],
    ] as const;
    for (const [name, fn] of pairs) {
      await fireEvent.click(view.getByRole('menuitem', { name }));
      expect(fn).toHaveBeenCalledOnce();
    }
  });

  it('shows "No spam" in spam and the light mode with a dark message', () => {
    const { view, items } = setup(values({ kind: { role: 'spam' }, dark: true }));
    expect(items()).toEqual(['Add tag', 'Move', 'Not spam', 'Email in light mode', 'View source']);
    const spam = view.getByRole('menuitem', { name: 'Not spam' });
    expect(spam.querySelector('.tabler-icon-shield-check')).not.toBeNull();
  });

  it('leaves out what the view does not allow', () => {
    expect(setup(values({ kind: { role: 'trash' } })).items()).toEqual(['Move', 'Email in dark mode', 'View source']);
  });

  it('offers "Send now" first in Scheduled, without move and spam', async () => {
    const { view, items, onSendNow } = setup(values({ kind: { role: 'scheduled' } }));
    expect(items()).toEqual(['Send now', 'Add tag', 'Email in dark mode', 'View source']);
    const now = view.getByRole('menuitem', { name: 'Send now' });
    expect(now.querySelector('.tabler-icon-send')).not.toBeNull();
    await fireEvent.click(now);
    expect(onSendNow).toHaveBeenCalledOnce();
    // Also a scheduled email in a tag view (after its mailbox).
    expect(
      setup(values({ kind: { tag: true }, emails: [{ ...EMAIL, mailboxIds: ['sched', 'tag-w'] }] })).items()[0],
    ).toBe('Send now');
  });

  it('offers neither move nor spam in drafts', () => {
    expect(setup(values({ kind: { role: 'drafts' } })).items()).toEqual([
      'Add tag',
      'Email in dark mode',
      'View source',
    ]);
  });

  it('shows back, title, "Done" and the tag list with check marks in the second level "Add tag"', async () => {
    const { view, onBack, onDone, onTagPick, onTag } = setup(values({ tagPending: new Set(['n']) }), 'tag');
    expect(view.queryByRole('menu', { name: 'More actions' })).toBeNull();
    expect(view.queryAllByRole('menuitem')).toHaveLength(0);
    expect(view.getByText('Add tag')).toHaveClass('t-title');
    const back = view.getByRole('button', { name: 'Back' });
    expect(back.querySelector('.tabler-icon-chevron-left')).not.toBeNull();
    const done = view.getByRole('button', { name: 'Done' });
    expect(done).toHaveClass('t-done');

    const menu = view.getByRole('menu', { name: 'Tags' });
    const opts = within(menu).getAllByRole('menuitemcheckbox');
    expect(opts.map((o) => [o.textContent, o.getAttribute('aria-checked'), o.style.paddingLeft])).toEqual([
      ['Important', 'true', '12px'],
      ['Projects', 'false', '12px'],
      ['New', 'true', '28px'],
    ]);
    const [important, projects] = opts;
    expect(important!.querySelector('.tag-i')).toHaveStyle({ color: MA_COLORS[4][1] });
    expect(important!.querySelector('.tag-i .tabler-icon-tag')).not.toBeNull();
    expect(important!.querySelector('.ck')!.getAttribute('style')).toContain('background: var(--ink)');
    expect(important!.querySelector('.ck-i')).toHaveStyle({ opacity: '1' });
    expect(important!.querySelector('.ck-i .tabler-icon-check')).not.toBeNull();
    expect(projects!.querySelector('.ck')!.getAttribute('style')).toContain('box-shadow: inset 0 0 0 2px var(--bdhi)');
    expect(projects!.querySelector('.ck-i')).toHaveStyle({ opacity: '0' });

    await fireEvent.click(projects!);
    await fireEvent.click(important!);
    expect(onTagPick.mock.calls).toEqual([['p'], ['w']]);
    await fireEvent.click(back);
    expect(onBack).toHaveBeenCalledOnce();
    await fireEvent.click(done);
    expect(onDone).toHaveBeenCalledOnce();
    expect(onTag).not.toHaveBeenCalled();
  });

  it('switches between the levels when `level` changes', async () => {
    const { view, items } = setup();
    expect(items()).toHaveLength(5);
    await view.rerender({ level: 'tag' });
    expect(view.getByRole('menu', { name: 'Tags' })).toBeInTheDocument();
    expect(view.queryByRole('menu', { name: 'More actions' })).toBeNull();
    await view.rerender({ level: 'more' });
    expect(view.getByRole('menu', { name: 'More actions' })).toBeInTheDocument();
    expect(view.queryByRole('menu', { name: 'Tags' })).toBeNull();
  });
});
