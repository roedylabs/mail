import type { Mailbox } from '@roedy/jmap';
import { describe, expect, it } from 'vitest';
import type { Tag } from '#lib/state/tags.svelte.ts';
import { sieveTargets } from './targets.ts';

function box(id: string, name: string, parentId: string | null = null): Mailbox {
  return {
    id,
    name,
    parentId,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    isSubscribed: true,
  };
}

function tag(id: string, name: string, overrides: Partial<Tag> = {}): Tag {
  return {
    id,
    name,
    parent_id: null,
    color: null,
    position: 0,
    links: [],
    created_at: '2026-11-09T10:00:00Z',
    ...overrides,
  };
}

const link = (mail_account_id: string, mailbox_id: string) => ({ mail_account_id, mailbox_id });

const BOXES = [
  box('inbox', 'Inbox'),
  box('m1', 'Archive'),
  box('m2', '2026', 'm1'),
  box('m3', 'Q4', 'm2'),
  box('tags', 'Tags'),
  box('m4', 'Important', 'tags'),
  box('m5', 'Projects', 'tags'),
  box('m6', 'Alpha-Folder', 'm5'),
];

const TAGS = [
  tag('t1', 'Important', { links: [link('a1', 'm4')] }),
  tag('t2', 'Projects'),
  tag('t3', 'Alpha', { parent_id: 't2', links: [link('a1', 'm6')] }),
  tag('t4', 'Beta', { parent_id: 't2', links: [link('a2', 'x9')] }),
  tag('t5', 'Lost', { links: [link('a1', 'deleted')] }),
];

describe('sieveTargets', () => {
  const targets = sieveTargets('a1', BOXES, TAGS);

  it('names folders with the full path', () => {
    expect(targets.folder('inbox')).toBe('Inbox');
    expect(targets.folder('m2')).toBe('Archive/2026');
    expect(targets.folder('m3')).toBe('Archive/2026/Q4');
  });

  it('does not know a deleted folder', () => {
    expect(targets.folder('deleted')).toBeNull();
  });

  it('uses the path of its mailbox in the account for a tag', () => {
    expect(targets.tag('t1')).toBe('Tags/Important');
    // The path of the mailbox applies, even if it is named differently from the tag.
    expect(targets.tag('t3')).toBe('Tags/Projects/Alpha-Folder');
  });

  it('uses Tags/<path of the tag> without a mailbox in the account', () => {
    expect(targets.tag('t2')).toBe('Tags/Projects');
    // The mailbox of another account does not count.
    expect(targets.tag('t4')).toBe('Tags/Projects/Beta');
    // The linked mailbox no longer exists.
    expect(targets.tag('t5')).toBe('Tags/Lost');
    expect(sieveTargets('a2', BOXES, TAGS).tag('t1')).toBe('Tags/Important');
    expect(sieveTargets('a2', BOXES, TAGS).tag('t3')).toBe('Tags/Projects/Alpha');
  });

  it('does not know an unknown tag', () => {
    expect(targets.tag('unknown')).toBeNull();
    expect(sieveTargets('a1', BOXES, []).tag('t1')).toBeNull();
  });

  it('survives cycles in folders and tags', () => {
    const cyclic = sieveTargets(
      'a1',
      [box('z1', 'One', 'z2'), box('z2', 'Two', 'z1')],
      [tag('c1', 'Left', { parent_id: 'c2' }), tag('c2', 'Right', { parent_id: 'c1' })],
    );
    expect(cyclic.folder('z1')).toBe('Two/One');
    expect(cyclic.tag('c1')).toBe('Tags/Right/Left');
    expect(cyclic.tag('c2')).toBe('Tags/Left/Right');
  });

  it('ends at a parent that does not exist', () => {
    const orphan = sieveTargets('a1', [box('k', 'Child', 'gone')], [tag('k', 'Child', { parent_id: 'gone' })]);
    expect(orphan.folder('k')).toBe('Child');
    expect(orphan.tag('k')).toBe('Tags/Child');
  });
});
