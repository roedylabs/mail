/**
 * Last opened page of the settings (with the account pages) and of the
 * administration in this session, only in memory: opening an area without a
 * page (`,`, the gear, "Open settings", More › Settings, "Administration")
 * leads back there. Initially "Appearance" and "Users"; a reload starts over.
 * Not to be confused with "Open at start: last opened page" (`last-page.ts`).
 */
import { ADMIN_HOME, pageOf, sectionOf, type PanelRoute } from '#lib/settings-nav.ts';

export const SETTINGS_HOME: PanelRoute = '/settings/appearance';
const DEVELOPER: PanelRoute = '/admin/developer';
const MAIL_ACCOUNTS = '/account/mail-accounts';

let settingsPage: PanelRoute = SETTINGS_HOME;
let adminPage: PanelRoute = ADMIN_HOME;

/**
 * Remember the page of the address. "Add email account" counts as "Email
 * accounts"; the subpages of a single email account leave the remembered page
 * as it was. Only for pages that really open (no redirect, no "Access denied").
 */
export function rememberPanelPage(path: string): void {
  const page = pageOf(path);
  if (!page) return;
  if (sectionOf(path) === 'admin') {
    adminPage = page.route;
    return;
  }
  if (path.startsWith(`${MAIL_ACCOUNTS}/`) && path !== `${MAIL_ACCOUNTS}/new`) return;
  settingsPage = page.route;
}

/** Page that settings open without a page of their own. */
export function settingsHome(): PanelRoute {
  return settingsPage;
}

/** Page that the administration opens without a page of its own; "Developer" only with "Advanced settings". */
export function adminHome(advanced: boolean): PanelRoute {
  if (!advanced) advancedOff();
  return adminPage;
}

/** "Advanced settings" switched off: "Developer" is no longer the page of the administration, also after switching on again. */
export function advancedOff(): void {
  if (adminPage === DEVELOPER) adminPage = ADMIN_HOME;
}

/** Back to the initial pages (tests). */
export function resetPanelMemory(): void {
  settingsPage = SETTINGS_HOME;
  adminPage = ADMIN_HOME;
}
