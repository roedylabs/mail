/**
 * Document title per route (WCAG 2.4.2): "‹Page› – ‹App name›" from
 * the existing page headings, without texts of its own. If the heading
 * already contains the app name ("Set up Roedy Mail"), it stands
 * alone; without a matching heading (start page, OAuth) only the app name.
 */
import { ERRS, isErrorCode, type ErrorCode } from '#lib/errors.ts';
import { mailAccountPageOf, mailAccountRouteOf } from '#lib/mail-account.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { pageOf } from '#lib/settings-nav.ts';
import { NEW_DRAFT } from '#lib/state/compose.svelte.ts';

export interface PageTitleInput {
  path: string;
  appName: string;
  /** Error page instead of the page: router error, "Access denied", session. */
  error: ErrorCode | null;
  /** Name of the open mailbox (`view.title`) on `/mailbox/…`, once known. */
  mailbox: string | null;
  /** Title of the open compose view (`cm.title`), once known. */
  compose: string | null;
  /** Heading of the sign-in page (branding, otherwise "Welcome back"). */
  loginTitle: string;
  /** Title of the open setup step ("Setup token · Setup"), set by the wizard; stands alone. */
  setup?: string | null;
}

/** Separator between the parts of the title. */
const SEP = ' – ';

/** Heading of the page, for subpages with the section after it; empty if there is no matching one. */
function headingOf(input: PageTitleInput): string[] {
  const { path, appName } = input;
  if (input.error) return [ERRS[input.error].title()];
  if (path.startsWith('/error/')) {
    const code = path.slice('/error/'.length).replace(/\/$/, '');
    return [ERRS[isErrorCode(code) ? code : '404'].title()];
  }
  const sub = mailAccountRouteOf(path);
  const panel = pageOf(path);
  if (panel) return sub ? [mailAccountPageOf(sub.slug).label, panel.label] : [panel.label];
  if (path.startsWith('/mailbox/')) return input.mailbox ? [input.mailbox] : [];
  if (path === '/search') return [m.shell_search()];
  if (path.startsWith('/compose/')) {
    if (input.compose) return [input.compose];
    return path === `/compose/${NEW_DRAFT}` ? [m.compose_title_new()] : [m.compose_title_draft()];
  }
  if (path === '/no-account') return [m.noaccount_title()];
  if (path === '/login') return [input.loginTitle];
  if (path === '/password/forgot') return [m.login_forgot_title()];
  if (path.startsWith('/password/reset/')) return [m.login_newpw_title()];
  if (path === '/setup') return [m.setup_token_title({ app: appName })];
  if (path.startsWith('/invite/')) return [m.invite_title({ app: appName })];
  if (path.startsWith('/confirm-email/')) return [m.ec_ask_title()];
  return [];
}

export function pageTitle(input: PageTitleInput): string {
  if (input.path === '/setup' && input.setup && !input.error) return input.setup;
  const parts = headingOf(input).filter(Boolean);
  const last = parts.at(-1);
  if (last?.includes(input.appName)) return parts.join(SEP);
  return [...parts, input.appName].join(SEP);
}
