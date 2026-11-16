import { render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailLogin } from '#lib/auth/mail-login.svelte.ts';
import { savePending, type Pending } from '#lib/auth/stalwart-login.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import Page from './+page.svelte';

const nav = vi.hoisted(() => ({ goto: vi.fn(() => Promise.resolve()) }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));

const MAIL = 'https://mail.example.com';

const pending: Pending = {
  state: 'st',
  verifier: 'v'.repeat(43),
  purpose: { kind: 're', account: 'a1' },
  form: { email: 'alex@example.com', srv: 's1', url: '', auth: 'oauth' },
  url: MAIL,
  serverId: 's1',
  clientId: 'roedy',
  backendExchange: true,
  issuer: MAIL,
  tokenEndpoint: `${MAIL}/auth/token`,
  issRequired: false,
  redirectUri: `${location.origin}/oauth/callback`,
  created: Date.now(),
};

afterEach(() => {
  vi.unstubAllGlobals();
  nav.goto.mockClear();
  sessionStorage.clear();
  mailLogin.reset();
  history.replaceState(null, '', '/');
});

describe('/oauth/callback', () => {
  it('redirects to the empty “New email account” without a known attempt', () => {
    history.replaceState(null, '', '/oauth/callback?code=c&state=unknown');
    render(Page);
    expect(nav.goto).toHaveBeenCalledWith('/account/mail-accounts/new', { replace: true });
    expect(mailLogin.add.form?.err).toBe('expired');
  });

  it('redirects to the account connection on re-sign-in and completes there', async () => {
    mockApi({ 'POST mail-accounts/a1/reauth': [{ status: 409, body: { error: 'needs_reauth' } }] });
    savePending(pending, sessionStorage);
    history.replaceState(null, '', '/oauth/callback?code=c&state=st');
    render(Page);
    expect(nav.goto).toHaveBeenCalledWith('/account/mail-accounts/a1/connection', { replace: true });
    expect(mailLogin.re.form?.step).toBe('ret');
    await vi.waitFor(() => expect(mailLogin.re.form?.step).toBe('cred'));
  });
});
