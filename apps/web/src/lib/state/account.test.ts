import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailPush } from '#lib/mail-push.svelte.ts';
import { push } from '#lib/push.svelte.ts';
import { identities } from '#lib/identities.svelte.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { rules } from '#lib/rules.svelte.ts';
import { forgetAccount, loadSignedIn, signOut } from '#lib/state/account.ts';
import { devLog } from '#lib/state/devlog.svelte.ts';
import { onForget } from '#lib/state/forget.ts';
import { network } from '#lib/state/network.svelte.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { TAB_CHANNEL, session } from '#lib/state/session.svelte.ts';
import { vacations } from '#lib/vacation.svelte.ts';

const ME = {
  id: '01J',
  username: 'max',
  email: 'max@example.org',
  display_name: 'Max Mustermann',
  role: 'user' as const,
  mfa_enabled: false,
  password_changed_at: '2026-10-25T10:00:00Z',
  email_change: null,
  sole_admin: false,
};

afterEach(() => {
  forgetAccount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('loadSignedIn', () => {
  it('registers the browser for push again after sign-in (subscriptions end with the session)', async () => {
    const resume = vi.spyOn(push, 'resume').mockResolvedValue();
    mockApi({ 'GET settings': [{ body: { version: 1, settings: {} } }], 'GET auth/me': [{ body: ME }] });
    expect(await loadSignedIn()).toBe(true);
    expect(session.user?.email).toBe('max@example.org');
    expect(resume).toHaveBeenCalledOnce();
  });

  it('no push without a session', async () => {
    const resume = vi.spyOn(push, 'resume').mockResolvedValue();
    mockApi({
      'GET settings': [{ status: 401, body: { error: 'unauthorized' } }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    expect(await loadSignedIn()).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });

  it('forgetAccount clears the log and stops the offline simulation', () => {
    devLog.add('info', 'Notice of the previous account');
    network.simulated = true;
    forgetAccount();
    expect(network.simulated).toBe(false);
    expect(devLog.entries).toEqual([]);
  });

  it('forgetAccount also discards the session push', () => {
    const reset = vi.spyOn(push, 'reset');
    forgetAccount();
    expect(reset).toHaveBeenCalledOnce();
  });

  it('forgetAccount resets registered modules without importing them itself', () => {
    const reset = vi.fn();
    onForget(reset);
    forgetAccount();
    expect(reset).toHaveBeenCalledOnce();
  });

  it('forgetAccount discards identities, vacation notices and rules of loaded pages', () => {
    identities.lists = { a1: [] };
    const spies = [vi.spyOn(identities, 'reset'), vi.spyOn(vacations, 'reset'), vi.spyOn(rules, 'reset')];
    forgetAccount();
    for (const spy of spies) expect(spy).toHaveBeenCalledOnce();
    expect(identities.lists).toEqual({});
  });
});

describe('signOut and JMAP push', () => {
  function spies() {
    const order: string[] = [];
    vi.spyOn(mailPush, 'withdraw').mockImplementation(() => {
      order.push('withdraw');
      return Promise.resolve();
    });
    vi.spyOn(mailPush, 'clearDevice').mockImplementation(() => {
      order.push('clearDevice');
      return Promise.resolve();
    });
    return order;
  }

  it('removes the entries before signing out and the rest afterwards', async () => {
    const order = spies();
    const { calls } = mockApi({ 'POST auth/logout': [{ status: 204 }] });
    expect(await signOut()).toBe(true);
    expect(order).toEqual(['withdraw', 'clearDevice']);
    expect(calls.map((c) => c.path)).toContain('auth/logout');
  });

  it('keeps the device if signing out fails', async () => {
    const order = spies();
    mockApi({ 'POST auth/logout': [{ status: 500, body: { error: 'internal' } }] });
    expect(await signOut()).toBe(false);
    expect(order).toEqual(['withdraw']);
  });
});

describe('End of the session without signing out in this tab', () => {
  const OTHER = { ...ME, id: '02K', username: 'erika', email: 'erika@example.org' };
  const ACC = {
    id: 'acc-a',
    email: 'max@example.org',
    username: 'max',
    url: 'https://mail.example.org',
    host: 'mail.example.org',
    server_id: 's1',
    auth_kind: 'oauth',
    color: 0,
    state: 'ok',
    blocked: false,
    quota_used: null,
    quota_total: null,
    last_check_at: null,
    created_at: '2026-10-25T10:00:00Z',
  };

  it('discards mail accounts and tokens; the next account loads its own', async () => {
    vi.spyOn(push, 'resume').mockResolvedValue();
    vi.spyOn(mailPush, 'resume').mockResolvedValue();
    const { calls } = mockApi({
      'GET mail-accounts': [{ body: { accounts: [ACC] } }, { body: { accounts: [] } }],
      'GET mail-accounts/acc-a/token': [
        { body: { accessToken: 'TOKEN-A', expiresAt: '2099-01-01T00:00:00Z' } },
        { status: 404, body: { error: 'not_found' } },
      ],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }, { body: OTHER }],
      'GET settings': [{ body: { version: 1, settings: {} } }],
    });
    session.user = ME;
    await accounts.ensure();
    expect(await accounts.tokens('acc-a').token()).toBe('TOKEN-A');
    // E.g. the bell gets 401: expired or signed out in another tab.
    await session.refreshUser();
    expect(session.user).toBeNull();
    expect(accounts.list).toBeNull();
    // A different account signs in in this tab.
    expect(await loadSignedIn()).toBe(true);
    await accounts.ensure();
    expect(accounts.list).toEqual([]);
    await expect(accounts.tokens('acc-a').token()).rejects.toThrow();
    expect(calls.filter((c) => c.path === 'mail-accounts/acc-a/token')).toHaveLength(2);
  });

  it('a different account from another tab: discard state, then load as after sign-in', async () => {
    const resume = vi.spyOn(mailPush, 'resume').mockResolvedValue();
    vi.spyOn(push, 'resume').mockResolvedValue();
    mockApi({
      'GET mail-accounts': [{ body: { accounts: [ACC] } }],
      'GET auth/me': [{ body: OTHER }, { body: OTHER }],
      'GET settings': [{ body: { version: 1, settings: {} } }],
    });
    session.user = ME;
    await accounts.ensure();
    await session.refreshUser();
    expect(session.user?.id).toBe(OTHER.id);
    expect(accounts.list).toBeNull();
    await vi.waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(session.user?.id).toBe(OTHER.id);
  });

  it('tells the other tabs about signing out, but not about the end from the callback', async () => {
    vi.spyOn(mailPush, 'withdraw').mockResolvedValue();
    vi.spyOn(mailPush, 'clearDevice').mockResolvedValue();
    const other = new BroadcastChannel(TAB_CHANNEL);
    const heard: unknown[] = [];
    other.onmessage = (event: MessageEvent<unknown>) => heard.push(event.data);
    try {
      mockApi({
        'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
        'POST auth/logout': [{ status: 204 }],
      });
      session.user = ME;
      await session.refreshUser();
      session.user = ME;
      expect(await signOut()).toBe(true);
      await vi.waitFor(() => expect(heard).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(heard).toEqual([null]);
    } finally {
      other.close();
    }
  });

  it('the same account keeps its state', async () => {
    mockApi({ 'GET mail-accounts': [{ body: { accounts: [ACC] } }], 'GET auth/me': [{ body: ME }] });
    session.user = ME;
    await accounts.ensure();
    await session.refreshUser();
    expect(accounts.list?.map((a) => a.id)).toEqual(['acc-a']);
  });
});
