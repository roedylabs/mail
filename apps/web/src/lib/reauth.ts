/**
 * Server responses to checking password and code in an existing session:
 * change password, add and remove an authenticator app, new recovery codes
 * (Account › Security) and a new email address (Account › Profile). The
 * server checks the password before the code; a wrong password clears only
 * the password, a wrong or already used code only the code, and during a
 * lockout the inputs stay.
 */
import { ApiError, fieldsOf, retryAfter } from '#lib/api.ts';
import { m } from '#lib/paraglide/messages.js';
import { waitText } from '#lib/wait.ts';

/** Input cleared after the response. */
export type ReauthClear = 'password' | 'code' | null;

export interface ReauthError {
  text: string;
  clear: ReauthClear;
}

/** A code from the authenticator app: six digits. */
export const CODE_LENGTH = 6;

/**
 * Message for a check response, otherwise `null` (other errors that the
 * page handles itself). `newApp`: when adding an app, the code comes from
 * "the new app". `password`/`code` are the request fields.
 */
export function reauthError(error: unknown, newApp = false, password = 'password'): ReauthError | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 429) return { text: m.reauth_locked({ wait: waitText(retryAfter(error)) }), clear: null };
  if (error.status !== 422) return null;
  switch (error.code) {
    case 'invalid_password':
      return { text: m.reauth_password(), clear: 'password' };
    case 'invalid_code':
      return { text: newApp ? m.reauth_code_new() : m.reauth_code(), clear: 'code' };
    case 'code_used':
      return { text: m.reauth_code_used(), clear: 'code' };
    case 'invalid': {
      // Checked beforehand; only a password that is too long or a malformed code remains.
      const fields = fieldsOf(error);
      if (fields[password]) return { text: m.reauth_password(), clear: 'password' };
      if (fields.code) return { text: m.reauth_code_short(), clear: 'code' };
      return null;
    }
    default:
      return null;
  }
}
