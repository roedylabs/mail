import type { Identity } from '@roedy/jmap';
import type { JmapClient } from '@roedy/jmap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '#lib/api.ts';
import { LoadFailed } from '#lib/mail-account.svelte.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { compose } from '#lib/state/compose.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  Identities,
  identities,
  identitiesValues,
  identityPatch,
  IdentityRefused,
  jmapIdentityApi,
  parseReplyTo,
  replyText,
  type IdentityApi,
} from './identities.svelte.ts';

function identity(overrides: Partial<Identity> = {}): Identity {
  return {
    id: 'i1',
    name: 'Julian Schubert',
    email: 'account1@s1.test',
    replyTo: null,
    bcc: null,
    textSignature: '',
    htmlSignature: '',
    mayDelete: false,
    ...overrides,
  };
}

const ACCOUNT: MailAccount = {
  id: 'a1',
  email: 'account1@s1.test',
  username: 'account1@s1.test',
  url: 'https://mail.s1.test',
  host: 'mail.s1.test',
  server_id: 's1',
  auth_kind: 'oauth',
  color: 0,
  state: 'ok',
  blocked: false,
  quota_used: null,
  quota_total: null,
  last_check_at: null,
  created_at: '2026-10-27T10:00:00Z',
};

function fakeApi(list: Identity[]) {
  return {
    list: vi.fn<IdentityApi['list']>(() => Promise.resolve(list)),
    update: vi.fn<IdentityApi['update']>((_a, id, patch) =>
      Promise.resolve(list.map((i): Identity => (i.id === id ? { ...i, ...patch } : i))),
    ),
  };
}

beforeEach(() => {
  accounts.reset();
  accounts.list = [ACCOUNT];
});

afterEach(() => {
  identities.reset();
  accounts.reset();
  ui.reset();
  vi.restoreAllMocks();
});

describe('reply addresses', () => {
  it('shows several addresses with commas', () => {
    expect(replyText(null)).toBe('');
    expect(
      replyText([
        { name: null, email: 'a@example.com' },
        { name: 'B', email: 'b@example.com' },
      ]),
    ).toBe('a@example.com, b@example.com');
  });

  it('reads the field: empty null, invalid undefined', () => {
    expect(parseReplyTo('  ')).toBeNull();
    expect(parseReplyTo(' a@example.com ')).toEqual([{ name: null, email: 'a@example.com' }]);
    expect(parseReplyTo('a@example.com, b@example.com')).toHaveLength(2);
    expect(parseReplyTo('broken')).toBeUndefined();
    expect(parseReplyTo('a@example.com, broken')).toBeUndefined();
  });
});

describe('identityPatch', () => {
  const fields = { name: 'Julian Schubert', replyTo: '', sig: '' };

  it('is empty without a change', () => {
    expect(identityPatch(identity(), fields, null)).toEqual({});
  });

  it('keeps the previous name when the name is empty', () => {
    expect(identityPatch(identity(), { ...fields, name: '   ' }, null)).toEqual({});
    expect(identityPatch(identity(), { ...fields, name: ' Julian S. ' }, null)).toEqual({ name: 'Julian S.' });
  });

  it('sends changed reply addresses and clears them', () => {
    const to = [{ name: null, email: 'reply@example.com' }];
    expect(identityPatch(identity(), fields, to)).toEqual({ replyTo: to });
    expect(identityPatch(identity({ replyTo: to }), fields, null)).toEqual({ replyTo: null });
    expect(identityPatch(identity({ replyTo: [{ name: 'A', email: 'reply@example.com' }] }), fields, to)).toEqual({});
  });

  it('clears the HTML signature with the signature', () => {
    expect(identityPatch(identity(), { ...fields, sig: 'Regards' }, null)).toEqual({ textSignature: 'Regards' });
    expect(identityPatch(identity({ htmlSignature: '<p>Old</p>' }), { ...fields, sig: 'Regards' }, null)).toEqual({
      textSignature: 'Regards',
      htmlSignature: '',
    });
  });
});

describe('Identities', () => {
  it('loads the list; the skeleton applies until then', async () => {
    const api = fakeApi([identity()]);
    const s = new Identities(api);
    const load = s.load('a1');
    expect(s.load('a1')).toBe(load);
    expect(s.lists.a1).toBeUndefined();
    await load;
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(s.lists.a1).toHaveLength(1);
  });

  it('remembers a failed first load without a toast for the card', async () => {
    const api = fakeApi([identity()]);
    const s = new Identities(api);
    const error = new Error('broken');
    api.list.mockRejectedValueOnce(error);
    await s.load('a1');
    expect(s.lists.a1).toBeInstanceOf(LoadFailed);
    expect((s.lists.a1 as LoadFailed).error).toBe(error);
    expect(ui.toast).toBeNull();
  });

  it('keeps the list on a later failed load and reports it as a toast', async () => {
    const api = fakeApi([identity()]);
    const s = new Identities(api);
    await s.load('a1');
    api.list.mockRejectedValueOnce(new Error('broken'));
    await s.load('a1');
    expect(s.lists.a1).toHaveLength(1);
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
  });

  it('checks the reply address before saving', async () => {
    const api = fakeApi([identity()]);
    const s = new Identities(api);
    await s.load('a1');
    s.edit('a1', identity());
    s.set('replyTo', 'broken');
    await s.save();
    expect(api.update).not.toHaveBeenCalled();
    expect(ui.toast).toMatchObject({ text: 'Please check the Reply-To address', error: false });
    expect(s.fieldsOf('a1')?.replyTo).toBe('broken');
  });

  it('closes without a request when nothing changed', async () => {
    const api = fakeApi([identity()]);
    const s = new Identities(api);
    await s.load('a1');
    s.edit('a1', identity());
    await s.save();
    expect(api.update).not.toHaveBeenCalled();
    expect(s.draft).toBeNull();
    expect(ui.toast?.text).toBe('Identity saved');
  });

  it('saves via Identity/set and gives the composer the new list', async () => {
    const api = fakeApi([identity()]);
    const changed = vi.spyOn(compose, 'identitiesChanged');
    const s = new Identities(api);
    await s.load('a1');
    s.edit('a1', identity());
    s.set('name', 'Julian');
    s.set('replyTo', 'reply@example.com');
    s.set('sig', 'Best regards');
    const save = s.save();
    expect(s.saving.has('a1')).toBe(true);
    await save;
    expect(api.update).toHaveBeenCalledWith('a1', 'i1', {
      name: 'Julian',
      replyTo: [{ name: null, email: 'reply@example.com' }],
      textSignature: 'Best regards',
    });
    expect(s.saving.has('a1')).toBe(false);
    expect(s.draft).toBeNull();
    expect(s.lists.a1).toMatchObject([{ name: 'Julian', textSignature: 'Best regards' }]);
    expect(changed).toHaveBeenCalledWith('a1', s.lists.a1);
    expect(ui.toast?.text).toBe('Identity saved');
  });

  it('reports a rejected reply address and otherwise the general error', async () => {
    const api = fakeApi([identity()]);
    const s = new Identities(api);
    await s.load('a1');
    s.edit('a1', identity());
    s.set('replyTo', 'reply@example.com');
    api.update.mockRejectedValueOnce(new IdentityRefused({ type: 'invalidProperties', properties: ['replyTo'] }));
    await s.save();
    expect(ui.toast).toMatchObject({ text: 'Please check the Reply-To address', error: true });
    expect(s.draft).not.toBeNull();
    api.update.mockRejectedValueOnce(new IdentityRefused({ type: 'forbidden' }));
    await s.save();
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    expect(s.saving.has('a1')).toBe(false);
  });

  it('keeps newer server values when reloading during editing', async () => {
    const api = fakeApi([identity()]);
    const s = new Identities(api);
    await s.load('a1');
    s.edit('a1', identity());
    s.set('sig', 'Regards');
    api.list.mockResolvedValueOnce([identity({ name: 'Julian S.' })]);
    await s.load('a1');
    expect(s.fieldsOf('a1')).toMatchObject({ name: 'Julian S.', sig: 'Regards' });
    await s.save();
    expect(api.update).toHaveBeenCalledWith('a1', 'i1', { textSignature: 'Regards' });
  });

  it('gives the composer the loaded list and shows the skeleton again after an error', async () => {
    const changed = vi.spyOn(compose, 'identitiesChanged');
    const api = fakeApi([identity()]);
    const s = new Identities(api);
    api.list.mockRejectedValueOnce(new ApiError(409, { error: 'needs_reauth' }));
    await s.load('a1');
    expect(s.lists.a1).toBeInstanceOf(LoadFailed);
    expect(changed).not.toHaveBeenCalled();
    const load = s.load('a1');
    expect(s.lists.a1).toBeUndefined();
    await load;
    expect(changed).toHaveBeenCalledWith('a1', [identity()]);
  });

  it('locks saving only in the account that is saving', async () => {
    const s = new Identities(fakeApi([identity()]));
    await s.load('a1');
    s.lists = { ...s.lists, a2: [identity({ id: 'i9' })] };
    s.edit('a1', identity());
    s.set('name', 'New');
    const save = s.save();
    s.edit('a2', identity({ id: 'i9' }));
    expect([s.saving.has('a1'), s.saving.has('a2')]).toEqual([true, false]);
    await save;
  });

  it('changes no fields while saving', async () => {
    const s = new Identities(fakeApi([identity()]));
    await s.load('a1');
    s.edit('a1', identity());
    s.set('name', 'New');
    const save = s.save();
    s.set('name', 'Later');
    expect(s.fieldsOf('a1')?.name).toBe('New');
    await save;
    expect(s.lists.a1).toMatchObject([{ name: 'New' }]);
  });

  it('discards lists and draft on sign-out', async () => {
    const s = new Identities(fakeApi([identity()]));
    await s.load('a1');
    s.edit('a1', identity());
    s.reset();
    expect(s.lists).toEqual({});
    expect(s.draft).toBeNull();
  });
});

describe('identitiesValues', () => {
  const list = [
    identity({ id: 'i2', name: '', email: 'info@s1.test', textSignature: '  ' }),
    identity({ replyTo: [{ name: null, email: 'reply@example.com' }], textSignature: 'Regards' }),
  ];
  const input = { connection: vi.fn<(id: string) => void>() };

  beforeEach(() => input.connection.mockClear());

  it('is null before loading (skeleton)', () => {
    expect(identitiesValues(ACCOUNT, input)).toBeNull();
  });

  it('shows the card with buttons by reason after a failed first load', () => {
    const load = (error: unknown) => {
      identities.lists = { a1: new LoadFailed(error) };
      return identitiesValues(ACCOUNT, input)!;
    };
    let v = load(new ApiError(502, { error: 'check_failed', reason: 'unreachable' }));
    expect(v.load).toMatchObject({
      text: 'mail.s1.test is unreachable. Try again later.',
      retry: true,
      reauth: false,
      con: false,
    });
    expect(v).toMatchObject({ empty: false, rows: [] });
    expect(load(new ApiError(502, { error: 'refresh_failed', reason: 'auth_failed' })).load).toMatchObject({
      text: 'mail.s1.test rejected the sign-in. Sign in again.',
      retry: true,
      reauth: true,
      con: false,
    });
    expect(load(new ApiError(409, { error: 'needs_reauth' })).load).toMatchObject({
      text: 'Sign-in to mail.s1.test required',
      retry: false,
      reauth: true,
      con: false,
    });
    v = load(new ApiError(409, { error: 'blocked' }));
    expect(v.load).toMatchObject({
      text: 'mail.s1.test is no longer an approved server.',
      retry: false,
      reauth: false,
      con: true,
    });
    v.load!.goCon();
    expect(input.connection).toHaveBeenCalledWith('a1');
    expect(load(new NetworkError(new TypeError('fetch'))).load).toMatchObject({
      text: 'No connection. Please try again.',
      retry: true,
    });
    expect(load(new Error('jmap')).load).toMatchObject({
      text: 'That didn’t work. Please try again.',
      retry: true,
    });
  });

  it('reloads via “Try again”', () => {
    const load = vi.spyOn(identities, 'load').mockResolvedValue();
    identities.lists = { a1: new LoadFailed(new Error('broken')) };
    identitiesValues(ACCOUNT, input)!.load!.onRetry();
    expect(load).toHaveBeenCalledWith('a1');
  });

  it('does not cancel while saving', () => {
    identities.lists = { a1: list };
    identities.edit('a1', list[1]!);
    identities.saving.add('a1');
    const v = identitiesValues(ACCOUNT, input)!;
    expect(v.form.saving).toBe(true);
    v.form.cancel();
    expect(identities.draft).not.toBeNull();
    identities.saving.delete('a1');
    identitiesValues(ACCOUNT, input)!.form.cancel();
    expect(identities.draft).toBeNull();
  });

  it('shows the empty state without an identity', () => {
    identities.lists = { a1: [] };
    expect(identitiesValues(ACCOUNT, input)).toMatchObject({
      load: null,
      empty: true,
      emptyText: 'mail.s1.test reports no sender address for this account.',
      rows: [],
    });
    identities.lists = { a1: list };
    expect(identitiesValues(ACCOUNT, input)).toMatchObject({ load: null, empty: false });
  });

  it('shows the identity of the account first, without a name the address', () => {
    identities.lists = { a1: list };
    const v = identitiesValues(ACCOUNT, input)!;
    expect(v.rows.map((r) => r.id)).toEqual(['i1', 'i2']);
    expect(v.rows[0]).toMatchObject({
      name: 'Julian Schubert',
      ini: 'JS',
      sub: 'Reply-To: reply@example.com · With signature',
      editing: false,
    });
    expect(v.rows[1]).toMatchObject({ name: 'info@s1.test', ini: 'I', sub: 'No signature' });
  });

  it('edits a row with the values of the form', () => {
    identities.lists = { a1: list };
    identitiesValues(ACCOUNT, input)!.rows[0]!.edit();
    let v = identitiesValues(ACCOUNT, input)!;
    expect(v.rows.map((r) => r.editing)).toEqual([true, false]);
    expect(v.form).toMatchObject({ name: 'Julian Schubert', replyTo: 'reply@example.com', sig: 'Regards' });
    v.form.onSig('New');
    v = identitiesValues(ACCOUNT, input)!;
    expect(v.form.sig).toBe('New');
    v.form.cancel();
    expect(identitiesValues(ACCOUNT, input)!.rows.every((r) => !r.editing)).toBe(true);
  });

  it('does not show the draft of another account', () => {
    identities.lists = { a1: list, a2: list };
    identities.edit('a2', list[1]!);
    const v = identitiesValues(ACCOUNT, input)!;
    expect(v.rows.every((r) => !r.editing)).toBe(true);
    expect(v.form.name).toBe('');
  });
});

describe('jmapIdentityApi', () => {
  function client(setResponse: Record<string, unknown>, list: Identity[]) {
    const calls: [string, unknown][] = [];
    const c = {
      accountId: () => Promise.resolve('c'),
      call: (name: string, args: unknown) => {
        calls.push([name, args]);
        return Promise.resolve({ list });
      },
      batch: () => ({
        call: (name: string, args: unknown) => {
          calls.push([name, args]);
          return name;
        },
        send: () => Promise.resolve({ get: (call: string) => (call === 'Identity/set' ? setResponse : { list }) }),
      }),
    };
    return { calls, client: () => Promise.resolve(c as unknown as JmapClient) };
  }

  it('sends Identity/set and Identity/get in one request', async () => {
    const { calls, client: c } = client({ updated: { i1: null } }, [identity({ name: 'New' })]);
    const list = await jmapIdentityApi(c).update('a1', 'i1', { name: 'New' });
    expect(calls).toEqual([
      ['Identity/set', { accountId: 'c', update: { i1: { name: 'New' } } }],
      ['Identity/get', { accountId: 'c', ids: null }],
    ]);
    expect(list).toMatchObject([{ name: 'New' }]);
    expect(await jmapIdentityApi(c).list('a1')).toHaveLength(1);
  });

  it('throws IdentityRefused on notUpdated', async () => {
    const { client: c } = client({ notUpdated: { i1: { type: 'invalidProperties', properties: ['replyTo'] } } }, []);
    await expect(jmapIdentityApi(c).update('a1', 'i1', { replyTo: null })).rejects.toBeInstanceOf(IdentityRefused);
  });
});
