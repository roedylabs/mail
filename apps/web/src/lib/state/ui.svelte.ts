/**
 * State module `ui`: breakpoint, sidebar, open menu or
 * sheet, splash screen, sync pill, delayed loading indicators (skeletons),
 * toasts with delayed execution (`#lib/undo.ts`), tooltip,
 * command palette, keyboard shortcuts and confirmation.
 */
import { MOBILE_BP, NARROW } from '@roedy/tokens';
import type { Snippet } from 'svelte';
import { MediaQuery } from 'svelte/reactivity';
import { innerHeight, innerWidth } from 'svelte/reactivity/window';
import type { TipState } from '#lib/actions/tooltip.ts';
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import type { PickerValues } from '#lib/shell.ts';
import { devLog } from '#lib/state/devlog.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { isDarkMode } from '#lib/theme.ts';
import { Toasts, UNDO_MS, type Toast } from '#lib/undo.ts';

/** Splash screen: visible, fading out, gone. */
export type SplashState = 'on' | 'out' | null;

/**
 * Menus of the header, the tab bar and the account switcher;
 * `folders` is the "Mailboxes" sheet on mobile,
 * `pick` a page's selection list (`sel:…`), a popover on desktop,
 * on mobile a selection sheet (`ui.pick`); `rdtag` and `rdmove` are
 * the "Add tag" and "Move" popovers of the reading view on desktop.
 */
/**
 * Open menu or popover; `time` is a page's time picker on desktop
 * (`mkTime`, on mobile via `ui.pageDialog`), `results` the search suggestions below
 * the header's search field, `rulepick` the
 * target picker in the rule editor (`rlpick:‹j›`), also on mobile
 * in the page and without a sheet.
 */
export type MenuKey =
  | 'nav'
  | 'bell'
  | 'apps'
  | 'account'
  | 'acctsw'
  | 'masw'
  | 'folders'
  | 'pick'
  | 'time'
  | 'rdtag'
  | 'rdmove'
  | 'results'
  | 'rulepick';

/** Delay after which a skeleton appears when there is no data in memory. */
export const SKELETON_DELAY = 150;

/** Duration of the splash screen fade-out (matches the CSS transition of the splash screen). */
export const SPLASH_FADE = 380;

/** Request for the confirmation dialog (`ask()`). */
export interface ConfirmRequest {
  title: string;
  text: string;
  /** Icon of the tile; without it `ti-help-circle`. */
  icon?: IconName;
  /** Button label; without it "Confirm". */
  ok?: string;
  /** Red instead of dark (delete, remove). */
  danger?: boolean;
  /** Word that must be typed to confirm (in capitals). */
  word?: string;
  /** Without "Cancel"; then Escape and the backdrop do not close either. */
  noCancel?: boolean;
  /** Ask even if "Ask before deleting" is off. */
  force?: boolean;
  run: () => void;
}

/**
 * Dialog of a page that the layout shows above the shell (e.g. the mail server
 * dialog or the push dialog): on desktop `content(false)` renders backdrop
 * and dialog itself, on mobile `content(true)` sits in the sheet with `title`.
 * Escape closes via `close`.
 */
export interface PageDialog {
  title: string;
  close: () => void;
  content: Snippet<[boolean]>;
}

/** Keys of the reading view (`rdNav`): previous or next conversation of the list, back to the list. */
export interface ReaderKeys {
  prev(): void;
  next(): void;
  close(): void;
  /** R and F open the reply bar; missing where there is none (`rn.r`). */
  reply?: (mode: 'reply' | 'fwd') => void;
}

/** Keys of the list on desktop: ↑/↓ and Enter. */
export interface ListKeys {
  /** Focuses the next or previous row; `false` without rows (the key stays with the browser). */
  move(by: 1 | -1): boolean;
  /** Opens the focused row; `false` if no row of the list is focused. */
  open(): boolean;
}

export class Ui {
  /** Window width; without a window (tests without jsdom) like desktop. */
  width = $derived(innerWidth.current ?? NARROW);
  /** Window height; without a window 0. */
  height = $derived(innerHeight.current ?? 0);
  isMobile = $derived(this.width < MOBILE_BP);
  private systemDark = new MediaQuery('(prefers-color-scheme: dark)');
  /** Dark theme from `mode` and the operating system (shell, account menu, theme button of the guest pages). */
  dark = $derived(isDarkMode(prefs.values.mode, this.systemDark.current));
  private coarse = new MediaQuery('(pointer: coarse)');
  /**
   * Swipe gestures of the list and dragging dialogs down: on mobile and tablet,
   * the latter detected by the coarse primary pointer (touch) without the mobile layout.
   */
  swipeOn = $derived(this.isMobile || this.coarse.current);

  menu = $state<MenuKey | null>(null);
  /**
   * Address whose page change keeps the open menu; the layout closes it on every other one and then
   * clears this. Set by the account selection in the "Mailboxes" sheet (`swPick()`) and by paging in the
   * reading view (`pfOpen`, which only closes the reading view's own popovers). Not reactive.
   */
  keepMenuAt: string | null = null;
  /** Values of the open selection list (`pick`) for the mobile sheet; the page sets them. */
  pick = $state.raw<(() => PickerValues) | null>(null);
  /**
   * Open dialog of the page (`null` while none is open); the page
   * sets the function and clears it on leaving, the layout shows it above
   * everything (desktop) or as a sheet (mobile).
   */
  pageDialog = $state.raw<(() => PageDialog | null) | null>(null);
  /** "Add mail server" from the command palette: the page opens the dialog as soon as it is there. */
  serverAdd = $state(false);
  /** "Set up push notifications" from the command palette: Settings › Notifications opens the push dialog. */
  pushOpen = $state(false);
  /** "Invite user" from the search: Administration › Users opens the form. */
  userInvite = $state(false);
  /** User from the search: Administration › Users expands it. */
  userOpen = $state<string | null>(null);
  /**
   * Mobile: address under which the area's list stands instead of the page
   * ("Settings" or "Administration" from the "More" menu);
   * every other address shows the page.
   */
  panelList = $state<string | null>(null);
  /** Sidebar collapsed; collapsed at start below `NARROW`. */
  collapsed = $state(typeof window !== 'undefined' && window.innerWidth < NARROW);
  splash = $state<SplashState>('on');
  syncing = $state(false);

  /** Displayed toast; actions with undo via `toasts.defer()`. */
  toast = $state<Toast | null>(null);
  readonly toasts: Toasts;
  /** Displayed tooltip (`use:tooltip`, `#lib/actions/tooltip.ts`). */
  tip = $state<TipState | null>(null);

  /** Command palette with search text and highlighted row (`palQ`, `palIdx`). */
  palette = $state(false);
  palQ = $state('');
  palIdx = $state(0);
  /** Keyboard shortcuts dialog. */
  help = $state(false);
  /** Open confirmation with the typed word (`confirm`, `confirmIn`). */
  confirm = $state<ConfirmRequest | null>(null);
  confirmIn = $state('');
  /** Banner "System emails not set up" closed until reload. */
  systemMailHidden = $state(false);
  /** Already navigated within the app: "Back" on the error page then goes back in history, otherwise to the overview. */
  navigated = $state(false);
  /** Message theme inverted (`rdInv`): applies to every message until sign-out. */
  readInverted = $state(false);
  /** Open reading view on desktop: J/K and ←/→ page through, Escape closes (`rdNav`). */
  reader = $state.raw<ReaderKeys | null>(null);
  /** List on desktop without reading view: ↑/↓ and Enter; the list page sets it. */
  listKeys = $state.raw<ListKeys | null>(null);
  /** The reading view shows an error page: on mobile header and tab bar stay (the reading view does not count as an error page). */
  readError = $state(false);

  #splashTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(undoMs: () => number = () => UNDO_MS[prefs.values.gUndo]) {
    this.toasts = new Toasts((toast) => {
      this.toast = toast;
      if (toast) devLog.add(toast.error ? 'error' : 'info', m.dev_log_notice({ text: toast.text }));
    }, undoMs);
  }

  toggleMenu(key: MenuKey): void {
    this.menu = this.menu === key ? null : key;
  }

  /** Opens the command palette, if needed with the first typed character. */
  openPalette(q = ''): void {
    this.palette = true;
    this.palQ = q;
    this.palIdx = 0;
    this.menu = null;
  }

  closePalette(): void {
    this.palette = false;
    this.palQ = '';
  }

  openHelp(): void {
    this.help = true;
    this.menu = null;
  }

  /** Requests confirmation; without `gConfirm` the action runs immediately (except `force`). */
  ask(request: ConfirmRequest): void {
    if (!request.force && !prefs.values.gConfirm) {
      request.run();
      return;
    }
    this.confirm = request;
    this.confirmIn = '';
    this.menu = null;
  }

  /** Typed word matches, case-insensitively (or none is required). */
  get confirmReady(): boolean {
    const word = this.confirm?.word;
    return !!this.confirm && (!word || this.confirmIn.trim().toLocaleUpperCase('de') === word.toLocaleUpperCase('de'));
  }

  confirmOk(): void {
    const request = this.confirm;
    if (!request || !this.confirmReady) return;
    this.confirm = null;
    this.confirmIn = '';
    request.run();
  }

  confirmCancel(): void {
    if (!this.confirm || this.confirm.noCancel) return;
    this.confirm = null;
    this.confirmIn = '';
  }

  closeMenu(): void {
    this.menu = null;
  }

  /** Discards the session state (sign-out): menus, palette, dialogs, toast, closed banners. */
  reset(): void {
    this.menu = null;
    this.keepMenuAt = null;
    this.pick = null;
    this.pageDialog = null;
    this.serverAdd = false;
    this.pushOpen = false;
    this.userInvite = false;
    this.userOpen = null;
    this.panelList = null;
    this.closePalette();
    this.help = false;
    this.confirm = null;
    this.confirmIn = '';
    this.systemMailHidden = false;
    this.readInverted = false;
    // Back locally, but no more action at the server (`onUndo`): the account is gone right away.
    this.toasts.discard();
  }

  /**
   * A previous page of the app in the history: exact with the Navigation API
   * (same origin), otherwise whether the app has already navigated.
   */
  canGoBack(): boolean {
    const navigation = (globalThis as { navigation?: { canGoBack?: unknown } }).navigation;
    return typeof navigation?.canGoBack === 'boolean' ? navigation.canGoBack : this.navigated;
  }

  toggleSidebar(): void {
    this.collapsed = !this.collapsed;
  }

  /** Fades out the splash screen as soon as session and data are there (without artificial waiting). */
  hideSplash(animated = true): void {
    if (this.splash !== 'on') return;
    if (!animated) {
      this.splash = null;
      return;
    }
    this.splash = 'out';
    clearTimeout(this.#splashTimer);
    this.#splashTimer = setTimeout(() => {
      if (this.splash === 'out') this.splash = null;
    }, SPLASH_FADE);
  }
}

/**
 * Loading indicator that only appears after `SKELETON_DELAY`: `slow` becomes `true`
 * if the request takes longer, and `false` again after it ends.
 */
export class Loading {
  slow = $state(false);
  #running = 0;

  async run<T>(work: Promise<T>): Promise<T> {
    this.#running++;
    const timer = setTimeout(() => (this.slow = true), SKELETON_DELAY);
    try {
      return await work;
    } finally {
      clearTimeout(timer);
      if (--this.#running === 0) this.slow = false;
    }
  }
}

export const ui = new Ui();
