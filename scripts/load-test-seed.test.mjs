// Tests of the fill script for the load test (node --test scripts/): plan of
// the emails (count, folders, conversations, search words, fixed seed), create
// objects for `Email/set` and contact cards. It only runs against Stalwart in
// scripts/load-test.sh.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ATTACHMENTS, FOLDERS, SEARCH, countByFolder, planCards, planMails, toEmail } from './load-test-seed.mjs';

describe('planMails', () => {
  const mails = planMails({ count: 20_000 });

  test('exactly the requested count, always the same with a fixed seed', () => {
    assert.equal(mails.length, 20_000);
    assert.deepEqual(planMails({ count: 500 }), planMails({ count: 500 }));
    assert.notDeepEqual(planMails({ count: 500, seed: 1 }), planMails({ count: 500 }));
  });

  test('all folders used, sent only with own replies', () => {
    const counts = countByFolder(mails);
    for (const f of FOLDERS) assert.ok(counts[f.key] > 0, f.key);
    assert.ok(counts.sent > 0.08 * mails.length && counts.sent < 0.25 * mails.length, `sent ${counts.sent}`);
    assert.ok(mails.filter((m) => m.folder === 'sent').every((m) => m.from.email === 'user@example.test'));
  });

  test('conversations chain message IDs and subject', () => {
    const byThread = Map.groupBy(mails, (m) => m.thread);
    assert.ok(byThread.size < mails.length * 0.6);
    for (const thread of byThread.values()) {
      const [first, ...rest] = thread;
      assert.equal(first.inReplyTo, null);
      for (const [i, m] of rest.entries()) {
        assert.equal(m.subject, `Re: ${first.subject}`);
        assert.equal(m.inReplyTo, thread[i].messageId);
        assert.deepEqual(
          m.references,
          thread.slice(0, i + 1).map((t) => t.messageId),
        );
        assert.ok(m.receivedAt >= thread[i].receivedAt);
      }
    }
  });

  test('rare and common search words, attachments and unread present', () => {
    const rare = new Set(mails.filter((m) => m.subject.includes(SEARCH.rare)).map((m) => m.thread));
    assert.equal(rare.size, Math.min(SEARCH.rareThreads, Math.ceil(new Set(mails.map((m) => m.thread)).size / 97)));
    const common = mails.filter((m) => m.subject.includes(SEARCH.common)).length;
    assert.ok(common > 0.01 * mails.length && common < 0.05 * mails.length, `common ${common}`);
    assert.ok(mails.some((m) => m.attachments.length === 2));
    assert.ok(mails.every((m) => m.attachments.every((i) => i >= 0 && i < ATTACHMENTS.length)));
    assert.ok(mails.some((m) => !m.keywords.$seen));
  });

  test('search index marker in the last email, empty plan without error', () => {
    assert.ok(mails.at(-1).body.startsWith(SEARCH.last));
    assert.equal(mails.filter((m) => m.body.includes(SEARCH.last)).length, 1);
    assert.deepEqual(planMails({ count: 0 }), []);
  });

  test('only domains per RFC 6761', () => {
    for (const m of mails) {
      for (const addr of [m.from.email, m.to.email]) assert.match(addr, /@[a-z.]+\.test$/, addr);
      assert.match(m.messageId, /@load-test\.test$/);
    }
  });
});

test('toEmail: mailbox, text or HTML, attachments and references', () => {
  const [first, reply] = planMails({ count: 2000 }).filter(
    (m, _, all) => all.filter((o) => o.thread === m.thread).length > 1,
  );
  const boxes = Object.fromEntries([...FOLDERS.map((f) => [f.key, `id-${f.key}`]), ['sent', 'id-sent']]);
  const email = toEmail({ ...reply, attachments: [1], html: true }, boxes, ['b0', 'b1', 'b2', 'b3']);
  assert.deepEqual(email.mailboxIds, { [`id-${reply.folder}`]: true });
  assert.deepEqual(email.inReplyTo, [first.messageId]);
  assert.match(email.bodyValues.b.value, /^<html><body><p>/);
  assert.deepEqual(email.attachments, [
    { blobId: 'b1', type: 'image/png', name: 'Photo.png', disposition: 'attachment' },
  ]);
  const plain = toEmail({ ...first, attachments: [] }, boxes, []);
  assert.equal(plain.inReplyTo, undefined);
  assert.equal(plain.attachments, undefined);
  assert.equal(plain.textBody[0].type, 'text/plain');
});

test('planCards: unique addresses per prefix', () => {
  const a = planCards(500, 'k1-');
  const b = planCards(500, 'k2-');
  assert.equal(new Set(a.map((c) => c.email)).size, 500);
  assert.equal(a.filter((c) => b.some((o) => o.email === c.email)).length, 0);
});
