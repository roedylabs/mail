import { describe, expect, it } from 'vitest';
import { EMAIL_PUSH, WEBPUSH_VAPID } from './core.ts';
import { JmapError } from './errors.ts';
import {
  createPushSubscription,
  destroyPushSubscriptions,
  listPushSubscriptions,
  parsePushObject,
  renewPushSubscription,
  verifyPushSubscription,
  webPushKey,
} from './push.ts';
import { parseSession } from './session.ts';
import { bodyOf, fakeFetch, jmapResponse, SERVER, sessionJson, testClient } from './testing.ts';

const NEW = {
  deviceClientId: 'device',
  url: 'https://push.example.test/abc',
  keys: { p256dh: 'p', auth: 'a' },
  types: ['EmailDelivery'],
};

function sessionWith(capabilities: Record<string, unknown>) {
  const json = sessionJson();
  return parseSession({ ...json, capabilities: { ...(json.capabilities as object), ...capabilities } }, SERVER);
}

interface Sent {
  using: string[];
  methodCalls: [string, Record<string, unknown>, string][];
}

describe('webPushKey', () => {
  it('reads applicationServerKey from the capability', () => {
    expect(webPushKey(sessionWith({ [WEBPUSH_VAPID]: { applicationServerKey: 'BKey' } }))).toBe('BKey');
  });

  it('is null without VAPID or without a key', () => {
    expect(webPushKey(sessionWith({}))).toBeNull();
    expect(webPushKey(sessionWith({ [WEBPUSH_VAPID]: {} }))).toBeNull();
    expect(webPushKey(sessionWith({ [WEBPUSH_VAPID]: { applicationServerKey: '' } }))).toBeNull();
  });
});

describe('subscriptions', () => {
  it('lists all subscriptions without accountId', async () => {
    const server = fakeFetch(
      jmapResponse('s1', [
        'PushSubscription/get',
        { list: [{ id: 'p1', deviceClientId: 'device', expires: '2026-11-13T10:00:00Z' }], notFound: [] },
        'c0',
      ]),
    );
    const list = await listPushSubscriptions(testClient(server.fetch));
    expect(list.map((entry) => entry.id)).toEqual(['p1']);
    const sent = bodyOf(server.seen.at(-1)) as Sent;
    expect(sent.methodCalls[0]?.[1]).toEqual({ ids: null });
  });

  it('creates and returns id and expiry', async () => {
    const server = fakeFetch(
      jmapResponse('s1', [
        'PushSubscription/set',
        { created: { push: { id: 'p1', keys: null, expires: '2026-11-13T10:00:00Z' } } },
        'c0',
      ]),
    );
    const created = await createPushSubscription(testClient(server.fetch), NEW);
    expect(created).toEqual({ id: 'p1', expires: '2026-11-13T10:00:00Z' });
    const sent = bodyOf(server.seen.at(-1)) as Sent;
    expect(sent.using).not.toContain(EMAIL_PUSH);
    expect(sent.methodCalls[0]?.[1]).toEqual({ create: { push: NEW } });
  });

  it('declares emailPush in using', async () => {
    const server = fakeFetch(jmapResponse('s1', ['PushSubscription/set', { created: { push: { id: 'p1' } } }, 'c0']));
    const emailPush = { a1: { filter: { inMailbox: 'inbox' }, properties: ['id' as const] } };
    const json = sessionJson();
    const session = { ...json, capabilities: { ...(json.capabilities as object), [EMAIL_PUSH]: {} } };
    await createPushSubscription(testClient(server.fetch, { session }), { ...NEW, emailPush });
    expect((bodyOf(server.seen.at(-1)) as Sent).using).toContain(EMAIL_PUSH);
  });

  it("throws on notCreated with the server's type and text", async () => {
    const server = fakeFetch(
      jmapResponse('s1', [
        'PushSubscription/set',
        { notCreated: { push: { type: 'invalidProperties', description: 'Host is not a public domain name' } } },
        'c0',
      ]),
    );
    const error = await createPushSubscription(testClient(server.fetch), NEW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JmapError);
    expect(error).toMatchObject({
      kind: 'request',
      details: { type: 'invalidProperties', detail: 'Host is not a public domain name' },
    });
  });

  it('verifies with the code', async () => {
    const server = fakeFetch(jmapResponse('s1', ['PushSubscription/set', { updated: { p1: null } }, 'c0']));
    await verifyPushSubscription(testClient(server.fetch), 'p1', 'code');
    const sent = bodyOf(server.seen.at(-1)) as Sent;
    expect(sent.methodCalls[0]?.[1]).toEqual({ update: { p1: { verificationCode: 'code' } } });
  });

  it('throws on a wrong code', async () => {
    const server = fakeFetch(
      jmapResponse('s1', ['PushSubscription/set', { notUpdated: { p1: { type: 'invalidProperties' } } }, 'c0']),
    );
    await expect(verifyPushSubscription(testClient(server.fetch), 'p1', 'wrong')).rejects.toBeInstanceOf(JmapError);
  });

  it('renews via expires', async () => {
    const server = fakeFetch(jmapResponse('s1', ['PushSubscription/set', { updated: { p1: null } }, 'c0']));
    await renewPushSubscription(testClient(server.fetch), 'p1', '2026-11-20T10:00:00Z');
    const sent = bodyOf(server.seen.at(-1)) as Sent;
    expect(sent.methodCalls[0]?.[1]).toEqual({ update: { p1: { expires: '2026-11-20T10:00:00Z' } } });
  });

  it('throws when the server rejects the renewal', async () => {
    const server = fakeFetch(
      jmapResponse('s1', ['PushSubscription/set', { notUpdated: { p1: { type: 'notFound' } } }, 'c0']),
    );
    await expect(renewPushSubscription(testClient(server.fetch), 'p1', 'x')).rejects.toBeInstanceOf(JmapError);
  });

  it('removes and treats missing ones as removed', async () => {
    const server = fakeFetch(
      jmapResponse('s1', [
        'PushSubscription/set',
        { destroyed: ['p1'], notDestroyed: { p2: { type: 'notFound' } } },
        'c0',
      ]),
    );
    await destroyPushSubscriptions(testClient(server.fetch), ['p1', 'p2']);
    expect((bodyOf(server.seen.at(-1)) as Sent).methodCalls[0]?.[1]).toEqual({ destroy: ['p1', 'p2'] });
  });

  it('throws on other errors when removing', async () => {
    const server = fakeFetch(
      jmapResponse('s1', ['PushSubscription/set', { notDestroyed: { p1: { type: 'forbidden' } } }, 'c0']),
    );
    await expect(destroyPushSubscriptions(testClient(server.fetch), ['p1'])).rejects.toBeInstanceOf(JmapError);
  });

  it('does not ask the server without ids', async () => {
    const server = fakeFetch();
    await destroyPushSubscriptions(testClient(server.fetch), []);
    expect(server.seen).toHaveLength(0);
  });
});

describe('parsePushObject', () => {
  it('parses PushVerification', () => {
    const raw = JSON.stringify({ '@type': 'PushVerification', pushSubscriptionId: 'p1', verificationCode: 'c' });
    expect(parsePushObject(raw)).toEqual({ type: 'PushVerification', pushSubscriptionId: 'p1', verificationCode: 'c' });
  });

  it('parses StateChange', () => {
    const raw = JSON.stringify({ '@type': 'StateChange', changed: { a1: { EmailDelivery: 's2' } } });
    expect(parsePushObject(raw)).toEqual({ type: 'StateChange', changed: { a1: { EmailDelivery: 's2' } } });
  });

  it('parses EmailPush with and without state', () => {
    const raw = { '@type': 'EmailPush', accountId: 'a1', emails: [{ id: 'e1', threadId: 't1' }] };
    expect(parsePushObject(JSON.stringify({ ...raw, state: 's2' }))).toEqual({
      type: 'EmailPush',
      accountId: 'a1',
      emails: [{ id: 'e1', threadId: 't1' }],
      state: 's2',
    });
    expect(parsePushObject(JSON.stringify(raw))).toMatchObject({ state: null });
  });

  it('returns null for everything else', () => {
    for (const raw of [
      null,
      undefined,
      '',
      'not JSON',
      '3',
      '{}',
      '{"@type":"Unknown"}',
      '{"@type":"PushVerification","pushSubscriptionId":"p1"}',
      '{"@type":"StateChange"}',
      '{"@type":"EmailPush","accountId":"a1"}',
    ]) {
      expect(parsePushObject(raw)).toBeNull();
    }
  });
});
