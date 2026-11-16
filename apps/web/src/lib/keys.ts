/**
 * Keyboard shortcuts of the shell: the list for the shortcuts dialog and the
 * Keyboard shortcuts page (in groups) as well as the mapping of a key to a
 * command.
 */
import type { IconName } from '#lib/icons.ts';
import { ROLE_IDS, type RoleId } from '#lib/routes.ts';
import type { Shortcut } from '#lib/shell.ts';
import { m } from '#lib/paraglide/messages.js';

/** Key in a field: enough for tests without a DOM. */
export interface KeyInput {
  key: string;
  preventDefault: () => void;
}

/** Entry "Manage mail servers" (⇧M), only for administrators. */
const MAILSERVERS = 'mailservers';

/** Part of `navigator` for detecting the system (tests without a DOM). */
export interface PlatformInfo {
  platform?: string;
  userAgentData?: { platform?: string };
}

/**
 * Apple system (macOS, iOS, iPadOS):
 * `userAgentData.platform` "macOS" or "iOS", otherwise `navigator.platform` with
 * Mac, iPhone, iPad or iPod – iPadOS with a keyboard reports "MacIntel". If the
 * access throws (e.g. a getter of a privacy extension), no Apple system applies.
 */
export function isApple(nav: PlatformInfo | undefined = globalThis.navigator): boolean {
  try {
    const p = nav?.userAgentData?.platform;
    return p ? /^(macos|ios)$/i.test(p) : /^(mac|iphone|ipad|ipod)/i.test(nav?.platform ?? '');
  } catch {
    return false;
  }
}

/**
 * Shown modifier key of the shortcuts: "⌘"
 * on Apple systems, otherwise "Ctrl". Both work on all systems.
 */
export function modKey(nav?: PlatformInfo): string {
  return isApple(nav) ? '⌘' : m.shortcuts_key_ctrl();
}

/** All shortcuts in display order. */
export function allShortcuts(): (Shortcut & { id: string })[] {
  const k = (...keys: string[]) => keys.map((key) => ({ k: key }));
  const esc = m.shortcuts_key_esc();
  return [
    { id: 'search', d: m.shortcuts_search(), keys: k('/') },
    { id: 'palette', d: m.shortcuts_palette(), keys: k(modKey(), 'K') },
    { id: 'compose', d: m.shortcuts_compose(), keys: k('C') },
    { id: 'sidebar', d: m.shortcuts_sidebar(), keys: k('[') },
    { id: 'settings', d: m.shortcuts_settings(), keys: k(',') },
    { id: 'help', d: m.shortcuts_help(), keys: k('?') },
    { id: MAILSERVERS, d: m.shortcuts_mailservers(), keys: k('⇧', 'M') },
    { id: 'inbox', d: m.shortcuts_inbox(), keys: k('1') },
    { id: 'sent', d: m.shortcuts_sent(), keys: k('2') },
    { id: 'drafts', d: m.shortcuts_drafts(), keys: k('3') },
    { id: 'scheduled', d: m.shortcuts_scheduled(), keys: k('4') },
    { id: 'trash', d: m.shortcuts_trash(), keys: k('5') },
    { id: 'spam', d: m.shortcuts_spam(), keys: k('6') },
    { id: 'list', d: m.shortcuts_list_move(), keys: k('↑', '↓') },
    { id: 'open', d: m.shortcuts_open(), keys: k(m.shortcuts_key_enter()) },
    { id: 'close-message', d: m.shortcuts_close_message(), keys: k(esc) },
    { id: 'next', d: m.shortcuts_next(), keys: k('→') },
    { id: 'prev', d: m.shortcuts_prev(), keys: k('←') },
    { id: 'reply', d: m.shortcuts_reply(), keys: k('R') },
    { id: 'forward', d: m.shortcuts_forward(), keys: k('F') },
    { id: 'close', d: m.shortcuts_close(), keys: k(esc) },
  ];
}

/** Shortcuts for the shortcuts dialog; without administrator rights without ⇧M. */
export function shortcutsFor(showAdmin: boolean): Shortcut[] {
  return allShortcuts()
    .filter((s) => showAdmin || s.id !== MAILSERVERS)
    .map(({ d, keys }) => ({ d, keys }));
}

/** Sections of the Keyboard shortcuts page (`data-sec`, `scTabs`). */
export type ShortcutSection = 'sc0' | 'sc1' | 'sc2' | 'sc3';

export interface ShortcutGroup {
  label: string;
  icon: IconName;
  sec: ShortcutSection;
  items: Shortcut[];
}

/** Groups of the page: label, icon and shortcuts in order. */
function groups(): [label: string, icon: IconName, ids: string[]][] {
  return [
    [m.shortcuts_group_general(), 'ti-keyboard', ['search', 'palette', 'compose', 'settings', 'help', 'close']],
    [
      m.shortcuts_group_navigation(),
      'ti-compass',
      ['sidebar', 'inbox', 'sent', 'drafts', 'scheduled', 'trash', 'spam', MAILSERVERS],
    ],
    [m.shortcuts_group_list(), 'ti-list', ['list', 'open']],
    [m.shortcuts_group_read(), 'ti-mail-opened', ['close-message', 'next', 'prev', 'reply', 'forward']],
  ];
}

/**
 * Shortcuts of the Keyboard shortcuts page in groups, from the same list as the
 * shortcuts dialog; without administrator rights "Manage mail servers" is
 * missing in the group "Navigation", empty groups are left out.
 */
export function shortcutGroups(showAdmin: boolean): ShortcutGroup[] {
  const all = new Map(allShortcuts().map((s) => [s.id, s]));
  return groups()
    .map(([label, icon, ids], i) => ({
      label,
      icon,
      sec: `sc${i}` as ShortcutSection,
      items: ids
        .filter((id) => showAdmin || id !== MAILSERVERS)
        .flatMap((id) => {
          const s = all.get(id);
          return s ? [{ d: s.d, keys: s.keys }] : [];
        }),
    }))
    .filter((g) => g.items.length > 0);
}

/** Tabs of the Keyboard shortcuts page (`scTabs`): scroll to the group. */
export function shortcutTabs(scrollTo: (section: ShortcutSection) => void): { label: string; onClick: () => void }[] {
  return groups().map(([label], i) => ({ label, onClick: () => scrollTo(`sc${i}` as ShortcutSection) }));
}

export type KeyCommand =
  | 'escape'
  | 'togglePalette'
  | 'search'
  | 'sidebar'
  | 'settings'
  | 'help'
  | 'mailservers'
  | 'compose'
  | 'next'
  | 'prev'
  | 'reply'
  | 'forward'
  | 'down'
  | 'up'
  | 'open'
  | { palette: string }
  | { role: RoleId };

export interface KeyContext {
  isMobile: boolean;
  isAdmin: boolean;
  /** Setting "Enable keyboard shortcuts" (`gKeys`). */
  keys: boolean;
  /** Palette or shortcuts open. */
  dialog: boolean;
  /** Confirmation or dialog of a page open: only Escape. */
  confirm: boolean;
  /** Reading view open (`rdNav`): J/→ next, K/← previous conversation. */
  reader?: boolean;
  /** Reading view with reply bar (`rn.r`): R replies, F forwards. */
  reply?: boolean;
  /** List without reading view and menu (`pfNav`): ↑/↓ select a row, Enter opens it. */
  list?: boolean;
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'target'> &
  Partial<Pick<KeyboardEvent, 'getModifierState'>>;

/** Characters of the shortcuts; on German keyboards "[" comes via AltGr+8 (Windows) or Option+5 (macOS). */
const SYMBOLS = new Set(['/', '[', ',', '?']);

/** Input field, select list or editable content: keys stay with the field there. */
export function editable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return /^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable;
}

/**
 * Command for a key: confirmation and mobile only Escape;
 * ⌘K/Ctrl+K and Escape always, everything else not in input fields, not in
 * open dialogs and only with `gKeys`. Another character opens the palette
 * with that character, 1–6 a mailbox, in the reading view J/K and
 * ←/→ page, R and F open the reply bar there, in the list ↑/↓ select a row and Enter opens it (not on
 * a button or link, whose Enter stays with them). Nothing with ⌘ or Ctrl; with Alt or AltGr (on
 * Windows Ctrl+Alt) only the characters of the shortcuts, because German keyboards produce "["
 * that way. ⇧M has no effect for users without administrator rights.
 */
export function keyCommand(event: KeyLike, ctx: KeyContext): KeyCommand | null {
  const { key } = event;
  if (ctx.confirm || ctx.isMobile) return key === 'Escape' ? 'escape' : null;
  if ((event.metaKey || event.ctrlKey) && key.toLowerCase() === 'k') return 'togglePalette';
  if (key === 'Escape') return 'escape';
  const altGr = (event.ctrlKey && event.altKey) || event.getModifierState?.('AltGraph') === true;
  if (editable(event.target) || event.metaKey || (event.ctrlKey && !altGr)) return null;
  if ((event.altKey || altGr) && !SYMBOLS.has(key)) return null;
  if (ctx.dialog || !ctx.keys) return null;
  // J/K also with Caps Lock or Shift.
  if (ctx.reader && (key === 'j' || key === 'J' || key === 'ArrowRight')) return 'next';
  if (ctx.reader && (key === 'k' || key === 'K' || key === 'ArrowLeft')) return 'prev';
  if (ctx.reply && (key === 'r' || key === 'R') && !event.repeat) return 'reply';
  if (ctx.reply && (key === 'f' || key === 'F') && !event.repeat) return 'forward';
  if (ctx.list && key === 'ArrowDown') return 'down';
  if (ctx.list && key === 'ArrowUp') return 'up';
  if (ctx.list && key === 'Enter') {
    const target = event.target instanceof Element ? event.target : null;
    return target?.closest('button, a') ? null : 'open';
  }
  if (key === '/') return 'search';
  if (key === '[') return 'sidebar';
  if (key === ',') return 'settings';
  if (key === '?') return 'help';
  if (key === 'M' && event.shiftKey) return ctx.isAdmin ? 'mailservers' : null;
  if (key === 'c' || key === 'C') return 'compose';
  // 1–6 select a mailbox of the active account; without a mail account the layout does nothing.
  const role = /^[1-6]$/.test(key) ? ROLE_IDS[Number(key) - 1] : undefined;
  if (role) return event.repeat ? null : { role };
  if (key.length === 1 && key.trim() && !event.repeat) return { palette: key };
  return null;
}
