import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  EmailConfirmFlow,
  checkFailValues,
  emailConfirmValues,
  type EmailConfirmContext,
} from './email-confirm.svelte.ts';

const CONFIG: PublicConfig = {
  name: 'Roedy Mail',
  branding: BRAND0,
  org: { name: null, website: null, help: null, email: null, imprint: null, privacy: null, terms: null, source: null },
  banner: null,
  maintenance: { on: false, message: null },
  version: '0.1.0',
  update: null,
  setup_required: false,
  client_cache_version: 0,
};
const ME: Me = {
  id: 'u0',
  username: 'max',
  email: 'max@example.com',
  display_name: 'Max Example',
  role: 'user',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: '2026-10-01T10:00:00Z',
  email_change: { email: 'new@example.com', expires_at: '2026-10-27T10:00:00Z' },
};
const TOKEN = 'a'.repeat(64);

let ctx: EmailConfirmContext;

beforeEach(() => {
  session.config = CONFIG;
  ctx = { dark: false, toggleDark: vi.fn(), go: vi.fn() };
});

afterEach(() => {
  vi.unstubAllGlobals();
  session.config = null;
  session.user = null;
  prefs.reset();
  ui.reset();
});

async function opened(routes: Parameters<typeof mockApi>[0]) {
  const api = mockApi(routes);
  const flow = new EmailConfirmFlow();
  await flow.open(TOKEN);
  return { flow, v: () => emailConfirmValues(flow, ctx), ...api };
}

describe('confirm email address', () => {
  it('only checks on load and confirms via the button', async () => {
    session.user = ME;
    const { flow, v, calls } = await opened({
      'POST auth/email/check': [{ body: { state: 'valid', email: 'new@example.com', own_session: true } }],
      'POST auth/email/confirm': [{ body: { state: 'confirmed', email: 'new@example.com', own_session: true } }],
      'GET auth/me': [{ body: { ...ME, email: 'new@example.com', email_change: null } }],
    });
    expect(calls.map((c) => [c.path, c.body])).toEqual([['auth/email/check', { token: TOKEN }]]);
    let values = v();
    expect([values.ecValid, values.ecAsk, values.ecOk, values.ecExpired, values.ecAlready]).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect([values.ecEmail, values.ecAuthed, values.ecGuest]).toEqual(['new@example.com', true, false]);
    values.ecDoConfirm();
    expect(v().ecBusy).toBe(true);
    await vi.waitFor(() => expect(flow.link).toBe('confirmed'));
    values = v();
    expect([values.ecValid, values.ecAsk, values.ecOk]).toEqual([true, false, true]);
    expect(values.ecBtn).toBe('Continue to Roedy Mail');
    values.ecGo();
    expect(ctx.go).toHaveBeenCalledWith('/');
    // The own session loads the account with the new address.
    await vi.waitFor(() => expect(session.user?.email).toBe('new@example.com'));
    expect(calls.map((c) => c.path)).toEqual(['auth/email/check', 'auth/email/confirm', 'auth/me']);
  });

  it('guest: expired leads to sign-in', async () => {
    const { v } = await opened({ 'POST auth/email/check': [{ body: { state: 'invalid', own_session: false } }] });
    const values = v();
    expect([values.ecExpired, values.ecValid, values.ecGuest, values.ecAuthed]).toEqual([true, false, true, false]);
    expect(values.ecBtn).toBe('Sign in');
    values.ecGo();
    expect(ctx.go).toHaveBeenCalledWith('/login');
  });

  it('signed in: expired leads to the profile, already confirmed to the app', async () => {
    session.user = ME;
    const { v, flow } = await opened({
      'POST auth/email/check': [
        { body: { state: 'invalid', own_session: true } },
        { body: { state: 'already_confirmed', email: 'new@example.com', own_session: true } },
      ],
    });
    expect(v().ecBtn).toBe('Go to profile');
    v().ecGo();
    expect(ctx.go).toHaveBeenCalledWith('/account/profile');
    await flow.load();
    const values = v();
    expect([values.ecAlready, values.ecEmail, values.ecBtn]).toEqual([
      true,
      'new@example.com',
      'Continue to Roedy Mail',
    ]);
  });

  it('a foreign session sees the guest variant', async () => {
    session.user = { ...ME, id: 'u9' };
    const { v } = await opened({
      'POST auth/email/check': [{ body: { state: 'valid', email: 'new@example.com', own_session: false } }],
    });
    expect([v().ecGuest, v().ecAuthed]).toEqual([true, false]);
  });

  it('confirming without an own session loads no account; a link invalid by now shows “expired”', async () => {
    const { flow, v, calls } = await opened({
      'POST auth/email/check': [{ body: { state: 'valid', email: 'new@example.com', own_session: false } }],
      'POST auth/email/confirm': [{ body: { state: 'invalid', own_session: false } }],
    });
    await flow.confirm();
    expect(v().ecExpired).toBe(true);
    expect(calls.map((c) => c.path)).toEqual(['auth/email/check', 'auth/email/confirm']);
  });

  it('reports an error when confirming as a toast; the button stays', async () => {
    const { flow, v } = await opened({
      'POST auth/email/check': [{ body: { state: 'valid', email: 'new@example.com', own_session: false } }],
      'POST auth/email/confirm': [{ status: 500, body: {} }],
    });
    await flow.confirm();
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    expect(v().ecAsk).toBe(true);
  });

  it('shows in the card why the check fails (`ecFail`)', async () => {
    const { flow } = await opened({ 'POST auth/email/check': [{ status: 500, body: {} }] });
    expect([flow.status, flow.failure]).toEqual(['failed', '500']);
    expect(checkFailValues(flow)).toMatchObject({
      icon: 'ti-bug',
      title: 'Something went wrong',
      retryLabel: 'Try again',
      disabled: false,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    await flow.load();
    expect(flow.failure).toBe('offline');
    expect(checkFailValues(flow)).toMatchObject({ icon: 'ti-wifi-off', title: 'No connection' });
    flow.dispose();
  });

  it('locks “Try again” after 429 with a countdown', async () => {
    const { flow } = await opened({
      'POST auth/email/check': [{ status: 429, body: { error: 'rate_limited', retry_after: 300 } }],
    });
    expect(flow.failure).toBe('429');
    expect(checkFailValues(flow)).toMatchObject({
      icon: 'ti-hourglass',
      title: 'Too many requests',
      text: 'Try again in 5 minutes.',
      retryLabel: 'Try again in 5:00',
      locked: true,
      disabled: true,
    });
    const calls = vi.mocked(fetch).mock.calls.length;
    flow.retry();
    expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
    flow.dispose();
  });

  it('checks again by itself after the lock expires', async () => {
    vi.useFakeTimers();
    try {
      const { flow } = await opened({
        'POST auth/email/check': [
          { status: 429, body: { error: 'rate_limited', retry_after: 2 } },
          { body: { state: 'invalid', own_session: false } },
        ],
      });
      expect(flow.failure).toBe('429');
      await vi.advanceTimersByTimeAsync(2500);
      expect(flow.status).toBe('ready');
      expect(flow.link).toBe('invalid');
      flow.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('theme button and illustration', async () => {
    const { v } = await opened({ 'POST auth/email/check': [{ body: { state: 'invalid', own_session: false } }] });
    expect([v().loginArt, v().themeDark, v().tgDark.on]).toEqual([true, false, false]);
    v().tgDark.onClick();
    expect(ctx.toggleDark).toHaveBeenCalled();
  });
});

describe('loading', () => {
  it('shows no invalid link during the check', () => {
    let release: (a: { body: unknown }) => void = () => {};
    mockApi({ 'POST auth/email/check': [() => new Promise((resolve) => (release = resolve))] });
    const flow = new EmailConfirmFlow();
    void flow.open(TOKEN);
    const values = emailConfirmValues(flow, ctx);
    expect([flow.status, values.ecExpired, values.ecValid, values.ecAlready]).toEqual(['loading', false, false, false]);
    release({ body: { state: 'invalid', own_session: false } });
  });
});
