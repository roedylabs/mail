import { describe, expect, it } from 'vitest';
import { ApiError, NetworkError } from '#lib/api.ts';
import { TagFixError, type Tag, type TagProblem } from '#lib/state/tags.svelte.ts';
import { tagFixError, tagFixToast } from '#lib/tag-fix.ts';

const tag = (id: string, name: string): Tag => ({
  id,
  name,
  parent_id: null,
  color: null,
  position: 0,
  links: [],
  created_at: '2026-10-28T10:00:00Z',
});

const TAGS = [tag('follow-up', 'Follow up'), tag('waiting', 'Waiting for reply'), tag('old', 'Old')];
const outside: TagProblem = {
  kind: 'outside',
  account: 'm1',
  tag: 'follow-up',
  mailbox: 'n',
  path: 'Archive/Follow up',
};
const renamed: TagProblem = {
  kind: 'renamed',
  account: 'm1',
  tag: 'waiting',
  mailbox: 'w',
  name: 'Waiting',
  path: null,
};
const unlinked = (link: string | null): TagProblem => ({
  kind: 'unlinked',
  account: 'm1',
  mailbox: 'a',
  name: 'Old',
  path: 'Tags/Old',
  kids: 1,
  parent: null,
  link,
});

describe('tagFixToast', () => {
  it('names the name per action', () => {
    expect(tagFixToast(outside, 'unlink', TAGS)).toBe('Unlinked');
    expect(tagFixToast(outside, 'back', TAGS)).toBe('Mailbox “Follow up” moved back');
    expect(tagFixToast(renamed, 'align', TAGS)).toBe('Mailbox “Waiting for reply” updated');
    expect(tagFixToast(renamed, 'take', TAGS)).toBe('Tag “Waiting” renamed');
    expect(tagFixToast(unlinked(null), 'adopt', TAGS)).toBe('Tag “Old” added');
    expect(tagFixToast(unlinked('old'), 'adopt', TAGS)).toBe('Tag “Old” linked');
    expect(tagFixToast(unlinked(null), 'toFolder', TAGS)).toBe('“Old” moved to folders');
  });
});

describe('tagFixError', () => {
  it('names a taken name, otherwise like other changes (without an API response "No connection")', () => {
    expect(tagFixError(new TagFixError('tag', 'Waiting'))).toBe('A tag named “Waiting” already exists at this level.');
    expect(tagFixError(new TagFixError('folder', 'Old'))).toBe('A folder named “Old” already exists there.');
    expect(tagFixError(new ApiError(500, { error: 'internal' }))).toBe('Change not saved. Please try again.');
    expect(tagFixError(new NetworkError(new TypeError('offline')))).toBe('No connection. Please try again.');
  });
});
