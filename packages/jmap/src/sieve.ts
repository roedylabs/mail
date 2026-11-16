/**
 * JMAP for Sieve (RFC 9661): `SieveScript` with `get`, `set` and `validate`
 * and the capability `urn:ietf:params:jmap:sieve` of an account.
 * `JmapClient.upload` uploads a script's content as a blob (`SIEVE_TYPE`) and
 * `JmapClient.download` downloads it again.
 */

import { SIEVE, type Id, type SetArgs, type SetError, type Session } from './core.ts';
import { isRecord } from './errors.ts';

/** Content type of a Sieve script (RFC 5228, 10). */
export const SIEVE_TYPE = 'application/sieve';

/** Sieve script (RFC 9661, 2.1); at most one is active. */
export interface SieveScript {
  id: Id;
  /** Name, unique per account; the server assigns one when none is set. */
  name: string | null;
  /** Content as a blob; a new blob changes the script. */
  blobId: Id;
  /** Can only be changed via `onSuccessActivateScript` and `onSuccessDeactivateScript`. */
  isActive: boolean;
}

/** Additional arguments of `SieveScript/set` (RFC 9661, 2.2). */
export interface SieveScriptSetExtra {
  /** Activate this script (also `#<creation id>`) on success; the previously active one becomes inactive. */
  onSuccessActivateScript?: Id | null;
  /** Deactivate the active script on success. */
  onSuccessDeactivateScript?: boolean | null;
}

export type SieveScriptSetArgs = SetArgs<SieveScript> & SieveScriptSetExtra;

/** `SieveScript/validate` (RFC 9661, 2.5): checks an uploaded blob without storing it. */
export interface SieveScriptValidateArgs {
  accountId: Id;
  blobId: Id;
}

export interface SieveScriptValidateResponse {
  accountId: Id;
  /** `null` when the script is valid; otherwise `invalidScript` with a description. */
  error: SetError | null;
}

/** Capability `urn:ietf:params:jmap:sieve` of an account (RFC 9661, 1.3); missing limits as `null`. */
export interface SieveCapability {
  maxSizeScriptName: number | null;
  maxSizeScript: number | null;
  maxNumberScripts: number | null;
  /** Redirects a script may perform for one message (Stalwart v1.0.2: 1). */
  maxNumberRedirects: number | null;
  /** Supported extensions, e.g. `fileinto`, `imap4flags`, `copy`. */
  sieveExtensions: string[];
}

const limit = (v: unknown): number | null => (typeof v === 'number' && v >= 0 ? v : null);

/** Capability `urn:ietf:params:jmap:sieve` of an account; invalid values as `null` or empty. */
export function sieveCapability(session: Session, accountId: Id): SieveCapability {
  const cap = session.accounts[accountId]?.accountCapabilities[SIEVE];
  const raw = isRecord(cap) ? cap : {};
  return {
    maxSizeScriptName: limit(raw.maxSizeScriptName),
    maxSizeScript: limit(raw.maxSizeScript),
    maxNumberScripts: limit(raw.maxNumberScripts),
    maxNumberRedirects: limit(raw.maxNumberRedirects),
    sieveExtensions: Array.isArray(raw.sieveExtensions)
      ? raw.sieveExtensions.filter((e): e is string => typeof e === 'string')
      : [],
  };
}
