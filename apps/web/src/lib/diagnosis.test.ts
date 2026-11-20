import { describe, expect, it } from 'vitest';
import {
  adminRejected,
  diagAction,
  diagColor,
  diagIcon,
  diagText,
  registrationText,
  throttleText,
  type DiagReasons,
} from './diagnosis.ts';

const CTX = {
  origin: 'webmail.example.com',
  redirect: 'https://webmail.example.com/oauth/callback',
  app: 'Roedy Mail',
};

const UNCHECKED = 'Not checked because the server isn’t reachable.';
const UNKNOWN = 'Not checked yet.';
const THROTTLED =
  'Not checked because the mail server is throttling requests from Roedy Mail. Test again in a few minutes.';
const V1 = 'This server isn’t Stalwart v1. Roedy Mail supports Stalwart 1.0 and later.';

describe('diagText: JMAP session', () => {
  it('names the general text when fine, the reason when sign-in is required', () => {
    expect(diagText('reach', 'ok', 'ok', {}, CTX)).toBe('Session found. JMAP Core and Mail are available.');
    expect(diagText('reach', 'ok', 'ok', { reach: 'auth_required' }, CTX)).toBe(
      'Server reachable. The session requires sign-in, so CORS can’t be checked.',
    );
  });

  it('names the reason on errors', () => {
    const text = (reason: string) => diagText('reach', 'err', 'err', { reach: reason }, CTX);
    expect(text('unreachable')).toBe(
      'Can’t connect to this URL. Check the base URL, port, firewall, and TLS certificate.',
    );
    expect(text('no_mail')).toBe('The server responds but doesn’t offer JMAP for email.');
    expect(text('api_url_mismatch')).toBe(
      'Stalwart reports a different URL in the session. Enter the public URL that Stalwart itself uses.',
    );
    expect(text('redirect_other_origin')).toBe('The server redirects to a different URL. Enter that URL directly.');
    expect(text('too_many_redirects')).toBe('Too many redirects. Check the URL and the reverse proxy.');
  });

  it('names the general text without a reason or with an unknown one', () => {
    const general =
      'No JMAP server responds at this URL. Check the base URL, port, and firewall. The path /.well-known/jmap must be reachable from outside.';
    expect(diagText('reach', 'err', 'err', undefined, CTX)).toBe(general);
    expect(diagText('reach', 'err', 'err', null, CTX)).toBe(general);
    expect(diagText('reach', 'err', 'err', { reach: 'new_in_stalwart' }, CTX)).toBe(general);
    // A reason that belongs to a different result does not apply.
    expect(diagText('reach', 'ok', 'ok', { reach: 'unreachable' }, CTX)).toBe(
      'Session found. JMAP Core and Mail are available.',
    );
    expect(diagText('reach', 'unk', 'unk', {}, CTX)).toBe(UNKNOWN);
  });
});

describe('diagText: CORS headers', () => {
  it('names the host of the app when fine', () => {
    expect(diagText('cors', 'ok', 'ok', {}, CTX)).toBe('The server allows browser requests from webmail.example.com.');
  });

  it('names the reason on errors, otherwise the general text', () => {
    const text = (reason?: string) => diagText('cors', 'err', 'ok', reason ? { cors: reason } : {}, CTX);
    expect(text('authorization_not_allowed')).toBe(
      'The server doesn’t allow the Authorization header. Check the CORS settings in Stalwart and in the reverse proxy.',
    );
    expect(text('content_type_not_allowed')).toBe(
      'The server doesn’t allow the Content-Type header. Check the CORS settings in Stalwart and in the reverse proxy.',
    );
    const preflight =
      'The browser’s preflight request (OPTIONS) is rejected. Check the reverse proxy in front of Stalwart.';
    expect(text('preflight_status')).toBe(preflight);
    expect(text('preflight_failed')).toBe(preflight);
    expect(text()).toBe(
      'The browser isn’t allowed to reach the server directly. In the Stalwart web admin, turn on “Permissive CORS” in the HTTP settings, save, and reload the configuration.',
    );
  });

  it('names why it was not checked', () => {
    const text = (reasons: DiagReasons | undefined, reach: 'ok' | 'err' = 'ok') =>
      diagText('cors', 'unk', reach, reasons, CTX);
    expect(text({ cors: 'no_api_url' })).toBe('Not checked because the session requires sign-in.');
    expect(text({ cors: 'not_reachable' })).toBe(UNCHECKED);
  });

  it('assumes “unreachable” without a reason if the session failed', () => {
    expect(diagText('cors', 'unk', 'err', undefined, CTX)).toBe(UNCHECKED);
    expect(diagText('cors', 'unk', 'err', { cors: null }, CTX)).toBe(UNCHECKED);
    // Reachable, but without a reason: not checked yet (e.g. after loading the list).
    expect(diagText('cors', 'unk', 'ok', undefined, CTX)).toBe(UNKNOWN);
    expect(diagText('cors', 'unk', 'unk', {}, CTX)).toBe(UNKNOWN);
  });
});

describe('diagText: OAuth client', () => {
  it('says when fine that only the first sign-in checks the client', () => {
    expect(diagText('oauth', 'ok', 'ok', {}, CTX)).toBe(
      'Client ID set, and the server supports sign-in. The first sign-in shows whether it accepts the client.',
    );
  });

  it('names the reason on errors, otherwise the advice with the redirect URI', () => {
    const text = (reason?: string) => diagText('oauth', 'err', 'ok', reason ? { oauth: reason } : {}, CTX);
    const metadata =
      'The OAuth metadata at /.well-known/oauth-authorization-server is missing. Check whether OAuth is enabled in Stalwart.';
    expect(text('no_metadata')).toBe(metadata);
    expect(text('metadata_unreachable')).toBe(metadata);
    expect(text('token_endpoint_mismatch')).toBe(
      'The token endpoint isn’t under the server’s URL. Enter the URL that Stalwart itself uses.',
    );
    const browser =
      'The server doesn’t support sign-in for browser apps (refresh tokens, PKCE with S256, or clients without a secret). Check the OAuth settings in Stalwart.';
    expect(text('grant_types')).toBe(browser);
    expect(text('pkce')).toBe(browser);
    expect(text('no_public_client')).toBe(browser);
    const general =
      'In the Stalwart web admin, create an OAuth client with the redirect URI https://webmail.example.com/oauth/callback and enter the client ID here, or have the client registered automatically.';
    expect(text()).toBe(general);
  });

  it('names the OAuth reasons with their own text', () => {
    const text = (reason: string) => diagText('oauth', 'err', 'ok', { oauth: reason }, CTX);
    const own = ' Enter the URL that Stalwart itself uses.';
    expect(text('unsupported_version')).toBe(`${V1} Update Stalwart and test again.`);
    expect(text('issuer_mismatch')).toBe(`Stalwart reports a different URL in its OAuth metadata.${own}`);
    expect(text('authorization_endpoint_mismatch')).toBe(
      `The authorization endpoint isn’t under the server’s URL.${own}`,
    );
    expect(text('revocation_endpoint_mismatch')).toBe(
      `The revocation endpoint is missing or isn’t under the server’s URL.${own}`,
    );
    expect(text('no_confidential_client')).toBe(
      'The server doesn’t accept clients with a secret. Check the OAuth settings in Stalwart.',
    );
  });

  it('names “unreachable” or “not checked yet” when unchecked', () => {
    expect(diagText('oauth', 'unk', 'ok', { oauth: 'not_reachable' }, CTX)).toBe(UNCHECKED);
    expect(diagText('oauth', 'unk', 'err', {}, CTX)).toBe(UNCHECKED);
    expect(diagText('oauth', 'unk', 'ok', {}, CTX)).toBe(UNKNOWN);
  });
});

describe('diagText: throttled', () => {
  it('names the throttling of the mail server in every unchecked row', () => {
    const reasons: DiagReasons = { reach: 'throttled', cors: 'throttled', oauth: 'throttled' };
    expect(diagText('reach', 'unk', 'unk', reasons, CTX)).toBe(THROTTLED);
    expect(diagText('cors', 'unk', 'unk', reasons, CTX)).toBe(THROTTLED);
    expect(diagText('oauth', 'unk', 'unk', reasons, CTX)).toBe(THROTTLED);
    expect(diagText('oauth', 'unk', 'ok', { oauth: 'throttled' }, CTX)).toBe(THROTTLED);
  });

  it('names the wait time from the response while it runs', () => {
    const reasons: DiagReasons = { cors: 'throttled', oauth: 'throttled' };
    const later = (wait: number) => diagText('cors', 'unk', 'ok', reasons, { ...CTX, wait });
    expect(later(90)).toBe(
      'Not checked because the mail server is throttling requests from Roedy Mail. Test again in 2 minutes.',
    );
    expect(later(20)).toBe(
      'Not checked because the mail server is throttling requests from Roedy Mail. Test again in 20 seconds.',
    );
    // Expired or saved result: "in a few minutes".
    expect(later(0)).toBe(THROTTLED);
  });

  it('applies only to unchecked rows', () => {
    expect(diagText('reach', 'err', 'err', { reach: 'throttled' }, CTX)).toBe(
      'No JMAP server responds at this URL. Check the base URL, port, and firewall. The path /.well-known/jmap must be reachable from outside.',
    );
  });
});

describe('diagAction', () => {
  it('edits the address of the JMAP session and tests CORS again', () => {
    expect(diagAction('reach', 'unreachable')).toBe('edit');
    expect(diagAction('cors', null)).toBe('test');
  });

  it('chooses the action of the OAuth row by reason', () => {
    expect(diagAction('oauth', 'token_endpoint_mismatch')).toBe('edit');
    expect(diagAction('oauth', 'issuer_mismatch')).toBe('edit');
    expect(diagAction('oauth', 'authorization_endpoint_mismatch')).toBe('edit');
    expect(diagAction('oauth', 'revocation_endpoint_mismatch')).toBe('edit');
    expect(diagAction('oauth', 'unsupported_version')).toBe('test');
    expect(diagAction('oauth', 'no_confidential_client')).toBe('test');
    expect(diagAction('oauth', 'no_client_id')).toBe('register');
    expect(diagAction('oauth', undefined)).toBe('register');
  });
});

describe('diagIcon', () => {
  it('shows check mark, warning and dashed circle', () => {
    expect(diagIcon('ok')).toBe('ti-circle-check');
    expect(diagIcon('err')).toBe('ti-alert-triangle');
    expect(diagIcon('unk')).toBe('ti-circle-dashed');
  });
});

describe('registrationText', () => {
  const text = (reason: string | null, detail: string | null = null) => registrationText(reason, detail, 'Roedy Mail');

  it('names the reason of a failed registration', () => {
    expect(text('auth_failed')).toBe('Administrator sign-in failed. Check the username and app password.');
    expect(text('unreachable')).toBe('The mail server can’t be reached. Check the server URL.');
    expect(text('unsupported')).toBe(
      'This mail server doesn’t allow automatic registration. Choose “Manual” and create the client in the Stalwart web admin.',
    );
    // Fallback without a wait time; with a wait time dialog and setup show the box (`throttleText`).
    expect(text('throttled')).toBe('The mail server isn’t accepting requests right now. Try again in a few minutes.');
  });

  it('names the reasons from Stalwart v1', () => {
    expect(text('mfa_required')).toBe(
      'This account requires a second factor. Sign in with an app password instead of your password.',
    );
    expect(text('forbidden')).toBe(
      'This account isn’t allowed to create OAuth clients. Sign in with an administrator account or grant the account the “SysOAuthClientCreate” permission in Stalwart.',
    );
    expect(text('unsupported_version')).toBe(`${V1} Update Stalwart and try again.`);
  });

  it('otherwise names “rejected”, with the server response in parentheses', () => {
    const rejected =
      'The mail server rejected the registration. Choose “Manual” and create the client in the Stalwart web admin.';
    expect(text('rejected')).toBe(rejected);
    expect(text('rejected', 'invalid_redirect_uri')).toBe(
      'The mail server rejected the registration (invalid_redirect_uri). Choose “Manual” and create the client in the Stalwart web admin.',
    );
    expect(text('invalid_response')).toBe(rejected);
    expect(text('bad_response')).toBe(rejected);
    expect(text(null)).toBe(rejected);
  });
});

describe('throttleText', () => {
  it('names the wait time for the registration and the test', () => {
    expect(throttleText('Roedy Mail', 90)).toBe(
      'The mail server is throttling requests from Roedy Mail. Try again in 2 minutes.',
    );
    expect(throttleText('Roedy Mail', 45, true)).toBe(
      'The mail server is throttling requests from Roedy Mail. Test again in 45 seconds.',
    );
  });
});

describe('adminRejected', () => {
  it('detects the rejected sign-in as administrator, also with a second factor', () => {
    expect(adminRejected('auth_failed')).toBe(true);
    expect(adminRejected('mfa_required')).toBe(true);
    // Correct app password without permission: fields stay.
    expect(adminRejected('forbidden')).toBe(false);
    expect(adminRejected('throttled')).toBe(false);
    expect(adminRejected('rejected')).toBe(false);
    expect(adminRejected(null)).toBe(false);
  });
});

describe('diagColor', () => {
  it('colours the icon per result', () => {
    expect([diagColor('ok'), diagColor('err'), diagColor('unk')]).toEqual(['#4fae64', 'var(--danger)', 'var(--mfg)']);
  });
});
