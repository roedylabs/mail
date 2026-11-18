/**
 * Routes of the web app: which shell a page gets and where the
 * entry redirects to (setup, sign-in, start page).
 */

/**
 * `bare`: whole page without a header (setup, sign-in, links from mails);
 * `main`: header, sidebar and content; `panel`: settings, account and
 * administration with the settings navigation.
 */
export type Chrome = 'bare' | 'main' | 'panel';

/**
 * Guest pages without a shell: setup, sign-in and links from mails. When signed in they stay without a shell; sign-in and setup then redirect
 * to the start page (`redirectFor`).
 */
const LINK_PAGES = ['/setup', '/login', '/invite/', '/password/reset/', '/password/forgot', '/confirm-email/'];

/** Pages without a shell. */
const BARE_PREFIXES = [...LINK_PAGES, '/oauth/'];

/** Reachable without sign-in. */
const GUEST_PREFIXES = [...LINK_PAGES, '/error/'];

const PANEL_PREFIXES = ['/settings/', '/account/', '/admin/'];

export const START_PATH = '/start';
export const LOGIN_PATH = '/login';
export const SETUP_PATH = '/setup';
export const NO_ACCOUNT_PATH = '/no-account';

/** Redirect targets on entry. */
export type EntryPath = typeof START_PATH | typeof LOGIN_PATH | typeof SETUP_PATH | typeof NO_ACCOUNT_PATH;

function matches(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => (p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`)));
}

export function chromeOf(path: string, authed: boolean): Chrome {
  if (matches(path, BARE_PREFIXES)) return 'bare';
  if (!authed) return 'bare';
  return matches(path, PANEL_PREFIXES) ? 'panel' : 'main';
}

export function isGuestPath(path: string): boolean {
  return matches(path, GUEST_PREFIXES);
}

/** Pages with a token from a mail in the address (invitation, password, confirm email address). */
const TOKEN_PREFIXES = ['/invite/', '/password/reset/', '/confirm-email/'];

/**
 * Address without the token from a mail, e.g. for "Copy details" on the
 * error page: whoever sends it to support would otherwise pass on a valid
 * link (like the backend's request log).
 */
export function redactPath(path: string): string {
  const prefix = TOKEN_PREFIXES.find((p) => path.startsWith(p));
  return prefix ? `${prefix}…` : path;
}

export function isAdminPath(path: string): boolean {
  return path.startsWith('/admin/');
}

/**
 * Settings, including the account pages (profile, email accounts, adding one,
 * security); not the pages of a single email account.
 */
export function isSettingsPath(path: string): boolean {
  if (path.startsWith('/settings/')) return true;
  if (!path.startsWith('/account/')) return false;
  return !(path.startsWith('/account/mail-accounts/') && path.split('/').length > 4);
}

/** Mailboxes of the sidebar in the order of `FOLDERS` (keys 1–6); part of the address. */
export const ROLE_IDS = ['inbox', 'sent', 'drafts', 'scheduled', 'trash', 'spam'] as const;
export type RoleId = (typeof ROLE_IDS)[number];

/** Account of the "All accounts" view in the address. */
export const ALL_ACCOUNTS = 'all';

/** Target in an account: mailbox via the role, own folder (mailbox id; in "All accounts" with its account `owner`) or tag. */
export type MailboxTarget = { role: RoleId } | { folder: string; owner?: string } | { tag: string };

/** Parts of `/mailbox/[account]/[...path]` (`account` = mail account id or `all`). */
export type MailboxLocation = { account: string; thread: string | null } & MailboxTarget;

const isRoleId = (value: string | undefined): value is RoleId => (ROLE_IDS as readonly string[]).includes(value ?? '');

/**
 * Parts of the address of a mailbox, folder or tag, already encoded (for `resolve('/mailbox/[account]/[...path]', …)`):
 * `<account|all>` and `<role|f/…|t/…>`; a folder in "all accounts" names its
 * account (`f/<account>/<folder>`).
 */
export function mailboxParams(account: string, target: MailboxTarget): { account: string; path: string } {
  const enc = encodeURIComponent;
  let path: string;
  if ('role' in target) path = target.role;
  else if ('tag' in target) path = `t/${enc(target.tag)}`;
  else if (account !== ALL_ACCOUNTS) path = `f/${enc(target.folder)}`;
  // Without an account the folder could not be assigned in "All accounts" (`parseMailboxPath`).
  else if (target.owner) path = `f/${enc(target.owner)}/${enc(target.folder)}`;
  else throw new Error('Folder in "all accounts" without an account');
  return { account: enc(account), path };
}

export function mailboxPath(account: string, target: MailboxTarget): string {
  const params = mailboxParams(account, target);
  return `/mailbox/${params.account}/${params.path}`;
}

/**
 * Counterpart of `mailboxPath()`, plus an appended thread; `null` outside
 * the mailboxes. `/mailbox/<account>` without a path counts as the inbox.
 */
export function parseMailboxPath(path: string): MailboxLocation | null {
  const parts = path.split('/').slice(1);
  if (parts[0] !== 'mailbox' || !parts[1]) return null;
  let rest: string[];
  try {
    rest = parts.slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [account = '', kind, ...more] = rest;
  const thread = (n: number) => more[n] || null;
  if (!kind) return { account, role: 'inbox', thread: null };
  if (isRoleId(kind)) return { account, role: kind, thread: thread(0) };
  if (kind === 't' && more[0]) return { account, tag: more[0], thread: thread(1) };
  if (kind !== 'f') return null;
  if (account === ALL_ACCOUNTS)
    return more[0] && more[1] ? { account, folder: more[1], owner: more[0], thread: thread(2) } : null;
  return more[0] ? { account, folder: more[0], thread: thread(1) } : null;
}

/**
 * Mail accounts a mailbox address needs: its own; in "All accounts" the folder's account and that of the
 * open message (`<account>/<thread>`), roles and tags there need none.
 */
export function locationAccounts(location: MailboxLocation): string[] {
  if (location.account !== ALL_ACCOUNTS) return [location.account];
  const ids = 'folder' in location && location.owner ? [location.owner] : [];
  const cut = location.thread?.indexOf('/') ?? -1;
  if (location.thread && cut > 0) ids.push(location.thread.slice(0, cut));
  return ids;
}

/**
 * Pages of the route tree (`src/routes`) apart from the mailboxes;
 * `routes.test.ts` checks them against the tree.
 */
const APP_PAGES: readonly RegExp[] = [
  /^\/(start|search|setup|login|no-account|password\/forgot|oauth\/callback)$/,
  /^\/(invite|password\/reset|confirm-email|error|compose)\/[^/]+$/,
  /^\/settings\/(general|notifications|appearance|language|shortcuts|about)$/,
  /^\/account\/(profile|security|mail-accounts|mail-accounts\/new)$/,
  /^\/account\/mail-accounts\/[^/]+\/(overview|identities|vacation|connection|rules)$/,
  /^\/admin\/(users|organization|branding|banner|mail-servers|email|audit-log|updates|maintenance|developer)$/,
];

/**
 * Whether `path` names a page of the app (not the 404 page), e.g. for an
 * address remembered in the browser.
 */
export function isAppPath(path: string): boolean {
  if (path === '/') return true;
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  return parseMailboxPath(trimmed) !== null || APP_PAGES.some((page) => page.test(trimmed));
}

/** Pages with mailboxes; without a mail account the app shows "No account" instead. */
function isMailPath(path: string): boolean {
  return path === START_PATH || path.startsWith('/mailbox/');
}

/**
 * Redirect after loading the session, otherwise `null`: without an
 * administrator only setup (`setup_required`), without sign-in only guest
 * pages, when signed in no longer sign-in or setup; "/" leads to the start page.
 * With a known number of mail accounts (`mailAccounts`), the start page and
 * mailboxes go to "No account" without an account, and "No account" goes to the start page with one.
 */
export function redirectFor(
  path: string,
  state: { setupRequired: boolean; authed: boolean; mailAccounts?: number | null },
): EntryPath | null {
  if (state.setupRequired) return path === SETUP_PATH ? null : SETUP_PATH;
  if (!state.authed) {
    if (path === '/' || path === SETUP_PATH) return LOGIN_PATH;
    // Unknown paths show the router's 404, not the login.
    return isGuestPath(path) || !isAppPath(path) ? null : LOGIN_PATH;
  }
  const known = state.mailAccounts !== undefined && state.mailAccounts !== null;
  const none = known && state.mailAccounts === 0;
  const home = none ? NO_ACCOUNT_PATH : START_PATH;
  if (path === '/' || path === SETUP_PATH || path === LOGIN_PATH) return home;
  if (none && isMailPath(path)) return NO_ACCOUNT_PATH;
  if (known && !none && path === NO_ACCOUNT_PATH) return START_PATH;
  return null;
}
