import { describe, expect, it } from 'vitest';
import {
  applyEdit,
  cancelEdits,
  flagEdits,
  folderEdits,
  inSource,
  isMove,
  mergeEdit,
  movedElsewhere,
  netEdit,
  notSpamEdits,
  patchOf,
  purgeEdits,
  restoreEdits,
  restoreTarget,
  scheduledTrashEdits,
  seenEdits,
  spamEdits,
  tagEdits,
  trashEdits,
  unscheduleEdit,
  type ActionEmail,
  type ActionRoles,
  type EmailEdit,
} from './mail-actions.ts';

const ROLES: ActionRoles = {
  inbox: 'in',
  sent: 'sent',
  drafts: 'drafts',
  scheduled: 'sched',
  trash: 'trash',
  spam: 'spam',
};
const isTag = (box: string) => box.startsWith('tag');

const email = (id: string, mailboxIds: string[], keywords: Record<string, true> = {}, from = ''): ActionEmail => ({
  id,
  mailboxIds,
  keywords,
  from,
});

describe('patches', () => {
  it('sets and removes keywords and mailboxes with escaped paths', () => {
    expect(patchOf({ keywords: { $seen: true, 'a/b~c': false }, mailboxIds: { in: false, trash: true } })).toEqual({
      'keywords/$seen': true,
      'keywords/a~1b~0c': null,
      'mailboxIds/in': null,
      'mailboxIds/trash': true,
    });
  });

  it('combines consecutive changes; delete wins', () => {
    expect(mergeEdit({ keywords: { $seen: true } }, { keywords: { $seen: false, $flagged: true } })).toEqual({
      keywords: { $seen: false, $flagged: true },
      mailboxIds: {},
    });
    expect(mergeEdit({ keywords: { $seen: true } }, { destroyed: true })).toEqual({ destroyed: true });
    expect(mergeEdit(undefined, { mailboxIds: { in: false } })).toEqual({ mailboxIds: { in: false } });
  });

  it('puts a change over an email without modifying it', () => {
    const e = { id: 'e1', mailboxIds: ['in', 'tag1'], keywords: { $seen: true } as Record<string, true> };
    const next = applyEdit(e, { keywords: { $seen: false, $flagged: true }, mailboxIds: { in: false, trash: true } });
    expect(next).toEqual({ id: 'e1', mailboxIds: ['tag1', 'trash'], keywords: { $flagged: true } });
    expect(e.keywords).toEqual({ $seen: true });
    expect(applyEdit(e, undefined)).toBe(e);
    expect(applyEdit(e, { destroyed: true })).toBeNull();
  });
});

describe('actions', () => {
  it('recognizes emails of the view like the list filter', () => {
    const source = { boxes: ['tag1', 'tag2'], exclude: ['trash', 'spam'] };
    expect(inSource(['in', 'tag2'], source)).toBe(true);
    expect(inSource(['trash', 'tag1'], source)).toBe(false);
    expect(inSource(['in'], source)).toBe(false);
  });

  it('changes read and flagged only where it changes', () => {
    const list = [email('a', ['in'], { $seen: true }), email('b', ['in'])];
    expect([...seenEdits(list, true)]).toEqual([['b', { keywords: { $seen: true } }]]);
    expect([...seenEdits(list, false)]).toEqual([['a', { keywords: { $seen: false } }]]);
    expect([...flagEdits(list, true).keys()]).toEqual(['a', 'b']);
    expect(flagEdits(list, false).size).toBe(0);
  });

  it('moves to the trash on delete, keeps tags and leaves scheduled ones', () => {
    const out = trashEdits(
      [email('a', ['in', 'tag1', 'proj']), email('b', ['sched']), email('c', ['trash'])],
      ROLES,
      isTag,
    );
    expect([...out]).toEqual([['a', { mailboxIds: { in: false, proj: false, trash: true } }]]);
    expect(trashEdits([email('a', ['in'])], { ...ROLES, trash: null }, isTag).size).toBe(0);
  });

  it('cancels in Scheduled: to drafts or to the trash, with $draft instead of $scheduled', () => {
    const planned = [email('a', ['sched', 'tag1'], { $scheduled: true }), email('b', ['in'])];
    expect([...cancelEdits(planned, ROLES)]).toEqual([
      ['a', { mailboxIds: { sched: false, drafts: true }, keywords: { $scheduled: false, $draft: true } }],
    ]);
    expect([...scheduledTrashEdits(planned, ROLES, isTag)]).toEqual([
      ['a', { mailboxIds: { sched: false, trash: true }, keywords: { $scheduled: false, $draft: true } }],
    ]);
    expect(unscheduleEdit('sent', ROLES)).toEqual({
      mailboxIds: { sched: false, sent: true },
      keywords: { $scheduled: false },
    });
    // Without a target it stays in Scheduled, just without $scheduled.
    expect(unscheduleEdit('drafts', { ...ROLES, drafts: null })).toEqual({
      keywords: { $scheduled: false, $draft: true },
    });
  });

  it('reports spam with $junk and brings it back to the inbox with $notjunk', () => {
    expect([...spamEdits([email('a', ['in'], { $notjunk: true })], ROLES, isTag)]).toEqual([
      ['a', { mailboxIds: { in: false, spam: true }, keywords: { $junk: true, $notjunk: false } }],
    ]);
    expect([...notSpamEdits([email('a', ['spam', 'tag1'], { $junk: true })], ROLES, isTag)]).toEqual([
      ['a', { mailboxIds: { spam: false, in: true }, keywords: { $junk: false, $notjunk: true } }],
    ]);
  });

  it('restores drafts to drafts, own ones to sent and the rest to the inbox', () => {
    const own = 'me@example.com';
    expect(restoreTarget(email('a', ['trash'], { $draft: true }), ROLES, own)).toBe('drafts');
    expect(restoreTarget(email('a', ['trash'], {}, own), ROLES, own)).toBe('sent');
    expect(restoreTarget(email('a', ['trash'], {}, 'anna@example.com'), ROLES, own)).toBe('in');
    expect(restoreTarget(email('a', ['trash'], { $draft: true }), { ...ROLES, drafts: null }, own)).toBe('in');
    expect(restoreTarget(email('a', ['trash'], {}, ''), ROLES, '')).toBe('in');
    expect([...restoreEdits([email('a', ['trash', 'tag1'], {}, own)], ROLES, isTag, 'Me@Example.com')]).toEqual([
      ['a', { mailboxIds: { trash: false, sent: true } }],
    ]);
  });

  it('deletes permanently what is only in the trash and only takes the rest out of the trash', () => {
    expect([...purgeEdits([email('a', ['trash', 'tag1']), email('b', ['trash', 'proj'])], 'trash', isTag)]).toEqual([
      ['a', { destroyed: true }],
      ['b', { mailboxIds: { trash: false } }],
    ]);
  });

  it('moves to a folder with the tags, leaves scheduled ones and reports when all are already there', () => {
    expect([...folderEdits([email('a', ['in', 'tag1']), email('b', ['sched'])], 'proj', ROLES, isTag)]).toEqual([
      ['a', { mailboxIds: { in: false, proj: true } }],
    ]);
    expect(folderEdits([email('a', ['proj', 'tag1'])], 'proj', ROLES, isTag).size).toBe(0);
    expect([...folderEdits([email('a', ['proj', 'in'])], 'proj', ROLES, isTag)]).toEqual([
      ['a', { mailboxIds: { in: false } }],
    ]);
    // Out of spam like "Not spam".
    expect([...folderEdits([email('a', ['spam'], { $junk: true })], 'proj', ROLES, isTag)]).toEqual([
      ['a', { mailboxIds: { spam: false, proj: true }, keywords: { $junk: false, $notjunk: true } }],
    ]);
  });

  it('sets and removes a tag only on the emails that change', () => {
    const emails = [email('a', ['in', 'tag1']), email('b', ['in'])];
    expect([...tagEdits(emails, 'tag1', true)]).toEqual([['b', { mailboxIds: { tag1: true } }]]);
    expect([...tagEdits(emails, 'tag1', false)]).toEqual([['a', { mailboxIds: { tag1: false } }]]);
    expect(tagEdits(emails, 'tag2', false).size).toBe(0);
    // Without another mailbox the email would be left without a mailbox.
    expect(tagEdits([email('c', ['tag1'])], 'tag1', false).size).toBe(0);
  });
});

describe('moves in the queue', () => {
  const MOVE = { mailboxIds: { in: false, trash: true } };

  it('recognizes a move: out of one mailbox and into another', () => {
    expect(isMove(MOVE)).toBe(true);
    expect(isMove({ mailboxIds: { in: false, proj: false, trash: true }, keywords: { $junk: true } })).toBe(true);
  });

  it('does not count tags, plain removal and keywords as a move', () => {
    expect(isMove({ mailboxIds: { tag1: true } })).toBe(false);
    expect(isMove({ mailboxIds: { tag1: false } })).toBe(false);
    expect(isMove({ mailboxIds: {} })).toBe(false);
    expect(isMove({ keywords: { $seen: true } })).toBe(false);
    expect(isMove({ destroyed: true })).toBe(false);
    expect(isMove({})).toBe(false);
  });

  it('accepts an email that is still at the source', () => {
    expect(movedElsewhere(MOVE, ['in'])).toBe(false);
    expect(movedElsewhere(MOVE, ['in', 'tag1'])).toBe(false);
    expect(movedElsewhere({ mailboxIds: { in: false, proj: false, trash: true } }, ['proj'])).toBe(false);
  });

  it('accepts an email that is already at the target', () => {
    expect(movedElsewhere(MOVE, ['trash'])).toBe(false);
    expect(movedElsewhere(MOVE, ['in', 'trash'])).toBe(false);
  });

  it('recognizes an email another device has moved elsewhere', () => {
    expect(movedElsewhere(MOVE, ['archive'])).toBe(true);
    expect(movedElsewhere(MOVE, ['archive', 'tag1'])).toBe(true);
    expect(movedElsewhere(MOVE, [])).toBe(true);
  });

  it('knows no conflict for a pure tag change', () => {
    expect(movedElsewhere({ mailboxIds: { tag1: true } }, ['archive'])).toBe(false);
    expect(movedElsewhere({ mailboxIds: { tag1: false } }, ['archive'])).toBe(false);
    expect(movedElsewhere({ keywords: { $seen: true } }, ['archive'])).toBe(false);
  });
});

describe('netEdit', () => {
  const STAR_ON: EmailEdit = { keywords: { $flagged: true } };
  const STAR_OFF: EmailEdit = { keywords: { $flagged: false } };
  /** Changes in their order, as the queue combines them. */
  const fold = (...edits: EmailEdit[]) =>
    edits.reduce<EmailEdit | undefined>((net, edit) => netEdit(net, edit), undefined);

  it('takes the first change unchanged', () => {
    expect(netEdit(undefined, STAR_ON)).toEqual(STAR_ON);
  });

  it('cancels star on and off', () => {
    expect(netEdit(STAR_ON, STAR_OFF)).toBeUndefined();
    expect(netEdit(STAR_OFF, STAR_ON)).toBeUndefined();
  });

  it('leaves the on from on, off, on', () => {
    expect(fold(STAR_ON, STAR_OFF, STAR_ON)).toEqual(STAR_ON);
    expect(fold(STAR_ON, STAR_OFF, STAR_ON, STAR_OFF)).toBeUndefined();
  });

  it('cancels trash and back', () => {
    expect(
      fold({ mailboxIds: { in: false, trash: true } }, { mailboxIds: { trash: false, in: true } }),
    ).toBeUndefined();
  });

  it('turns inbox → trash → archive into a move to the archive', () => {
    expect(fold({ mailboxIds: { in: false, trash: true } }, { mailboxIds: { trash: false, archive: true } })).toEqual({
      mailboxIds: { in: false, archive: true },
    });
  });

  it('also cancels a round trip over three folders', () => {
    expect(
      fold(
        { mailboxIds: { in: false, trash: true } },
        { mailboxIds: { trash: false, archive: true } },
        { mailboxIds: { archive: false, in: true } },
      ),
    ).toBeUndefined();
  });

  it('keeps the same value', () => {
    expect(netEdit(STAR_ON, STAR_ON)).toEqual(STAR_ON);
    expect(netEdit({ mailboxIds: { tag1: true } }, { mailboxIds: { tag1: true } })).toEqual({
      mailboxIds: { tag1: true },
    });
  });

  it('treats keywords and mailboxes independently', () => {
    expect(netEdit({ keywords: { $flagged: true }, mailboxIds: { tag1: true } }, STAR_OFF)).toEqual({
      mailboxIds: { tag1: true },
    });
    expect(
      netEdit({ keywords: { $flagged: true }, mailboxIds: { tag1: true } }, { mailboxIds: { tag1: false } }),
    ).toEqual({ keywords: { $flagged: true } });
  });

  it('cancels only the key that has both values', () => {
    expect(netEdit({ keywords: { $flagged: true, $seen: true } }, STAR_OFF)).toEqual({ keywords: { $seen: true } });
    expect(netEdit(STAR_ON, { keywords: { $seen: false } })).toEqual({ keywords: { $flagged: true, $seen: false } });
  });

  it('does not change the inputs', () => {
    const first: EmailEdit = { keywords: { $flagged: true, $seen: true } };
    netEdit(first, STAR_OFF);
    expect(first).toEqual({ keywords: { $flagged: true, $seen: true } });
  });
});
