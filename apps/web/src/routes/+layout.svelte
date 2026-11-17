<!--
  Shell: loads session and settings, sets the theme on
  <html>, shows the splash screen until then and per route the header,
  sidebar or settings navigation and content card (desktop), or header,
  content, tab bar and sheet (mobile; in settings, account and
  administration first the area's list, then the page). Plus notice bar,
  toast, tooltip, confirmation and, on desktop, command palette and keyboard
  shortcuts.
-->
<script lang="ts">
  import { scrollbar } from '#lib/actions/scrollbar.ts';
  import '@fontsource-variable/nunito-sans/opsz.css';
  import '@fontsource/young-serif/400.css';
  import '../app.css';
  import { onMount, tick, untrack } from 'svelte';
  import { afterNavigate, beforeNavigate, goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import type { TipState } from '#lib/actions/tooltip.ts';
  import { releaseWaiting, startAppWorker, watchRelease } from '#lib/app-worker.ts';
  import AccountMenu from '#lib/components/AccountMenu.svelte';
  import AccountPicker from '#lib/components/AccountPicker.svelte';
  import AccountSwitcher from '#lib/components/AccountSwitcher.svelte';
  import AppsMenu from '#lib/components/AppsMenu.svelte';
  import CommandPalette from '#lib/components/CommandPalette.svelte';
  import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
  import DebugBar from '#lib/components/DebugBar.svelte';
  import ErrorView from '#lib/components/ErrorView.svelte';
  import FolderTree from '#lib/components/FolderTree.svelte';
  import Header from '#lib/components/Header.svelte';
  import Icon from '#lib/components/Icon.svelte';
  import MailAccountNav from '#lib/components/MailAccountNav.svelte';
  import MailboxMenu from '#lib/components/MailboxMenu.svelte';
  import NavMenu from '#lib/components/NavMenu.svelte';
  import NoticeBar from '#lib/components/NoticeBar.svelte';
  import PickerList from '#lib/components/PickerList.svelte';
  import SettingsNav from '#lib/components/SettingsNav.svelte';
  import Sheet from '#lib/components/Sheet.svelte';
  import ShortcutsDialog from '#lib/components/ShortcutsDialog.svelte';
  import Sidebar from '#lib/components/Sidebar.svelte';
  import Splash from '#lib/components/Splash.svelte';
  import SyncPill from '#lib/components/SyncPill.svelte';
  import TabBar from '#lib/components/TabBar.svelte';
  import TagFixDialog from '#lib/components/TagFixDialog.svelte';
  import NameDialog from '#lib/components/NameDialog.svelte';
  import NotificationsMenu from '#lib/components/NotificationsMenu.svelte';
  import TagList from '#lib/components/TagList.svelte';
  import Toast from '#lib/components/Toast.svelte';
  import { toastLift } from '#lib/toast-lift.svelte.ts';
  import Tooltip from '#lib/components/Tooltip.svelte';
  import { mailLogin } from '#lib/auth/mail-login.svelte.ts';
  import { buildInfo } from '#lib/build-info.ts';
  import { isApiError } from '#lib/api.ts';
  import { csp } from '#lib/csp.ts';
  import { debugBarValues } from '#lib/developer.ts';
  import { currentEnv } from '#lib/environment.ts';
  import { flashSection } from '#lib/sections.ts';
  import { errorCodeOf, failText, timeZoneOf, type ErrorCode } from '#lib/errors.ts';
  import { keyCommand, shortcutsFor, textField, type KeyCommand } from '#lib/keys.ts';
  import { logout } from '#lib/logout.ts';
  import {
    accountSwitch,
    activeLocation,
    mailboxCommands,
    mobileRows,
    navRowsFor,
    sidebarScope,
    switcherValues,
  } from '#lib/mailbox-nav.ts';
  import {
    bannersOf,
    confirmValues,
    folderRows,
    tagRows,
    navItem,
    overlayClose,
    paletteRows,
    type Command,
    type MailboxMenuValues,
    type SidebarTab,
  } from '#lib/shell.ts';
  import { m } from '#lib/paraglide/messages.js';
  import {
    bellValues,
    notifMenuValues,
    targetOf,
    visibleNotifications,
    type NotifMenuActions,
  } from '#lib/notifications-menu.ts';
  import { mailPush } from '#lib/mail-push.svelte.ts';
  import { listenForPushClicks, listenForPushNews, push } from '#lib/push.svelte.ts';
  import {
    ALL_ACCOUNTS,
    chromeOf,
    isAdminPath,
    mailboxParams,
    mailboxPath,
    parseMailboxPath,
    redactPath,
    redirectFor,
    type EntryPath,
    type MailboxLocation,
    type MailboxTarget,
    type RoleId,
  } from '#lib/routes.ts';
  import { rememberPage } from '#lib/last-page.ts';
  import { adminHome, advancedOff, rememberPanelPage, settingsHome } from '#lib/panel-memory.ts';
  import { setInMain } from '#lib/landmark.ts';
  import { pageTitle } from '#lib/page-title.ts';
  import {
    mailAccountNavValues,
    mailAccountRouteOf,
    sameMailAccountPage,
    type MailAccountSlug,
    type MailAccountTargets,
  } from '#lib/mail-account.svelte.ts';
  import {
    ADMIN_HOME,
    navGroupValues,
    pageOf,
    sectionOf,
    type PanelPage,
    type PanelRoute,
    type SettingsNavValues,
  } from '#lib/settings-nav.ts';
  import { accounts, defaultAccountOf, tileOf, tilesOf, type MailAccount } from '#lib/state/accounts.svelte.ts';
  import { compose, composeTitle, draftRef, NEW_DRAFT, type ComposeReturn } from '#lib/state/compose.svelte.ts';
  import { appListView, isReachable, reachable } from '#lib/state/views.ts';
  import { folders, type FolderOpenNav } from '#lib/state/folders.svelte.ts';
  import { tagEdit, type TagOpenNav } from '#lib/state/tag-edit.svelte.ts';
  import { live } from '#lib/state/live.svelte.ts';
  import { scheduled } from '#lib/state/scheduled.svelte.ts';
  import { countsOf, mailboxes, sumCounts } from '#lib/state/mailboxes.svelte.ts';
  import { message } from '#lib/state/message.svelte.ts';
  import { notifications, POLL_MS } from '#lib/state/notifications.svelte.ts';
  import { tags, type TagFix, type TagProblem } from '#lib/state/tags.svelte.ts';
  import { threads } from '#lib/state/threads.svelte.ts';
  import { tagFixError, tagFixToast, tagFixValues } from '#lib/tag-fix.ts';
  import { devLog } from '#lib/state/devlog.svelte.ts';
  import { browserTimeZone, displayZone, prefs } from '#lib/state/prefs.svelte.ts';
  import { QUEUE_POLL_MS } from '#lib/state/edit-queue.svelte.ts';
  import { edits } from '#lib/state/edits.svelte.ts';
  import { network, pollVisible } from '#lib/state/network.svelte.ts';
  import { scopeOf, search } from '#lib/state/search.svelte.ts';
  import { returnable, returnBackLabel, returnLabel, searchReturn } from '#lib/search-return.ts';
  import { swipeBack, TOAST_BACK_MS, type BackSwipe, type SheetPull, type ToastSwipe } from '#lib/swipe.ts';
  import { ago } from '#lib/ago.ts';
  import { editLogs } from '#lib/mail-queue.ts';
  import { mailStores } from '#lib/mail-store.ts';
  import { forgetStartCopy, saveStartCopy, type StartCopy } from '#lib/start-copy.ts';
  import { forgetAccount } from '#lib/state/account.ts';
  import { CONFIG_POLL_MS, loginTitleOf, session } from '#lib/state/session.svelte.ts';
  import { ui, type MenuKey } from '#lib/state/ui.svelte.ts';
  import { applyTheme, themeOf } from '#lib/theme.ts';
  import { rememberLang } from '#lib/locale.ts';
  import { langChoices } from '#lib/language.ts';
  import type { LayoutProps } from './$types';

  let { children }: LayoutProps = $props();

  /** Targets of the switches; settings and administration without a page: `openSettings`, `openAdmin`. */
  const HOME = resolve('/start');
  const NOTIFICATIONS = resolve('/settings/notifications');
  const PROFILE = resolve('/account/profile');
  const USERS = resolve('/admin/users');
  const MAILSERVERS = resolve('/admin/mail-servers');
  const MAINTENANCE = resolve('/admin/maintenance');
  const SYSTEM_MAIL = resolve('/admin/email');
  const ADD_ACCOUNT = resolve('/account/mail-accounts/new');
  const MAIL_ACCOUNTS = resolve('/account/mail-accounts');
  const SEARCH = resolve('/search');
  const ENTRY: Record<EntryPath, string> = {
    '/start': HOME,
    '/login': resolve('/(auth)/login'),
    '/setup': resolve('/setup'),
    '/no-account': resolve('/no-account'),
  };
  /** Number of mail accounts; `null` while unknown (then nothing redirects to "No account"). */
  const mailAccountCount = $derived(accounts.count);
  /** Sync pill: first sync of the live sync or "Refresh" (`syncOn`, `pfBusy`), only with a mail account. */
  const syncing = $derived((live.syncing || ui.syncing) && !!mailAccountCount);
  /** Replay of the queue (`repl`): entries at the start, otherwise 0. */
  const replaying = $derived(edits.queue.replaying);
  /** Queue in the notice bar while offline (`OFF_TXT.wait`). */
  const waitingNotice = $derived.by(() => {
    const count = edits.queue.count;
    if (!count) return null;
    return count === 1
      ? { text: m.offline_wait_one(), titleM: m.offline_wait_mobile_one() }
      : { text: m.offline_wait_many({ count }), titleM: m.offline_wait_mobile_many({ count }) };
  });
  /** Per host, what is still waiting with a connection (`OFF_TXT.stuck`). */
  const stuckNotices = $derived.by(() => {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local sum, no state
    const hosts = new Map<string, number>();
    for (const { account, count } of edits.queue.stuck) {
      const host = accounts.get(account)?.host ?? account;
      hosts.set(host, (hosts.get(host) ?? 0) + count);
    }
    return [...hosts].map(([host, count]) => ({
      host,
      text: count === 1 ? m.offline_stuck_one({ host }) : m.offline_stuck_many({ count, host }),
    }));
  });
  /** Changes the server did not accept (`OFF_TXT.lost`). */
  const lostNotice = $derived.by(() => {
    const lost = edits.queue.lost;
    if (!lost) return null;
    const { count, subject } = lost;
    return count === 1
      ? { text: m.offline_lost_one({ subject: subject || m.list_no_subject() }), titleM: m.offline_lost_mobile_one() }
      : { text: m.offline_lost_many({ count }), titleM: m.offline_lost_mobile_many({ count }) };
  });
  /** Offline versions that became new drafts (`OFF_TXT.draft`). */
  const doubledNotice = $derived.by(() => {
    const conflict = edits.queue.conflict;
    if (!conflict) return null;
    const { count, subject } = conflict;
    return {
      text:
        count === 1
          ? m.offline_draft_one({ subject: subject || m.list_no_subject() })
          : m.offline_draft_many({ count }),
    };
  });
  /** "Show": one draft opens compose, several open the drafts, across several accounts all. */
  function openDoubled() {
    const conflict = edits.queue.conflict;
    edits.queue.conflict = null;
    if (!conflict) return;
    const { count, accounts: list } = conflict;
    if (count === 1) go(resolve('/compose/[draft]', { draft: encodeURIComponent(draftRef(conflict)) }));
    else go(mailboxPath(list.length === 1 ? list[0]! : ALL_ACCOUNTS, { role: 'drafts' }));
  }
  /** One account: its address, otherwise the count (`syncSub`). */
  const syncSub = $derived(
    accounts.list?.length === 1 ? accounts.list[0]!.email : m.sync_accounts({ count: mailAccountCount ?? 0 }),
  );

  const path = $derived(page.url.pathname);
  const ready = $derived(session.status === 'ready');
  const target = $derived(
    ready
      ? redirectFor(path, {
          setupRequired: session.setupRequired,
          authed: session.authed,
          mailAccounts: mailAccountCount,
        })
      : null,
  );
  const forbidden = $derived(ready && session.authed && !session.isAdmin && isAdminPath(path));
  // "Access denied" in the main view.
  const chrome = $derived(forbidden ? 'main' : chromeOf(path, session.authed));
  // Exactly one `main` per route: on desktop the content card, on mobile the area's page;
  // otherwise the pages set their own (`#lib/landmark.ts`).
  setInMain(() => ready && !target && chrome !== 'bare' && (!ui.isMobile || chrome === 'panel'));
  // Last opened page for "Open on startup", once it is really open (no redirect, no "Access denied", no error page).
  $effect(() => {
    const id = session.user?.id;
    if (id && ready && !target && !forbidden && !page.error) rememberPage(id, page.url);
  });
  // Last opened page of settings and administration in this session (only in memory).
  $effect(() => {
    if (ready && !target && !forbidden && !page.error && chrome === 'panel') rememberPanelPage(path);
  });
  /**
   * Swiping the toast: paused during the gesture, sent at once when swiped away,
   * another 2.4 s when it springs back – only while the same toast is shown;
   * a new one that replaces it during the gesture runs on its own.
   */
  let swipedToast: number | null = null;
  const toastSwipe: ToastSwipe = {
    get animations() {
      return prefs.motion;
    },
    hold: () => {
      swipedToast = ui.toast?.id ?? null;
      ui.toasts.hold();
    },
    away: () => {
      if (ui.toast && ui.toast.id === swipedToast) ui.toasts.dismiss();
    },
    back: () => {
      if (ui.toast && ui.toast.id === swipedToast) ui.toasts.resume(TOAST_BACK_MS);
    },
  };
  /** Header or "Back to …" visible: signed in on a page of the app. */
  const inShell = $derived(ready && !target && chrome !== 'bare' && session.authed);

  // Without a mail account: no sidebar and no tab bar (`noAcctV`); likewise while unknown.
  const noAccounts = $derived(!mailAccountCount && chrome === 'main');
  // The search takes the full width: sidebar slid out and no sidebar toggle, as without a mail account.
  const sbHidden = $derived(noAccounts || path === SEARCH);
  /** Tablet in portrait: the sidebar lies as a drawer over the mailbox (`drawerOpen`), with a scrim. */
  const drawerOpen = $derived(ui.isPortrait && ui.drawer && chrome === 'main' && !sbHidden);
  /** Sidebar shows labels (270 px): expanded, or as an open drawer. */
  const sbWide = $derived(!ui.collapsed || drawerOpen);
  // Another page or layout closes the drawer (choosing a mailbox, folder or tag, composing, rotating).
  $effect(() => {
    void path;
    void ui.layout;
    untrack(() => (ui.drawer = false));
  });
  /** "Sidebar" in the mailbox opens the drawer in portrait, elsewhere it collapses the settings navigation. */
  const toggleSidebar = () => ui.toggleSidebar(chrome === 'main');
  /** Closes the drawer; with `refocus` focus goes back to the "Sidebar" button (Escape). */
  function closeDrawer(refocus = false) {
    ui.drawer = false;
    if (refocus) document.querySelector<HTMLElement>('[data-sb-toggle]')?.focus();
  }
  let searchInput: HTMLInputElement | undefined = $state();

  const dark = $derived(ui.dark);

  onMount(() => {
    devLog.add('info', m.dev_log_started({ version: buildInfo.version }));
    void boot();
    const detachLogin = mailLogin.attach(window);
    const detachToasts = ui.toasts.attach(window);
    const detachLog = devLog.attach(window);
    const detachNetwork = network.attach(window);
    const stopConfig = session.watchConfig();
    const stopTabs = session.watchTabs();
    const stopReturn = network.onReturn(() => live.reconnect());
    const stopRelease = watchRelease();
    return () => {
      stopRelease();
      detachLogin();
      detachToasts();
      detachLog();
      detachNetwork();
      stopConfig();
      stopTabs();
      stopReturn();
    };
  });

  // Return path to the search: the navigation of an opened hit sets it, leaving its target ends it.
  beforeNavigate(({ to }) => {
    if (to) search.navigating(to.url.pathname, returnable(to.url.pathname));
  });

  // History within the app for the error page's "Back". The app's start does not count: in the SPA
  // `from.url` is `null` there, unlike in SvelteKit's type. If this threw, the router would never start.
  afterNavigate(({ from, to }) => {
    if (to) search.arrived(to.url.pathname);
    if (!from?.url) return;
    ui.navigated = true;
    if (to && to.url.pathname !== from.url.pathname) {
      devLog.add('debug', m.dev_log_navigation({ path: redactPath(to.url.pathname) }));
    }
    // Reload after a change of the registry: only the new document brings the new CSP.
    // Same for a new version: an open tab would otherwise stay on the old one.
    if (csp.stale || (to && releaseWaiting(from.url.pathname, to.url.pathname))) csp.reload();
  });

  /** The CSP blocked a fetch (e.g. a server another tab registered): reload after the next navigation. */
  function onViolation(event: SecurityPolicyViolationEvent) {
    if (event.effectiveDirective === 'connect-src') csp.stale = true;
  }
  $effect(() => {
    document.addEventListener('securitypolicyviolation', onViolation);
    return () => document.removeEventListener('securitypolicyviolation', onViolation);
  });

  function restoreCopy(copy: StartCopy) {
    prefs.fromCopy(copy.settings);
    accounts.fromCopy(copy.accounts);
  }

  /** Also runs repeatedly: the error page's "Try again" and after a start from the copy. */
  let booting: Promise<void> | null = null;
  function boot(): Promise<void> {
    booting ??= start().finally(() => (booting = null));
    return booting;
  }

  async function start() {
    const returning = session.fromCopy;
    await session.load(restoreCopy);
    if (session.authed && !session.fromCopy) {
      // Push subscriptions end with the session; an existing browser subscribes again.
      void push.resume();
      await Promise.all([
        // Without settings the defaults apply; saving tries again.
        prefs.load().catch(() => {}),
        // The effect below reports the error.
        (returning ? accounts.load() : accounts.ensure()).catch(() => {}),
      ]);
      // Only now is it known whether the push channel is on.
      void mailPush.resume();
      if (returning) {
        live.reconnect();
        void tags.load().catch(() => {});
      }
    }
    // The session ended while the copy applied: accounts and settings from it do not apply to the next sign-in.
    if (returning && !session.authed) forgetAccount();
    ui.hideSplash(prefs.motion);
    startAppWorker();
  }

  // Start from the copy: as soon as the server answers, its state applies again, even if the browser reported "online" all along.
  $effect(() => {
    if (!session.fromCopy) return;
    return untrack(() =>
      pollVisible(
        window,
        CONFIG_POLL_MS,
        () => document.visibilityState === 'visible',
        () => void boot(),
      ),
    );
  });

  // Copy for starting without a network: ends with the session, only the server's state is stored.
  $effect(() => {
    if (session.fromCopy || session.status !== 'ready') return;
    if (!session.user) {
      forgetStartCopy();
      // The stored mails end with the session too.
      void mailStores.dropAll();
      void editLogs.dropAll();
      return;
    }
    if (!session.config || !prefs.remote || !accounts.list) return;
    saveStartCopy({
      config: session.config,
      user: session.user,
      accounts: accounts.list,
      settings: { version: prefs.version, settings: prefs.values },
    });
  });

  // Bell: fetch at startup, every 60 s while the page is visible and on returning to the tab.
  $effect(() => {
    if (!session.authed) return;
    const stop = untrack(() => notifications.watch());
    // "… ago" and "Today" keep updating even if a fetch fails.
    const clock = setInterval(() => (bellNow = Date.now()), POLL_MS);
    return () => {
      stop();
      clearInterval(clock);
    };
  });

  // Titles and texts of the bell come in the account's language: after a switch, reload
  // once the setting is saved instead of showing the old one until the next fetch.
  let bellLang = prefs.lang;
  $effect(() => {
    const lang = prefs.lang;
    if (lang === bellLang) return;
    bellLang = lang;
    if (session.authed) untrack(() => void prefs.settled().then(() => notifications.load()));
  });

  // Push with an open window: bell and list do not wait for their next fetch.
  $effect(() =>
    listenForPushNews(
      () => void notifications.load(),
      (account) => live.refresh(account),
    ),
  );

  // Copy for the service worker: quiet hours and accounts apply there even without a session.
  $effect(() => {
    if (!prefs.loaded || !accounts.list || !session.user) return;
    const { nQuiet: on, nFrom: from, nTo: to } = prefs.values;
    mailPush.share({
      user: session.user.id,
      quiet: { on, from, to, tz: displayZone(prefs.values, browserTimeZone()) },
      accounts: Object.fromEntries(accounts.list.map((account) => [account.id, account.email])),
      appName: session.appName,
      lang: prefs.values.lang,
    });
  });

  // Click on a push notification with an open window: the service worker names the path.
  $effect(() =>
    listenForPushClicks((path) => {
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- app path from the message, checked by safePath()
      void goto(path);
    }),
  );

  // Mail accounts of the signed-in account: at startup, after sign-in, invitation and setup.
  $effect(() => {
    if (!session.user) return;
    untrack(() => {
      accounts.ensure().catch((error: unknown) => ui.toasts.error(failText(error)));
    });
  });

  $effect(() => {
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- ENTRY is resolved with resolve()
    if (target && target !== path) void goto(ENTRY[target], { replace: true });
  });

  $effect(() => {
    applyTheme(document.documentElement, { ...themeOf(prefs.values, session.branding), animations: prefs.motion });
  });

  // Language on `<html lang>` (WCAG 3.1.1); the account's then also applies without sign-in on this device.
  $effect(() => {
    const lang = prefs.lang;
    document.documentElement.lang = lang;
    if (prefs.remote) rememberLang(lang);
  });

  // Close open menus on a page change – except for `ui.keepMenuAt` (account selection in the "Mailboxes" sheet, paging).
  $effect(() => {
    const keep = path === ui.keepMenuAt;
    ui.keepMenuAt = null;
    if (!keep) ui.closeMenu();
  });

  // Report failed saving of the settings; the fields are already reset (`ERR_TXT.pref`).
  $effect(() => {
    if (prefs.error) untrack(() => ui.toasts.error(failText(prefs.error, m.error_pref())));
  });

  /**
   * Navigates to a target resolved with `resolve()` and closes open
   * menus; `keepMenu` leaves the open sheet in place (account selection in the
   * "Mailboxes" sheet, `swPick()`).
   */
  function go(to: string, keepMenu = false) {
    void navigate(to, keepMenu);
  }

  /** Jump to an administration page (shortcut, palette, notice, notification): closes the search results. */
  function goAdmin(to: string) {
    search.resultsOpen = false;
    go(to);
  }

  /** Like `go`; resolves once the target is shown. */
  function navigate(to: string, keepMenu = false): Promise<void> {
    if (keepMenu) ui.keepMenuAt = to;
    else ui.closeMenu();
    // The target is the open address (active navigation entry): replace the entry instead of duplicating it,
    // like SvelteKit for links to the current page. It compares with the browser's address,
    // not with `page.url`: that stays unchanged after shallow navigation (compose after saving).
    const here = window.location.href;
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass resolve() results
    if (new URL(to, here).href === here) return goto(to, { replace: true });
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- callers pass resolve() results
    return goto(to);
  }

  /** Mailbox, folder or tag of an account */
  function openMailbox(account: string, target: MailboxTarget, keepMenu = false) {
    const to = resolve('/mailbox/[account]/[...path]', mailboxParams(account, target));
    // Choosing a mailbox, folder or tag closes the drawer, the same one again too.
    ui.drawer = false;
    // The same mailbox again (row, 1–6) adds no further history entry.
    if (to !== path) go(to, keepMenu);
    else if (!keepMenu) ui.closeMenu();
  }

  /** Targets after creating a folder: the new folder in the sidebar's view, undo goes back. */
  function folderNav(): FolderOpenNav {
    const before = path;
    const all = scope.all;
    return {
      open: (account, id) =>
        openMailbox(all ? ALL_ACCOUNTS : account, all ? { folder: id, owner: account } : { folder: id }),
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- `path` is a resolved address
      restore: () => void goto(before),
    };
  }

  /**
   * "New folder" (`addFolder`): in the account `account`, otherwise in the default account
   * or the first one – only accounts the browser may reach. Without a
   * mail account the notice as for "New email".
   */
  function addFolder(account: string | null) {
    const usable = (accounts.list ?? []).filter((a) => a.state === 'ok' && !a.blocked);
    const fallback = defaultAccountOf(usable, prefs.values.defaultAccount);
    const target = usable.find((a) => a.id === account) ?? fallback;
    if (target) folders.add(target.id);
    else if (!accounts.list?.length) ui.toasts.show(m.compose_no_account());
    else ui.toasts.error(m.error_act());
  }

  /** Targets after creating a tag: the new tag in the sidebar's view, undo goes back. */
  function tagNav(): TagOpenNav {
    const before = path;
    const key = scope.key ?? ALL_ACCOUNTS;
    return {
      open: (id) => openMailbox(key, { tag: id }),
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- `path` is a resolved address
      restore: () => void goto(before),
    };
  }

  /** "New tag" (`addTag`): tags apply to all mailboxes; without a mail account the notice as for "New email". */
  function addTag() {
    if (accounts.list?.length) tagEdit.add();
    else ui.toasts.show(m.compose_no_account());
  }

  /** Dialog to name a folder or tag; on desktop above the shell, on mobile as a level-2 sheet. */
  const nameProps = $derived(folders.values(folderNav) ?? tagEdit.values(tagNav));
  const nameOpen = $derived(folders.dialog !== null || tagEdit.dialog !== null);
  function closeName() {
    folders.close();
    tagEdit.close();
  }

  // A removed account (also on another device) takes its dialog with it.
  $effect(() => {
    const d = folders.dialog;
    if (d && accounts.list && !accounts.list.some((a) => a.id === d.account)) untrack(() => folders.close());
  });

  /**
   * Return path from compose (`ret`, `backLabel` in `cmpVals`): mailbox with
   * its name, "Back to message", the area or "Back". An already
   * open compose keeps its own.
   */
  function composeReturn(): ComposeReturn | null {
    if (path.startsWith('/compose/')) return compose.current?.ret ?? null;
    const href = page.url.pathname + page.url.search;
    const loc = mailboxLocation;
    if (loc?.thread) return { href, label: m.compose_back_message() };
    if (loc) {
      return { href, label: appListView(loc, reachable(scopeAccounts), scope.all).title };
    }
    if (path.startsWith('/account/mail-accounts/') && path.split('/').length > 4)
      return { href, label: m.compose_back_mail_account() };
    if (path.startsWith('/settings/') || path.startsWith('/account/')) return { href, label: m.shell_settings() };
    if (path.startsWith('/admin/')) return { href, label: m.shell_admin() };
    return { href, label: m.compose_back() };
  }

  /** "New email" (C, palette, sidebar, tab bar; `openCompose`): without a mail account only the notice. */
  function openCompose() {
    if (!mailAccountCount) {
      ui.toasts.show(m.compose_no_account());
      return;
    }
    if (compose.start({ account: scope.all ? null : (scope.account?.id ?? null) }, composeReturn()))
      go(resolve('/compose/[draft]', { draft: NEW_DRAFT }));
  }

  /**
   * Open search results (`openResults`): Enter in the search field, palette. The
   * return path for "Close" is the open page; on the search itself the text
   * already applies and is only remembered.
   */
  function openResults(q: string) {
    if (path === SEARCH) {
      search.q = q;
      search.remember(q);
      return;
    }
    search.open(q.trim(), path, resOpen);
    go(SEARCH);
  }

  /**
   * Contact in the search (`sFrom`): messages from the address. Outside the
   * search page the results open without text like `openResults('')`; the
   * suggestions have already closed, so the scope "Only in …" applies as it
   * was chosen there.
   */
  function searchFrom(email: string) {
    search.searchFrom(email);
    if (path === SEARCH) return;
    search.open('', path, true);
    go(SEARCH);
  }

  /** Area of the open view for the search suggestions (`sCtx`); none on the search and on mobile. */
  $effect(() => {
    search.setContext(!ui.isMobile && path !== SEARCH ? scopeOf(path, session.isAdmin, search.env) : null);
  });

  /** Search suggestions open (`resOpen`): only on desktop and not on the search, which shows the results itself. */
  const resOpen = $derived(!ui.isMobile && ui.menu === 'results' && path !== SEARCH);
  /** Search suggestions in filter mode (`fOpen`): everywhere instead of only in the view. */
  const filterMode = $derived(resOpen && (search.scope === 'all' || !search.context));

  /** Open search suggestions (`menu: 'results'`), first for the open view (`sScope: 'here'`). */
  function openSuggestions(scope: 'here' | 'all' = 'here') {
    search.scope = scope;
    ui.menu = 'results';
  }

  /** Focus in the search field (`onSearchFocus`): open suggestions; on the search it closes open menus. */
  function onSearchFocus() {
    if (path === SEARCH) {
      ui.closeMenu();
      return;
    }
    if (ui.menu !== 'results') openSuggestions();
  }

  /** Typing in the search field (`onSearch`): on the search the results follow, otherwise the suggestions. */
  function onSearch(event: Event & { currentTarget: HTMLInputElement }) {
    search.q = event.currentTarget.value;
    if (path !== SEARCH && ui.menu !== 'results') openSuggestions();
  }

  /**
   * Filter button of the header (`toggleSf`): on the search, show and hide the
   * filter panel, otherwise open or close the search suggestions in filter mode
   * (`sScope: 'all'`, quick filters and "Browse").
   */
  function toggleSf() {
    if (path === SEARCH) {
      search.togglePanel();
      return;
    }
    if (filterMode) ui.closeMenu();
    else openSuggestions('all');
  }

  /** Open the page and scroll to the section (`goSec`, `sFlash`); the page may load it a bit later. */
  async function goSection(to: string, sec: string) {
    ui.closeMenu();
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- paths of the settings pages from `panelGroups()`
    await goto(to);
    for (let n = 0; n < 10; n++) {
      if (flashSection(document.body, sec, prefs.motion)) return;
      await new Promise((done) => setTimeout(done, 120));
    }
  }

  /** Actions without a target of their own close the results. */
  function leaveResults() {
    if (path === SEARCH) go(search.close() ?? HOME);
  }

  // Search hits operate the shell (`#lib/search-items.ts`).
  search.actions = {
    go: (to) => go(to),
    section: (to, sec) => void goSection(to, sec),
    compose: () => openCompose(),
    toggleTheme: () => {
      prefs.set({ mode: dark ? 'light' : 'dark' });
      leaveResults();
    },
    toggleSidebar: () => {
      toggleSidebar();
      leaveResults();
    },
    help: () => {
      leaveResults();
      ui.openHelp();
    },
    palette: () => {
      leaveResults();
      ui.openPalette();
    },
    addAccount: () => go(ADD_ACCOUNT),
    invite: () => {
      ui.userInvite = true;
      go(USERS);
    },
    openUser: (id) => {
      ui.userOpen = id;
      go(USERS);
    },
    searchFrom: (email) => searchFrom(email),
    logout: () => void logout(),
  };

  /**
   * Enter in the header's search field (`onSearchKey`): open results; without
   * text and filters only close the suggestions. The search suggestions handle
   * arrow keys and Enter on a highlighted row themselves beforehand.
   */
  function onSearchKey(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.isComposing) return;
    if (search.q.trim() || search.filtered) openResults(search.q);
    else ui.closeMenu();
    (event.currentTarget as HTMLInputElement | null)?.blur();
  }

  /** A click outside a popup closes the menu (`onDocDown`). */
  function onDocDown(event: MouseEvent) {
    if (!ui.menu || ui.isMobile) return;
    if (event.target instanceof Element && event.target.closest('[data-pop]')) return;
    ui.closeMenu();
  }

  function onKey(event: KeyboardEvent) {
    // Outside the shell only Escape for an open confirmation (keyCommand with `confirm`).
    if (!inShell && !ui.confirm) return;
    const command = keyCommand(event, {
      isMobile: ui.isMobile,
      isAdmin: session.isAdmin,
      keys: prefs.values.gKeys,
      dialog: ui.palette || ui.help || tagFixShown || nameOpen,
      // Above a page dialog, ⌘K for instance would open the palette invisibly below it.
      confirm: ui.confirm !== null || pageDialog !== null,
      compose: !!compose.current && path.startsWith('/compose/'),
      // Paging and replying also with an open menu; another conversation closes the reading view's popovers.
      reader: ui.reader !== null,
      reply: !!ui.reader?.reply,
      list: ui.listKeys !== null && ui.reader === null && !ui.menu,
    });
    if (!command) return;
    if (command === 'escape') escape(event);
    // Enter on a row already opens it itself (`r.onKey`); otherwise only with a focused row.
    else if (command === 'open') {
      if (!event.defaultPrevented && ui.listKeys?.open()) event.preventDefault();
    }
    // ↑/↓ only if the list has rows; otherwise the browser scrolls as usual.
    else if (command === 'down' || command === 'up') {
      if (ui.listKeys?.move(command === 'down' ? 1 : -1)) event.preventDefault();
    } else {
      event.preventDefault();
      runKey(command);
    }
  }

  /** Escape closes the topmost open thing; otherwise the focus leaves the field. */
  function escape(event: KeyboardEvent) {
    if (ui.confirm) ui.confirmCancel();
    // Already handled (e.g. by the sheet or a field of the page).
    else if (event.defaultPrevented) return;
    else if (pageDialog) pageDialog.close();
    else if (nameOpen) {
      // Only close the dialog; on mobile "Mailboxes" stays below (its sheet checks `defaultPrevented`).
      event.preventDefault();
      closeName();
    } else if (sheet === 'folders' && mSwOpen) {
      // Only close "Switch account"; the "Mailboxes" sheet below stays.
      event.preventDefault();
      mSwOpen = false;
    } else if (sheet === 'folders' && tagFixShown) {
      // Only close "Fix tags"; the "Mailboxes" sheet below stays.
      event.preventDefault();
      tagFixOpen = false;
    } else if (ui.palette) ui.closePalette();
    else if (ui.help) ui.help = false;
    else if (tagFixShown) tagFixOpen = false;
    else if (ui.menu) ui.closeMenu();
    else if (drawerOpen) closeDrawer(true);
    // Overlaid filter panel of the search (`rfOver`), also from a field of the panel.
    else if (path === SEARCH && search.panelOverlaid) search.closePanel();
    // Compose on desktop: first the "Send as" menu, then close (`cmpClose`), also from a field.
    else if (compose.current && path.startsWith('/compose/') && !ui.isMobile) {
      if (compose.current.menu) compose.closeMenu();
      else void compose.close({ leave: (ret) => go(ret.href), reopen: () => {} });
    }
    // Reading view on desktop: back to the list (`pfClose`), not from an input field or text area.
    else if (ui.reader && !ui.isMobile && !textField(event.target)) ui.reader.close();
    else if (event.target instanceof HTMLElement) event.target.blur();
  }

  function runKey(command: Exclude<KeyCommand, 'escape' | 'open' | 'down' | 'up'>) {
    if (typeof command === 'object') {
      if ('palette' in command) ui.openPalette(command.palette);
      // 1–6 without a mail account have no effect; in "All accounts" they open the role across all accounts.
      else if (scope.key) openMailbox(scope.key, { role: command.role });
    } else if (command === 'togglePalette') {
      if (ui.palette) ui.closePalette();
      else ui.openPalette();
    } else if (command === 'search') searchInput?.focus();
    else if (command === 'sidebar') toggleSidebar();
    else if (command === 'settings') openSettings();
    else if (command === 'help') ui.openHelp();
    else if (command === 'mailservers') goAdmin(MAILSERVERS);
    else if (command === 'next') ui.reader?.next();
    else if (command === 'prev') ui.reader?.prev();
    else if (command === 'reply') ui.reader?.reply?.('reply');
    else if (command === 'forward') ui.reader?.reply?.('fwd');
    else openCompose();
  }

  /** Set filters of the search (`nF`), for the counter on the filter button. */
  const nF = $derived(search.chips.length);

  /** Reference for "… ago" and "Today" in the popup: on opening and every minute. */
  let bellNow = $state(Date.now());

  /** Visible entries of the bell and the unread ones among them (`visN`, `unread`). */
  const bell = $derived(
    visibleNotifications({ list: notifications.list, channels: prefs.values.nCh, topics: prefs.values.nMx }),
  );

  /** Notifications menu: opening marks as read and leads to the target. */
  const notifActions: NotifMenuActions = {
    open: (entry) => {
      void notifications.read(entry.id);
      const route = targetOf(entry.target);
      if (!route) return;
      // Team: the row of the user or the invitation; without a match the list stays.
      if (route.userOpen) ui.userOpen = route.userOpen;
      if (entry.target?.view === 'admin') goAdmin(route.path);
      else go(route.path);
    },
    dismiss: (id) => notifications.remove(id),
    markAll: () => void notifications.readAll(),
    enable: () => prefs.set({ nCh: { ...prefs.values.nCh, app: true } }),
    settings: () => go(NOTIFICATIONS),
  };

  const notifMenu = $derived(
    notifMenuValues(
      {
        isMobile: ui.isMobile,
        list: notifications.list,
        channels: prefs.values.nCh,
        topics: prefs.values.nMx,
        tz: timeZoneOf(prefs.values),
        now: bellNow,
      },
      notifActions,
    ),
  );

  /** Open or close the bell; reload fresh on opening. */
  function toggleBell() {
    if (ui.menu !== 'bell') {
      bellNow = Date.now();
      void notifications.load();
    }
    ui.toggleMenu('bell');
  }

  const header = $derived({
    isMobile: ui.isMobile,
    isTablet: ui.isTablet,
    sbExpanded: chrome === 'main' ? sbWide : !ui.navCollapsed,
    appName: session.appName,
    logo: session.logo,
    sbToggleOn: !sbHidden,
    hdrQ: search.q,
    hdrHasQ: search.q.length > 0,
    searchPlaceholder: m.shell_search_placeholder({ app: session.appName }),
    resOpen,
    resExp: resOpen,
    // Counter of all filters (`nF`); open means the search's filter panel.
    sfBtn: {
      aria: nF ? m.search_filter_active({ n: nF }) : m.shell_search_filter(),
      exp: path === SEARCH ? search.panelShown : filterMode,
      fill: filterMode,
      hasN: nF > 0,
      n: String(nF),
    },
    ...bellValues(bell.unread),
    bellOpen: ui.menu === 'bell',
    appsOpen: ui.menu === 'apps',
    accountOpen: ui.menu === 'account',
    userName: session.userName,
    initials: session.initials,
    showAdmin: session.isAdmin,
    adminOn: chrome === 'panel' && isAdminPath(path),
    settingsOn: path.startsWith('/settings/'),
  });

  // Only for administrators: whoever loses the role could no longer reach the switch.
  const debugBar = $derived(session.isAdmin && prefs.values.devDebug ? debugBarValues(currentEnv(path)) : null);

  /** Text of the "Sign-in expired" notice bar. */
  function staleText(list: readonly MailAccount[]): string | null {
    const stale = list.filter((a) => a.state === 'needs_reauth');
    const [first] = stale;
    if (!first) return null;
    if (stale.length > 1) return m.notice_stale_many({ n: stale.length });
    const checked = first.last_check_at ? Date.parse(first.last_check_at) : NaN;
    return Number.isNaN(checked)
      ? m.list_stale_one({ email: first.email })
      : m.notice_stale_last({ email: first.email, ago: ago(checked) });
  }

  const banners = $derived(
    inShell
      ? bannersOf(
          {
            offline: network.offline,
            offlineSimulated: network.simulated,
            endSimulation: () => network.simulate(false),
            waiting: waitingNotice,
            stuck: stuckNotices,
            lost: lostNotice,
            retryQueue: () => void edits.retry(),
            closeLost: () => (edits.queue.lost = null),
            doubled: doubledNotice,
            openDoubled,
            closeDoubled: () => (edits.queue.conflict = null),
            staleText: staleText(accounts.list ?? []),
            openAccounts: () => go(resolve('/account/mail-accounts')),
            isAdmin: session.isAdmin,
            maintenance: session.config?.maintenance.on ?? false,
            onMaintenancePage: path === '/admin/maintenance',
            systemMailOff: session.user?.system_mail_configured === false,
            onMailPage: path === '/admin/email',
            systemMailHidden: ui.systemMailHidden,
            openMaintenance: () => goAdmin(MAINTENANCE),
            openSystemMail: () => goAdmin(SYSTEM_MAIL),
            hideSystemMail: () => (ui.systemMailHidden = true),
            // Only with the settings: otherwise a banner closed for oneself would flash until their response.
            own: prefs.loaded ? (session.config?.banner ?? null) : null,
            ownHidden: prefs.values.bannerDismissedRev === session.config?.banner?.revision,
            openLink: (href) => window.open(href, '_blank', 'noopener'),
            hideOwn: (revision) => prefs.set({ bannerDismissedRev: revision }),
          },
          {
            offlineTitle: m.notice_offline_title(),
            offlineText: m.notice_offline_text(),
            offlineAct: m.notice_offline_act(),
            failTitle: m.offline_fail_title(),
            retry: m.offline_retry(),
            draftTitle: m.offline_draft_title(),
            draftAct: m.offline_draft_act(),
            staleTitle: m.notice_stale_title(),
            staleAct: m.mail_connection_reauth(),
            maintTitle: m.notice_maint_title(),
            maintText: m.notice_maint_text(),
            maintAct: m.notice_maint_act(),
            mailTitle: m.notice_mail_title(),
            mailText: m.notice_mail_text(),
            mailAct: m.notice_mail_act(),
            more: m.banner_more(),
          },
        )
      : [],
  );

  const account = $derived({
    isMobile: ui.isMobile,
    initials: session.initials,
    userName: session.userName,
    userEmail: session.user?.email ?? '',
    modeSeg: (
      [
        ['light', 'ti-sun', m.account_light(), !dark],
        ['dark', 'ti-moon', m.account_dark(), dark],
      ] as const
    ).map(([mode, icon, label, on]) => ({
      label,
      icon,
      on,
      onClick: () => {
        if (prefs.values.mode !== mode) prefs.set({ mode });
      },
    })),
    langSeg: langChoices(prefs.values.lang, (patch) => prefs.set(patch)),
    openAccountSettings: () => go(PROFILE),
    logout: () => void logout(),
  });

  const apps = $derived({
    isMobile: ui.isMobile,
    logo: session.logo,
    appSoonCal: () => ui.toasts.show(m.apps_calendar_soon()),
    appSoonCon: () => ui.toasts.show(m.apps_contacts_soon()),
    closeMenus: () => ui.closeMenu(),
    closeSheet: () => ui.closeMenu(),
  });

  /**
   * Palette commands. "Set up push notifications" opens Settings ›
   * Notifications with the push dialog (`ui.pushOpen`), "Add mail server" the
   * page with the dialog (`ui.serverAdd`).
   */
  const commands: Command[] = $derived.by(() => {
    const settings = m.palette_group_settings();
    const admin = m.palette_group_admin();
    const adminCommands: Command[] = session.isAdmin
      ? [
          { g: admin, label: m.palette_mailservers(), icon: 'ti-server-2', k: '⇧M', run: () => goAdmin(MAILSERVERS) },
          {
            g: admin,
            label: m.palette_mailserver_add(),
            icon: 'ti-server-bolt',
            run: () => {
              ui.serverAdd = true;
              goAdmin(MAILSERVERS);
            },
          },
        ]
      : [];
    const list: Command[] = [
      { g: m.palette_group_actions(), label: m.palette_compose(), icon: 'ti-pencil-plus', k: 'C', run: openCompose },
      ...mailboxCommands(accounts.list ?? [], (account, role) => openMailbox(account, { role })),
      { g: settings, label: m.palette_settings(), icon: 'ti-settings', k: ',', run: openSettings },
      {
        g: settings,
        label: dark ? m.palette_light() : m.palette_dark(),
        icon: dark ? 'ti-sun' : 'ti-moon',
        run: () => prefs.set({ mode: dark ? 'light' : 'dark' }),
      },
      {
        g: settings,
        label: m.shell_sidebar_toggle(),
        icon: 'ti-layout-sidebar',
        k: '[',
        run: toggleSidebar,
      },
      ...adminCommands,
      {
        g: m.palette_group_actions(),
        label: m.palette_folder_new(),
        icon: 'ti-folder-plus',
        // Account of the open view; in "All accounts" and outside the mailboxes the default account.
        run: () => {
          const account = mailboxLocation && mailboxLocation.account !== ALL_ACCOUNTS ? mailboxLocation.account : null;
          addFolder(account);
        },
      },
      { g: m.palette_group_actions(), label: m.palette_tag_new(), icon: 'ti-tag', run: addTag },
      {
        g: settings,
        label: m.palette_push(),
        icon: 'ti-bell-ringing',
        run: () => {
          ui.pushOpen = true;
          go(NOTIFICATIONS);
        },
      },
      {
        g: m.palette_group_help(),
        label: m.palette_shortcuts(),
        icon: 'ti-keyboard',
        k: '?',
        run: () => ui.openHelp(),
      },
    ];
    return list;
  });

  const palRows = $derived(
    paletteRows(commands, ui.palQ, ui.palIdx, {
      search: (q) => ({
        g: m.palette_group_search(),
        label: m.palette_search({ q, app: session.appName }),
        icon: 'ti-search',
        run: () => openResults(q),
      }),
      close: () => ui.closePalette(),
      select: (i) => (ui.palIdx = i),
    }),
  );

  function onPalKey(event: KeyboardEvent) {
    const n = palRows.length;
    const at = Math.min(ui.palIdx, n - 1);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      ui.palIdx = n ? (at + 1) % n : 0;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      ui.palIdx = n ? (at - 1 + n) % n : 0;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      palRows[at]?.run();
    }
  }

  const onOverlay = overlayClose;

  /** Mailbox, folder or tag of the address (the shell's `active`). */
  const mailboxLocation = $derived(parseMailboxPath(path));
  /**
   * Message or compose open: on mobile without header and tab bar, the
   * page has its own header (`mRdOff`); an error page does not.
   */
  const mReading = $derived(
    ui.isMobile &&
      ((!!mailboxLocation?.thread && !ui.readError) || (path.startsWith('/compose/') && !!compose.current)),
  );
  /** Last opened mailbox: search and other pages keep its account (the shell's `active` stays). */
  let lastMailbox = $state<MailboxLocation | null>(null);
  $effect(() => {
    if (mailboxLocation) lastMailbox = mailboxLocation;
  });
  /** Error page in the app frame instead of the page: router error, "Access denied". */
  const errorPage = $derived(!!page.error || forbidden);
  // The results page opens the search results (desktop), a mailbox and an error page (also on `/search`) close them.
  $effect(() => {
    if (mailboxLocation || errorPage) search.resultsOpen = false;
    else if (path === SEARCH) search.resultsOpen = !ui.isMobile;
  });
  /** View of the sidebar (`curA`, `allMode`): account or "All accounts" of the mailbox, otherwise the default. */
  const scope = $derived(sidebarScope(accounts.list, prefs.values.defaultAccount, mailboxLocation ?? lastMailbox));
  /** Accounts of the sidebar: in "All accounts" all, otherwise the one. */
  const scopeAccounts = $derived(scope.all ? (accounts.list ?? []) : scope.account ? [scope.account] : []);
  /** Active mailbox of the sidebar's view: that of the address, in compose and on the error page the one the user came from. */
  const here = $derived(
    activeLocation(scope, {
      path,
      location: mailboxLocation,
      lastMailbox,
      results: search.resultsOpen,
      error: errorPage,
    }),
  );
  /** Mailbox an account switch opens (`curF`): the open one, otherwise the inbox. */
  const curRole: RoleId = $derived.by(() => {
    const location = mailboxLocation ?? lastMailbox;
    return location && 'role' in location ? location.role : 'inbox';
  });
  /** Show the folder tree once an account of the view has its mailboxes (empty before instead of "No folders yet"). */
  const treeReady = $derived(scopeAccounts.some((a) => mailboxes.of(a.id)?.status === 'ready'));
  const activeFolder = $derived.by(() => {
    if (!here || !('folder' in here)) return null;
    const account = here.account === ALL_ACCOUNTS ? here.owner : here.account;
    return account ? { account, folder: here.folder } : null;
  });

  // Discard mailboxes, lists and conversations of removed accounts (also from another device).
  $effect(() => {
    const ids = accounts.list?.map((a) => a.id);
    if (ids)
      untrack(() => {
        mailboxes.retain(ids);
        threads.retain(ids);
        message.retain(ids);
        // Only with the server's state: the copy may not know a new account yet.
        if (session.fromCopy) return;
        session.mailStore?.retain(ids);
        edits.queue.retain(ids);
      });
  });

  // Pending changes: restore after startup and replay as soon as possible.
  const queueUser = $derived(session.user?.id);
  $effect(() => {
    if (!queueUser) return;
    return untrack(() => {
      void edits.restore();
      const stopPoll = pollVisible(
        window,
        QUEUE_POLL_MS,
        () => document.visibilityState === 'visible',
        () => void edits.queue.replay(),
      );
      const stopReturn = network.onReturn(() => edits.queue.resume());
      return () => {
        stopPoll();
        stopReturn();
      };
    });
  });

  // Live sync for all usable accounts, signed in and independent of the page; "Sign-in
  // required" and locked servers end it, "Sign in again" starts it again.
  $effect(() => {
    const ids = session.authed
      ? (accounts.list?.filter((a) => a.state === 'ok' && !a.blocked).map((a) => a.id) ?? [])
      : [];
    untrack(() => {
      live.retain(ids);
      // "Scheduled" sync for the same accounts.
      scheduled.retain(ids);
    });
  });

  // Mailboxes of the sidebar's accounts, only where it is visible; "Sign-in required" and locked
  // servers only read the storage. After an error the next page change tries
  // again; several failed accounts report one toast.
  $effect(() => {
    void path;
    if (chrome !== 'main' || !inShell) return;
    const open = scopeAccounts.filter(isReachable).map((a) => a.id);
    const closed = scopeAccounts.filter((a) => !isReachable(a)).map((a) => a.id);
    untrack(() => {
      for (const id of closed) void mailboxes.restore(id);
      let reported = false;
      for (const id of open)
        mailboxes.ensure(id).catch((error: unknown) => {
          if (reported || isApiError(error, 409)) return;
          reported = true;
          ui.toasts.error(failText(error, m.error_list()));
        });
    });
  });

  // Identities of the reachable accounts for the title of the account switch, silently: until then
  // and after an error the part of the address before the @; the next page change tries again.
  $effect(() => {
    void path;
    if (chrome !== 'main' || !inShell) return;
    const ids = (accounts.list ?? []).filter(isReachable).map((a) => a.id);
    untrack(() => compose.loadIdentities(ids));
  });

  /** Loading of the tags whose error a toast already reports: one per attempt, not per page change. */
  let tagsLoad: Promise<void> | null = null;

  // Load the user's tags once where the sidebar is visible; after an error the next page change
  // tries again.
  $effect(() => {
    void path;
    if (chrome !== 'main' || !inShell || !scope.key) return;
    untrack(() => {
      const load = tags.ensure();
      if (load === tagsLoad) return;
      tagsLoad = load;
      load.catch((error: unknown) => ui.toasts.error(failText(error, m.error_list())));
    });
  });

  /** Folder trees of the view's accounts; a value of its own so that expanding and collapsing do not rebuild them. */
  const trees = $derived(Object.fromEntries(scopeAccounts.map((a) => [a.id, mailboxes.tree(a.id)])));

  /** Folder tree (`fRows`): one account or, in "All accounts", all with header rows; on mobile in the "Mailboxes" sheet. */
  const folderValues = $derived.by(() => {
    if (!scopeAccounts.length) return null;
    const all = scope.all;
    return folderRows(
      {
        accounts: scopeAccounts.map((a) => ({ id: a.id, email: a.email, ...tileOf(a), tree: trees[a.id] ?? [] })),
        allMode: all,
        full: ui.isMobile || sbWide,
        mob: ui.isMobile,
        active: activeFolder,
        isOpen: (a, id) => mailboxes.isOpen(a, id),
        toggle: (a, id) => mailboxes.toggle(a, id),
        isAccountOpen: (a) => mailboxes.openAccounts.has(a),
        toggleAccount: (a) => mailboxes.toggleAccount(a),
        select: (a, id) => openMailbox(all ? ALL_ACCOUNTS : a, all ? { folder: id, owner: a } : { folder: id }),
        addFolder: (a) => addFolder(a),
      },
      {
        expand: m.folders_expand(),
        collapse: m.folders_collapse(),
        newIn: (email) => m.folders_new_in({ email }),
        count: (unread, total) => m.mailbox_count({ unread, total }),
      },
    );
  });

  /** Background below folder tree and tag list for rings and lines (`sbBg`): the sheet on mobile, the drawer, otherwise the sidebar. */
  const sbBg = $derived(ui.isMobile || drawerOpen ? 'var(--pop)' : 'var(--cnv)');

  /** A tag of the view is open (`inT`: dot on the "Tags" tab), even before the tags are loaded. */
  const inTag = $derived(here !== null && 'tag' in here);

  /** Tree of the tags with the counters of the view's accounts; a value of its own like `trees`. */
  const tagTree = $derived(tags.tree(scopeAccounts.map((a) => a.id)));

  /** Tag mismatches in the view's accounts; only accounts with loaded mailboxes. */
  const tagFixes = $derived(scopeAccounts.flatMap((a) => tags.problems(a.id)));
  /** Tags with a mismatch → email addresses of the accounts (marker on the row). */
  const tagWarnings = $derived.by(() => {
    const warnings: Record<string, string[]> = {};
    for (const p of tagFixes)
      if (p.kind !== 'unlinked')
        (warnings[p.tag] ??= []).push(scopeAccounts.find((a) => a.id === p.account)?.email ?? '');
    return warnings;
  });
  /** "Fix tags" dialog (`tsOpen`); on mobile as a second sheet above "Mailboxes". Closed without a mismatch. */
  let tagFixOpen = $state(false);
  const tagFixShown = $derived(tagFixOpen && tagFixes.length > 0);
  // Closed as soon as no mismatch remains (also after signing out) or the "Mailboxes" sheet closes on mobile –
  // otherwise it would reopen by itself on the next case or sheet.
  $effect(() => {
    if (!tagFixes.length || (ui.isMobile && sheet !== 'folders')) tagFixOpen = false;
  });
  // Another view has other cases.
  $effect(() => {
    void scope.key;
    untrack(() => (tagFixOpen = false));
  });

  /** Sync action; after the last mismatch the dialog closes with "Tags fixed". */
  async function runTagFix(problem: TagProblem, action: TagFix) {
    const before = tags.list ?? [];
    try {
      if (!(await tags.fix(problem, action))) return;
    } catch (error) {
      ui.toasts.error(tagFixError(error));
      return;
    }
    if (tagFixes.length) ui.toasts.show(tagFixToast(problem, action, before));
    else {
      tagFixOpen = false;
      ui.toasts.show(m.tagfix_done_all());
    }
  }

  const tagFixProps = $derived(
    tagFixShown
      ? tagFixValues({
          problems: tagFixes,
          tags: tags.list ?? [],
          accounts: scopeAccounts.map((a) => ({ id: a.id, email: a.email, ...tileOf(a) })),
          allMode: scope.all,
          busy: (key) => tags.busy.get(key),
          run: (problem, action) => void runTagFix(problem, action),
        })
      : null,
  );

  /** Tag list (`tagRows`) of the sidebar or the "Mailboxes" sheet; `null` until the first load. */
  const tagValues = $derived.by(() => {
    const key = scope.key;
    if (!key || tags.list === null) return null;
    return tagRows(
      {
        tree: tagTree,
        full: ui.isMobile || sbWide,
        mob: ui.isMobile,
        active: here && 'tag' in here ? here.tag : null,
        isOpen: (id) => tags.isOpen(id),
        toggle: (id) => tags.toggle(id),
        select: (id) => openMailbox(key, { tag: id }),
        warnings: tagWarnings,
        fixes: tagFixes.length,
        openFix: () => (tagFixOpen = true),
      },
      {
        expand: m.tags_expand(),
        collapse: m.tags_collapse(),
        count: (unread, total) => m.mailbox_count({ unread, total }),
        warnOne: (email) => m.tags_warn_one({ email }),
        warnMany: (count) => m.tags_warn({ count }),
        fix: m.tagfix_title(),
        fixAria: (count) => (count === 1 ? m.tagfix_aria_one() : m.tagfix_aria({ count })),
      },
    );
  });

  const activeRole = $derived(here && 'role' in here ? here.role : null);
  /** Mailbox of a role in the sidebar's view. */
  const openRole = (role: RoleId) => {
    if (scope.key) openMailbox(scope.key, { role });
  };

  /** "Mailboxes" rows (the shell's `navRows`); in "All accounts" with the accounts' totals. */
  const mailRows = $derived.by(() => {
    if (!scope.key) return [];
    const list = scopeAccounts;
    return navRowsFor({
      active: activeRole,
      counts: (role) =>
        sumCounts(
          list.map((a) => {
            const box = mailboxes.role(a.id, role);
            return box ? countsOf(box) : null;
          }),
        ),
      wide: sbWide,
      keys: prefs.values.gKeys,
      open: openRole,
    });
  });

  /** Tab of the sidebar and the "Mailboxes" sheet. */
  let sbTab = $state<SidebarTab>('mail');
  const accountCount = $derived(accounts.list?.length ?? 0);
  /** Account switcher open (`swOpen`); without an account the switch leads to "Add account". */
  const swOpen = $derived(ui.menu === 'acctsw');
  const acctSw = $derived(
    accountSwitch({
      scope,
      count: accountCount,
      open: swOpen,
      wide: sbWide,
      identities: scope.account ? compose.identitiesOf(scope.account.id) : null,
    }),
  );
  const allT2 = $derived(tilesOf(accounts.list ?? [], 2));
  /** Mobile: "Switch account" above the "Mailboxes" sheet (`mSwOpen`). */
  let mSwOpen = $state(false);

  /**
   * Account switch: the same mailbox in the chosen account or in "All accounts";
   * on mobile back to the "Mailboxes" sheet. The already selected view only
   * closes the popup so that the open folder or thread stays.
   */
  function pickScope(key: string) {
    if (ui.isMobile) mSwOpen = false;
    if (key === scope.key) {
      if (!ui.isMobile) ui.closeMenu();
    } else openMailbox(key, { role: curRole }, ui.isMobile);
  }

  const switcherProps = $derived(
    switcherValues({
      list: accounts.list ?? [],
      scope,
      defaultId: prefs.values.defaultAccount,
      isMobile: ui.isMobile,
      pick: pickScope,
      add: () => go(ADD_ACCOUNT),
      manage: () => go(MAIL_ACCOUNTS),
      close: () => (mSwOpen = false),
    }),
  );

  /** On mobile the "Mailboxes" sheet ("Inbox" tab in the open mailbox). */
  function openMailboxMenu() {
    mSwOpen = false;
    ui.menu = 'folders';
  }

  /** Mailbox menu. */
  const mailboxMenu: MailboxMenuValues = $derived({
    mFolderRows: scope.key ? mobileRows(activeRole, openRole) : [],
    sbTab,
    inFolder: folderValues?.inFolder ?? false,
    inTag,
    acctSw,
    allT2,
    // In "All accounts" every account has its "New folder in …" row in the tree.
    addFShow: !scope.all,
    addF: () => addFolder(scope.account?.id ?? null),
    addT: addTag,
    onTab: (t: SidebarTab) => (sbTab = t),
    toggleMSw: () => {
      if (accountCount) mSwOpen = !mSwOpen;
      else go(ADD_ACCOUNT);
    },
    closeSheet: () => ui.closeMenu(),
  });

  const tabsL = $derived([
    // In the view's mailbox "Inbox" opens the "Mailboxes" sheet, otherwise the inbox (`inboxId`).
    navItem(m.tabbar_inbox(), 'ti-inbox', here !== null, () => {
      if (here) openMailboxMenu();
      else if (scope.key) openMailbox(scope.key, { role: 'inbox' });
      else go(HOME);
    }),
    navItem(m.tabbar_search(), 'ti-search', path === SEARCH && !errorPage, () => go(SEARCH)),
  ]);
  const tabsR = $derived([
    navItem(m.tabbar_compose(), 'ti-pencil-plus', false, openCompose),
    navItem(m.tabbar_more(), 'ti-dots', false, () => ui.toggleMenu('nav')),
  ]);
  const navRows = $derived([
    navItem(m.shell_settings(), 'ti-settings', false, openSettings),
    ...(session.isAdmin ? [navItem(m.shell_admin(), 'ti-shield', false, openAdmin)] : []),
    navItem(m.shell_apps(), 'ti-grid-dots', false, () => (ui.menu = 'apps')),
  ]);

  // Settings navigation for settings, account and administration.
  const section = $derived(sectionOf(path));
  /**
   * Mobile: the area's list instead of the page (`mPanelList`); in the mail account's
   * start page also while the account selection navigates to the same subpage of
   * another account (otherwise the old account's page would flash briefly).
   */
  const panelList = $derived(
    ui.isMobile && chrome === 'panel' && (ui.panelList === path || sameMailAccountPage(ui.panelList, path)),
  );
  // Leaving the area (Back, tab bar, links) forgets the list: a page opened later with a target of its own shows the page.
  $effect(() => {
    if (ready && chrome !== 'panel') ui.panelList = null;
  });
  const backToApp = $derived(m.shell_back_to({ app: session.appName }));
  const sectionName = $derived(section === 'admin' ? m.shell_admin() : m.shell_settings());

  const hrefOf = (route: PanelRoute) => resolve(route);

  // Mail account: subpages of an account with their own navigation and account selection (`isMAView`).
  const maRoute = $derived(chrome === 'panel' ? mailAccountRouteOf(path) : null);
  const maHref = (id: string, slug: MailAccountSlug) => resolve(`/account/mail-accounts/[id]/${slug}`, { id });
  // Unknown account (removed, wrong address): to the list, also from start, once the list is known.
  $effect(() => {
    if (maRoute && accounts.list && !accounts.get(maRoute.id)) {
      ui.panelList = null;
      void goto(hrefOf('/account/mail-accounts'), { replace: true });
    }
  });
  const maTargets: MailAccountTargets = {
    open: (id, slug) => {
      ui.panelList = null;
      go(maHref(id, slug));
    },
    // On mobile the list of subpages the account selection came from stays.
    switchTo: (id, slug) => {
      const to = maHref(id, slug);
      if (panelList) ui.panelList = to;
      go(to);
    },
    add: () => go(resolve('/account/mail-accounts/new')),
    manage: () => go(hrefOf('/account/mail-accounts')),
  };
  const maNav = $derived(
    maRoute
      ? mailAccountNavValues({
          route: maRoute,
          isMobile: ui.isMobile,
          collapsed: ui.navCollapsed,
          pickerOpen: ui.menu === 'masw',
          togglePicker: () => ui.toggleMenu('masw'),
          closePicker: () => ui.closeMenu(),
          targets: maTargets,
        })
      : null,
  );
  /** Return path to the search at this page; the email account's own way back takes precedence. */
  const searchBack = $derived(maRoute ? null : search.returnAt(path));
  /**
   * Mobile "Back": on start to "Email accounts", on a subpage with the account's address; after a
   * search hit "Search" or "Search results" (`mBackLabel`).
   */
  const mBackLabel = $derived(
    maRoute
      ? panelList
        ? m.mail_account_back_list()
        : accounts.get(maRoute.id)?.email || m.nav_group_account()
      : searchBack
        ? returnLabel(searchBack.kind)
        : panelList
          ? backToApp
          : sectionName,
  );

  /**
   * Settings or administration without a page of their own (`,`, the gear, "Open settings", More › Settings,
   * "Administration"): the page last opened there in this session; on mobile first the area's list.
   */
  function openSection(to: string) {
    ui.panelList = to;
    go(to);
  }
  function openSettings() {
    openSection(hrefOf(settingsHome()));
  }
  function openAdmin() {
    openSection(hrefOf(adminHome(prefs.values.advanced)));
  }

  function openPage(target: PanelPage) {
    ui.panelList = null;
    go(hrefOf(target.route));
  }

  /**
   * "Back" of the mobile header: back to the search, from the page to the list, from the list to the app (`mBack`);
   * resolves once the target is shown.
   */
  function panelBack(): Promise<void> {
    const toSearch = maRoute ? null : searchReturn(path);
    if (toSearch) return toSearch;
    if (ui.isMobile && !panelList) {
      ui.panelList = path;
      return tick();
    }
    return navigate(maRoute ? hrefOf('/account/mail-accounts') : HOME);
  }

  /**
   * "Back" of the settings navigation (desktop and tablet): back to the search, to the app, from a
   * mail account to its list; resolves once the target is shown.
   */
  function deskBack(): Promise<void> {
    return (maNav ? null : searchReturn(path)) ?? navigate(maNav ? hrefOf('/account/mail-accounts') : HOME);
  }

  /**
   * Swiping right to go back (same target as "Back"): on mobile on the page of the panel,
   * on tablets (coarse pointer without the mobile layout) on the row of navigation and panel.
   */
  const backSwipe = (back: () => Promise<void>): BackSwipe | null =>
    chrome === 'panel' && ui.swipeOn ? { animations: prefs.motion, back } : null;
  /** Pulling up "More" from the tab bar (mobile). */
  const morePull = (): SheetPull | null =>
    ui.swipeOn ? { animations: prefs.motion, open: () => (ui.menu = 'nav'), close: () => ui.closeMenu() } : null;
  /** Tablet: the rows of the shell leave scrolling to the browser and the horizontal movement to the gestures. */
  const tablet = $derived(ui.isTablet);

  /** "Advanced settings": without it "Developer" disappears from the navigation (`tgAdv`). */
  function toggleAdvanced() {
    const on = !prefs.values.advanced;
    prefs.set({ advanced: on });
    if (!on) advancedOff();
    if (!on && pageOf(path)?.id === 'developer') {
      const to = hrefOf(ADMIN_HOME);
      // On mobile the area's list the switch came from stays.
      if (ui.panelList === path) ui.panelList = to;
      go(to);
    }
  }

  const settingsNav: SettingsNavValues = $derived.by(() => {
    const groups = navGroupValues({
      path,
      isMobile: ui.isMobile,
      collapsed: ui.navCollapsed,
      advanced: prefs.values.advanced,
      open: openPage,
    });
    const backLabel = maNav ? m.mail_account_back() : searchBack ? returnBackLabel(searchBack.kind) : backToApp;
    return {
      isMobile: ui.isMobile,
      appName: session.appName,
      logo: session.logo,
      version: m.nav_version({ version: buildInfo.version }),
      collapsed: ui.navCollapsed,
      backLabel,
      backTip: ui.navCollapsed ? backLabel : undefined,
      panelBack: () => void deskBack(),
      mPanelH: sectionName,
      isAdminView: section === 'admin',
      // In the mail account the subpages as one group without a heading.
      settingsGroups: maNav ? [{ label: '', hasLabel: false, items: maNav.maNav }] : groups,
      noSettingsHits: !maNav && groups.length === 0,
      tgAdv: { on: prefs.values.advanced, onClick: toggleAdvanced },
      ma: maNav,
    };
  });

  /** Mobile sheets with content; `pick` is set by the page (`ui.pick`). */
  const SHEETS: readonly MenuKey[] = ['nav', 'bell', 'account', 'apps', 'masw', 'folders', 'pick'];
  const sheet = $derived(ui.isMobile && ui.menu && SHEETS.includes(ui.menu) ? ui.menu : null);
  /** Page dialog above the shell, e.g. the mail server dialog (`srvDesk`, `srvMob`). */
  const pageDialog = $derived(ui.pageDialog?.() ?? null);

  /** Error page instead of the page: session, "Access denied", router error. */
  const errorShown: ErrorCode | null = $derived(
    session.status === 'error'
      ? (session.failure ?? '500')
      : forbidden
        ? '403'
        : page.error
          ? errorCodeOf(page.status)
          : null,
  );
  /** Document title per route (WCAG 2.4.2). */
  const title = $derived(
    pageTitle({
      path,
      appName: session.appName,
      error: errorShown,
      mailbox: mailboxLocation && accounts.list ? appListView(mailboxLocation, scopeAccounts, scope.all).title : null,
      compose: compose.current ? composeTitle(compose.current) : null,
      loginTitle: loginTitleOf(session.branding),
    }),
  );
</script>

<svelte:head>
  <title>{title}</title>
</svelte:head>

<svelte:document onmousedown={onDocDown} />
<svelte:window onkeydown={onKey} />

<!-- Folder tree of the sidebar or the "Mailboxes" sheet; empty until the first load instead of "No folders yet". -->
{#snippet folderTree()}
  {#if folderValues && treeReady}<FolderTree {...folderValues} {sbBg} />{/if}
{/snippet}

<!-- Tag list of the sidebar or the "Mailboxes" sheet; empty until the first load instead of "No tags yet". -->
{#snippet tagList()}
  {#if tagValues}<TagList {...tagValues} {sbBg} />{/if}
{/snippet}

<!-- Page content; administration without admin rights "Access denied". -->
{#snippet content()}
  {#if forbidden}<ErrorView code="403" />{:else}{@render children()}{/if}
{/snippet}

{#snippet bellPop()}<NotificationsMenu {...notifMenu} />{/snippet}
{#snippet appsPop()}<AppsMenu {...apps} />{/snippet}
{#snippet accountPop(id: string)}<AccountMenu {...account} {id} />{/snippet}

<!-- Sync pill: on desktop bottom left in the shell, on mobile in the page area. -->
{#snippet syncPill(isMobile: boolean)}
  {#if replaying}
    <SyncPill
      {isMobile}
      syncText={m.offline_replay()}
      syncSub={replaying === 1 ? m.offline_replay_sub_one() : m.offline_replay_sub_many({ count: replaying })}
    />
  {:else if syncing}
    <SyncPill {isMobile} syncText={m.sync_text()} {syncSub} />
  {/if}
{/snippet}

<!-- Toast and confirmation in the shell (desktop and mobile) and on pages without a shell. -->
{#snippet overlays()}
  {#if ui.toast}
    {#key ui.toast.id}
      <Toast
        isMobile={ui.isMobile}
        isPanel={chrome !== 'main'}
        toastText={ui.toast.text}
        toastUndo={ui.toast.undo}
        toastNoUndo={!ui.toast.undo}
        toastErr={ui.toast.error}
        toastOk={!ui.toast.error}
        toastRole={ui.toast.error ? 'alert' : 'status'}
        toastLift={toastLift.bottom !== null}
        toastB={toastLift.bottom === null ? '' : `${toastLift.bottom}px`}
        closeToast={() => ui.toasts.undo()}
        swipe={toastSwipe}
      />
    {/key}
  {/if}
  {#if ui.confirm}
    <ConfirmDialog
      isMobile={ui.isMobile}
      cf={confirmValues(ui.confirm, ui.confirmReady, m.confirm_ok())}
      confirmIn={ui.confirmIn}
      onConfirmIn={(e: Event & { currentTarget: HTMLInputElement }) => (ui.confirmIn = e.currentTarget.value)}
      confirmKey={(e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          ui.confirmOk();
        }
      }}
      confirmOk={() => ui.confirmOk()}
      confirmCancel={() => ui.confirmCancel()}
      onConfirmOverlay={onOverlay(() => ui.confirmCancel())}
    />
  {/if}
{/snippet}

{#if session.status === 'error'}
  <div class="bare"><ErrorView code={session.failure ?? '500'} retry={boot} /></div>
  <div class="layer">{@render overlays()}</div>
{:else if ready && !target}
  {#if chrome === 'bare'}
    <div class="bare">{@render children()}</div>
    <div class="layer">{@render overlays()}</div>
  {:else if !ui.isMobile}
    <div class="app" class:tablet>
      {#if banners.length}<NoticeBar isMobile={false} {banners} />{/if}
      <Header
        {...header}
        bind:searchInput
        {bellPop}
        {appsPop}
        {accountPop}
        {toggleBell}
        {toggleSidebar}
        goHome={() => go(HOME)}
        {onSearch}
        {onSearchKey}
        {onSearchFocus}
        openResults={() => openResults(search.q)}
        closeSuggestions={() => {
          if (ui.menu === 'results') ui.closeMenu();
        }}
        clearSearch={() => {
          search.q = '';
          searchInput?.focus();
        }}
        {toggleSf}
        {openAdmin}
        openSettingsBtn={openSettings}
        toggleApps={() => ui.toggleMenu('apps')}
        toggleAccount={() => ui.toggleMenu('account')}
      />
      <div class="body" class:tablet {@attach swipeBack(() => (tablet ? backSwipe(deskBack) : null))}>
        {#if drawerOpen}
          <!-- Scrim of the drawer: a click beside it closes it; Escape closes it from the keyboard. -->
          <div class="scrim" role="presentation" onclick={() => closeDrawer()}></div>
        {/if}
        {#if chrome === 'main'}
          <Sidebar
            wide={sbWide}
            collapsed={ui.collapsed}
            drawer={drawerOpen}
            closeDrawer={() => closeDrawer()}
            hidden={sbHidden}
            {sbTab}
            navRows={mailRows}
            inFolder={folderValues?.inFolder ?? false}
            {inTag}
            {acctSw}
            acctSwOpen={swOpen && accountCount > 0}
            {allT2}
            addFShow={!scope.all}
            addF={() => addFolder(scope.account?.id ?? null)}
            addT={addTag}
            onCreate={openCompose}
            onTab={(t: SidebarTab) => (sbTab = t)}
            toggleAcctSw={() => (accountCount ? ui.toggleMenu('acctsw') : go(ADD_ACCOUNT))}
            tags={tagList}
          >
            {#snippet folders()}{@render folderTree()}{/snippet}
            {#snippet switcher()}<AccountSwitcher {...switcherProps} />{/snippet}
          </Sidebar>
          <main class="card">{@render content()}</main>
        {:else}
          <SettingsNav {...settingsNav} />
          <main class="card scroll no-scrollbar" {@attach scrollbar}>
            <div class="panel" class:portrait={ui.isPortrait}>{@render content()}</div>
          </main>
        {/if}
      </div>
      <!-- Arrow chip of the back gesture (`swipeBack`). -->
      <div class="back-chip" data-back-chip aria-hidden="true"><Icon name="ti-arrow-left" /></div>
      {#if ui.palette}
        <CommandPalette
          palQ={ui.palQ}
          {palRows}
          palEmpty={palRows.length === 0}
          onPalQ={(e: Event & { currentTarget: HTMLInputElement }) => {
            ui.palQ = e.currentTarget.value;
            ui.palIdx = 0;
          }}
          {onPalKey}
          onPalOverlay={onOverlay(() => ui.closePalette())}
        />
      {/if}
      {#if ui.help}
        <ShortcutsDialog
          shortcuts={shortcutsFor(session.isAdmin)}
          closeHelp={() => (ui.help = false)}
          onHelpOverlay={onOverlay(() => (ui.help = false))}
        />
      {/if}
      {#if tagFixProps}
        <TagFixDialog
          {...tagFixProps}
          isMobile={false}
          close={() => (tagFixOpen = false)}
          overlay={onOverlay(() => (tagFixOpen = false))}
        />
      {/if}
      {#if nameProps}
        <NameDialog {...nameProps} isMobile={false} overlay={onOverlay(closeName)} />
      {/if}
      {#if pageDialog}{@render pageDialog.content(false)}{/if}
      {@render syncPill(false)}
      {@render overlays()}
      {#if debugBar}<DebugBar {...debugBar} />{/if}
    </div>
  {:else}
    <div class="app mobile">
      {#if banners.length}<NoticeBar isMobile={true} {banners} />{/if}
      <!-- Layer underneath the page during the back gesture (`swipeBack`). -->
      <div class="back-under" data-back-under aria-hidden="true"></div>
      <!-- Page area below the notice bar; the sync pill belongs to it and lies below the sheets. -->
      <div class="page" {@attach swipeBack(() => backSwipe(panelBack))}>
        {#if chrome === 'main'}
          {#if !mReading}
            <Header
              {...header}
              goHome={() => go(HOME)}
              openBellSheet={toggleBell}
              openAccountSheet={() => (ui.menu = 'account')}
            />
          {/if}
          <div class="m-main">{@render content()}</div>
          {#if !noAccounts && !mReading}<TabBar mTabsL={tabsL} mTabsR={tabsR} pull={morePull} />{/if}
        {:else}
          <header class="m-back">
            <button onclick={() => void panelBack()}>
              <span class="m-back-icon"><Icon name="ti-arrow-left" /></span>
              <span class="m-back-label">{mBackLabel}</span>
            </button>
          </header>
          <main class="m-panel no-scrollbar">
            {#if panelList && maNav}
              <MailAccountNav {...maNav} />
            {:else if panelList}
              <SettingsNav {...settingsNav} />
            {:else}
              {@render content()}
            {/if}
          </main>
        {/if}
        {@render syncPill(true)}
      </div>
      <div class="back-chip" data-back-chip aria-hidden="true"><Icon name="ti-arrow-left" /></div>
      {#if sheet === 'nav'}
        <Sheet label={m.tabbar_more()} onclose={() => ui.closeMenu()}>
          <NavMenu mNavTitle={m.tabbar_more()} mExtraRows={navRows} closeSheet={() => ui.closeMenu()} />
        </Sheet>
      {:else if sheet === 'folders'}
        <Sheet
          label={m.mailbox_menu_title()}
          onclose={() => ui.closeMenu()}
          behind={mSwOpen || tagFixShown || nameProps !== null}
        >
          <MailboxMenu {...mailboxMenu} tags={tagList}>
            {#snippet folders()}{@render folderTree()}{/snippet}
          </MailboxMenu>
        </Sheet>
        {#if mSwOpen}
          <Sheet level={2} label={m.switcher_title()} onclose={() => (mSwOpen = false)}>
            <AccountSwitcher {...switcherProps} />
          </Sheet>
        {:else if tagFixProps}
          <Sheet level={2} label={m.tagfix_title()} onclose={() => (tagFixOpen = false)}>
            <TagFixDialog {...tagFixProps} isMobile={true} close={() => (tagFixOpen = false)} />
          </Sheet>
        {/if}
      {:else if sheet === 'bell'}
        <Sheet label={m.notif_pop_title()} onclose={() => ui.closeMenu()}>
          <NotificationsMenu {...notifMenu} />
        </Sheet>
      {:else if sheet === 'account'}
        <Sheet label={session.userName} onclose={() => ui.closeMenu()}>
          <AccountMenu {...account} />
        </Sheet>
      {:else if sheet === 'apps'}
        <Sheet label={m.shell_apps()} onclose={() => ui.closeMenu()}>
          <AppsMenu {...apps} />
        </Sheet>
      {:else if sheet === 'masw' && maNav}
        <Sheet label={m.account_picker_title()} onclose={() => ui.closeMenu()}>
          <AccountPicker {...maNav.picker} />
        </Sheet>
      {:else if sheet === 'pick' && ui.pick}
        {@const pick = ui.pick()}
        <Sheet label={pick.title} onclose={() => ui.closeMenu()}>
          <PickerList {pick} closeSheet={() => ui.closeMenu()} />
        </Sheet>
      {/if}
      {#if pageDialog}
        <Sheet label={pageDialog.title} onclose={pageDialog.close}>
          {@render pageDialog.content(true)}
        </Sheet>
      {/if}
      {#if nameProps}
        <!-- Above "Mailboxes" or the page as a level-2 sheet. -->
        <Sheet level={2} label={nameProps.nameTitle} onclose={closeName}>
          <NameDialog {...nameProps} isMobile={true} />
        </Sheet>
      {/if}
      {@render overlays()}
      {#if debugBar}<DebugBar {...debugBar} />{/if}
    </div>
  {/if}
{/if}

{#if ui.splash}
  <Splash appName={session.appName} logo={session.logo} splash={ui.splash} />
{/if}

{#if ui.tip}
  <Tooltip tip={ui.tip} onplace={(tip: TipState) => (ui.tip = tip)} />
{/if}

<style>
  .bare {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }

  /* Toast and confirmation above pages without a shell that scroll themselves */
  .layer {
    position: fixed;
    inset: 0;
    z-index: 95;
    pointer-events: none;
  }

  .layer > :global(*) {
    pointer-events: auto;
  }

  .app {
    position: relative;
    height: 100dvh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    font-size: 15px;
  }

  .body {
    position: relative;
    z-index: 1;
    flex: 1;
    min-height: 0;
    display: flex;
  }

  /* Tablet: room for the home indicator below the shell */
  .app.tablet {
    padding-bottom: 10px;
  }

  .body.tablet {
    touch-action: pan-y;
  }

  /* Scrim of the drawer (tablet in portrait), below the sidebar (z-index 30) */
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 20;
    background: var(--scrim);
    animation: snFade 180ms ease-out;
  }

  /* Back gesture (`swipeBack`): layer underneath the page (mobile) and arrow chip, shown by the gesture */
  .back-under {
    position: absolute;
    inset: 0;
    z-index: 0;
    background: color-mix(in oklab, black 20%, var(--cnv));
    opacity: 0;
    pointer-events: none;
  }

  .back-chip {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 80;
    width: 44px;
    height: 44px;
    border-radius: 9999px;
    display: grid;
    place-items: center;
    background: var(--surface);
    color: var(--fg);
    box-shadow: var(--sh2);
    font-size: 20px;
    opacity: 0;
    pointer-events: none;
  }

  .card {
    flex: 1;
    min-width: 0;
    position: relative;
    margin: 0 16px 16px 0;
    display: flex;
    flex-direction: column;
    border-radius: 32px;
    background: var(--surface);
    box-shadow: var(--sh2);
    overflow: hidden auto;
  }

  .card.scroll {
    display: block;
  }

  .panel {
    max-width: 780px;
    margin: 0 auto;
    padding: 44px 40px 96px;
  }

  .panel.portrait {
    padding: 36px 28px 96px;
  }

  .page {
    position: relative;
    z-index: 1;
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    touch-action: pan-y;
  }

  .m-main {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
  }

  .m-back {
    flex-shrink: 0;
    height: 60px;
    display: flex;
    align-items: center;
    padding: 0 12px;
  }

  .m-back button {
    height: 46px;
    max-width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 16px 0 5px;
    border-radius: 9999px;
    font-size: 15px;
    font-weight: 700;
    text-align: left;
    transition: background-color var(--dur, 220ms);
  }

  .m-back button:hover {
    background: var(--hov);
  }

  .m-back-icon {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border-radius: 9999px;
    background: var(--surface);
    box-shadow: var(--sh1);
    display: grid;
    place-items: center;
    font-size: 18px;
  }

  .m-back-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .m-panel {
    position: relative;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    margin: 0 8px 8px;
    touch-action: pan-y;
    border-radius: 28px;
    background: var(--surface);
    box-shadow: var(--sh2);
    padding: 26px 18px 36px;
  }
</style>
