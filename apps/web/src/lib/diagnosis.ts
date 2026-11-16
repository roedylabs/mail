/**
 * Diagnosis of a mail server: text per row, result and reason from the API
 * (`reasons` of `setup/servers/test` and `admin/servers/:id/test`). Shared by
 * the setup (step 4) and Administration › Mail servers. Without a reason (the
 * list after a reload does not know it) the general text applies.
 */
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import { waitText } from '#lib/wait.ts';

export type DiagStatus = 'ok' | 'err' | 'unk';
export type DiagLine = 'reach' | 'cors' | 'oauth';
/** Reasons per row, only for `err` and `unk` (for `reach` also `auth_required` with `ok`). */
export type DiagReasons = Partial<Record<DiagLine, string | null>>;

export interface DiagContext {
  /** Host of the app for "The server allows requests from the browser of …". */
  origin: string;
  /** Redirect URI for the advice on the OAuth client. */
  redirect: string;
  /** Name of the app (`no_public_url`, `unsupported_version`, `throttled`). */
  app: string;
  /** Remaining wait in seconds after a throttled test (`retry_after`); without it or expired "in a few minutes". */
  wait?: number;
}

type Texts = Partial<Record<string, () => string>>;

function texts(line: DiagLine, status: DiagStatus, ctx: DiagContext): Texts {
  const skip = () => m.server_diag_skipped();
  const metadata = () => m.diag_oauth_metadata();
  const browser = () => m.diag_oauth_browser();
  const throttled = () =>
    ctx.wait && ctx.wait > 0
      ? m.diag_throttled({ app: ctx.app, wait: waitText(ctx.wait) })
      : m.diag_throttled_later({ app: ctx.app });
  if (line === 'reach') {
    if (status === 'ok')
      return { '': () => m.server_diag_jmap_ok(), auth_required: () => m.diag_reach_auth_required() };
    if (status === 'err') {
      return {
        '': () => m.server_diag_jmap_err(),
        unreachable: () => m.diag_reach_unreachable(),
        no_mail: () => m.diag_reach_no_mail(),
        api_url_mismatch: () => m.diag_reach_api_url_mismatch(),
        redirect_other_origin: () => m.diag_reach_redirect(),
        too_many_redirects: () => m.diag_reach_redirects(),
      };
    }
    return { throttled };
  }
  if (line === 'cors') {
    if (status === 'ok') return { '': () => m.server_diag_cors_ok({ host: ctx.origin }) };
    if (status === 'err') {
      return {
        '': () => m.server_diag_cors_err(),
        authorization_not_allowed: () => m.diag_cors_authorization(),
        content_type_not_allowed: () => m.diag_cors_content_type(),
        preflight_status: () => m.diag_cors_preflight(),
        preflight_failed: () => m.diag_cors_preflight(),
      };
    }
    return {
      not_reachable: skip,
      no_api_url: () => m.diag_cors_no_api_url(),
      no_public_url: () => m.diag_cors_no_public_url({ app: ctx.app }),
      throttled,
    };
  }
  if (status === 'ok') return { '': () => m.server_diag_oauth_ok() };
  if (status === 'err') {
    return {
      '': () => m.server_diag_oauth_err({ redirect: ctx.redirect }),
      no_metadata: metadata,
      metadata_unreachable: metadata,
      token_endpoint_mismatch: () => m.diag_oauth_token_endpoint(),
      grant_types: browser,
      pkce: browser,
      no_public_client: browser,
      unsupported_version: () => m.diag_oauth_unsupported_version({ app: ctx.app }),
      issuer_mismatch: () => m.diag_oauth_issuer(),
      authorization_endpoint_mismatch: () => m.diag_oauth_authorization_endpoint(),
      revocation_endpoint_mismatch: () => m.diag_oauth_revocation_endpoint(),
      no_confidential_client: () => m.diag_oauth_no_confidential(),
    };
  }
  return { not_reachable: skip, throttled };
}

/**
 * Text of a row: by the reason, otherwise the general one of the result;
 * "Not checked because the server isn’t reachable." if CORS or
 * OAuth stayed unchecked without a reason and the server was unreachable.
 */
export function diagText(
  line: DiagLine,
  status: DiagStatus,
  reach: DiagStatus,
  reasons: DiagReasons | null | undefined,
  ctx: DiagContext,
): string {
  const reason = reasons?.[line] ?? (status === 'unk' && reach === 'err' ? 'not_reachable' : '');
  const table = texts(line, status, ctx);
  const text = table[reason] ?? table[''];
  return text ? text() : m.server_diag_unknown();
}

/** Colour of the icon per result (green is fixed). */
export function diagColor(status: DiagStatus): string {
  return status === 'ok' ? '#4fae64' : status === 'err' ? 'var(--danger)' : 'var(--mfg)';
}

/** Icon per result (`DG`): check mark, warning, dashed for "not checked". */
export function diagIcon(status: DiagStatus): IconName {
  return status === 'ok' ? 'ti-circle-check' : status === 'err' ? 'ti-alert-triangle' : 'ti-circle-dashed';
}

/** Action of a row in `DG`: edit the address, test again or register the client. */
export type DiagAction = 'edit' | 'test' | 'register';

/**
 * Action of a row: JMAP session "Edit URL",
 * CORS "Test again"; OAuth by reason – edit an address that does not
 * match Stalwart (`…_mismatch`), test a server without v1 or without
 * clients with a secret again (a registration would not help there),
 * otherwise register the client.
 */
export function diagAction(line: DiagLine, reason: string | null | undefined): DiagAction {
  if (line === 'reach') return 'edit';
  if (line === 'cors') return 'test';
  if (reason?.endsWith('_mismatch')) return 'edit';
  if (reason === 'unsupported_version' || reason === 'no_confidential_client') return 'test';
  return 'register';
}

/**
 * Rejected sign-in as administrator during the registration
 * (`auth_failed`, `mfa_required`): setup and dialog clear the
 * app password; both count in the backend towards "Too many attempts."
 * `forbidden` has its own text and keeps the fields.
 */
export function adminRejected(reason: string | null): boolean {
  return reason === 'auth_failed' || reason === 'mfa_required';
}

/**
 * Text of a failed registration of the OAuth client (`srvRegMsg`,
 * `SRV_REG_ERR`); `rejected` names `detail` in parentheses. A throttled
 * server with a wait time shows the box "Too many requests." instead
 * (`throttleText`); without a wait time the fallback `throttled` applies.
 */
export function registrationText(reason: string | null, detail: string | null, app: string): string {
  switch (reason) {
    case 'auth_failed':
      return m.reg_auth_failed();
    case 'mfa_required':
      return m.reg_mfa_required();
    case 'forbidden':
      return m.reg_forbidden();
    case 'unreachable':
      return m.reg_unreachable();
    case 'unsupported':
      return m.reg_unsupported();
    case 'unsupported_version':
      return m.reg_unsupported_version({ app });
    case 'throttled':
      return m.reg_throttled();
    case 'rejected':
      return detail ? m.reg_rejected_detail({ detail }) : m.reg_rejected();
    default:
      return m.reg_rejected();
  }
}

/**
 * Text in the box "Too many requests.": Stalwart throttles
 * the registration ("Try again …") or the test in step 4 of the
 * setup ("Test …").
 */
export function throttleText(app: string, seconds: number, test = false): string {
  const wait = waitText(seconds);
  return test ? m.diag_throttled_box({ app, wait }) : m.reg_throttled_text({ app, wait });
}
