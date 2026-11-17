import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isApple,
  keyCommand,
  modKey,
  textField,
  shortcutGroups,
  shortcutTabs,
  shortcutsFor,
  type KeyContext,
  type PlatformInfo,
} from './keys.ts';

const CTX: KeyContext = { isMobile: false, isAdmin: true, keys: true, dialog: false, confirm: false };

function key(k: string, patch: Partial<KeyboardEvent> = {}, target: EventTarget | null = document.body) {
  return { key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, target, ...patch };
}

describe('keyboard shortcuts', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists 21 shortcuts, without administrator rights without “Manage mail servers”', () => {
    const admin = shortcutsFor(true);
    const user = shortcutsFor(false);
    // 21 entries for administrators, 20 for users.
    expect(admin).toHaveLength(21);
    expect(user).toHaveLength(20);
    expect(admin[0]).toEqual({ d: 'Search', keys: [{ k: '/' }] });
    expect(admin.find((s) => s.d === 'Manage mail servers')?.keys).toEqual([{ k: '⇧' }, { k: 'M' }]);
    expect(user.find((s) => s.d === 'Manage mail servers')).toBeUndefined();
    expect(admin.at(-1)).toEqual({ d: 'Close menu or dialog', keys: [{ k: 'Esc' }] });
  });

  it('groups the shortcuts for the page, without administrator rights without ⇧M', () => {
    const admin = shortcutGroups(true);
    expect(admin.map((g) => [g.label, g.icon, g.sec, g.items.length])).toEqual([
      ['General', 'ti-keyboard', 'sc0', 6],
      ['Navigation', 'ti-compass', 'sc1', 8],
      ['Message list', 'ti-list', 'sc2', 2],
      ['Reading messages', 'ti-mail-opened', 'sc3', 5],
    ]);
    // All 21 shortcuts of the popup, none twice.
    expect(admin.flatMap((g) => g.items.map((s) => s.d)).sort()).toEqual(
      shortcutsFor(true)
        .map((s) => s.d)
        .sort(),
    );
    expect(admin[0]!.items.map((s) => s.d)).toEqual([
      'Search',
      'Open command palette',
      'New email',
      'Open settings',
      'Show keyboard shortcuts',
      'Close menu or dialog',
    ]);
    // Without administrator rights Navigation has 7 entries.
    const nav = shortcutGroups(false)[1]!;
    expect(nav.items).toHaveLength(7);
    expect(nav.items.find((s) => s.d === 'Manage mail servers')).toBeUndefined();
  });

  it('scrolls to the groups via the tabs of the page', () => {
    const scrollTo = vi.fn();
    const tabs = shortcutTabs(scrollTo);
    expect(tabs.map((t) => t.label)).toEqual(['General', 'Navigation', 'Message list', 'Reading messages']);
    tabs.forEach((t) => t.onClick());
    expect(scrollTo.mock.calls.flat()).toEqual(['sc0', 'sc1', 'sc2', 'sc3']);
  });

  it('shows the modifier key per system: ⌘ on macOS, iOS and iPadOS, otherwise Ctrl', () => {
    // First `userAgentData.platform`, otherwise `navigator.platform`.
    expect(modKey({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' })).toBe('⌘');
    expect(modKey({ userAgentData: { platform: 'iOS' } })).toBe('⌘');
    expect(modKey({ userAgentData: { platform: 'Windows' }, platform: 'MacIntel' })).toBe('Ctrl');
    expect(modKey({ userAgentData: { platform: 'Chrome OS' } })).toBe('Ctrl');
    expect(modKey({ userAgentData: { platform: '' }, platform: 'iPhone' })).toBe('⌘');
    // iPadOS with a keyboard reports "MacIntel"; Android reports "Linux …".
    for (const platform of ['MacIntel', 'Macintosh', 'iPad', 'iPhone', 'iPod touch']) {
      expect(isApple({ platform })).toBe(true);
    }
    for (const platform of ['Win32', 'Linux x86_64', 'Linux armv81', '']) expect(isApple({ platform })).toBe(false);
    expect(isApple({})).toBe(false);
    const throwing = Object.defineProperty({}, 'platform', {
      get() {
        throw new Error('blocked');
      },
    }) as PlatformInfo;
    expect(modKey(throwing)).toBe('Ctrl');

    const palette = () => shortcutsFor(false).find((s) => s.d === 'Open command palette')?.keys;
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    expect(palette()).toEqual([{ k: '⌘' }, { k: 'K' }]);
    vi.stubGlobal('navigator', { platform: 'Win32' });
    expect(palette()).toEqual([{ k: 'Ctrl' }, { k: 'K' }]);
  });

  it('maps keys to commands', () => {
    expect(keyCommand(key('k', { metaKey: true }), CTX)).toBe('togglePalette');
    expect(keyCommand(key('K', { ctrlKey: true }), CTX)).toBe('togglePalette');
    expect(keyCommand(key('/'), CTX)).toBe('search');
    expect(keyCommand(key('['), CTX)).toBe('sidebar');
    expect(keyCommand(key(','), CTX)).toBe('settings');
    expect(keyCommand(key('?', { shiftKey: true }), CTX)).toBe('help');
    expect(keyCommand(key('M', { shiftKey: true }), CTX)).toBe('mailservers');
    expect(keyCommand(key('c'), CTX)).toBe('compose');
    expect(keyCommand(key('Escape'), CTX)).toBe('escape');
    // Other characters open the palette with that character, 1–6 the mailboxes in the order of FOLDERS.
    expect(keyCommand(key('x'), CTX)).toEqual({ palette: 'x' });
    expect(keyCommand(key('1'), CTX)).toEqual({ role: 'inbox' });
    expect(keyCommand(key('4'), CTX)).toEqual({ role: 'scheduled' });
    expect(keyCommand(key('6'), CTX)).toEqual({ role: 'spam' });
    expect(keyCommand(key('7'), CTX)).toEqual({ palette: '7' });
    // Held key: no mailbox per repeat.
    expect(keyCommand(key('1', { repeat: true }), CTX)).toBeNull();
    expect(keyCommand(key('1', {}, document.createElement('input')), CTX)).toBeNull();
    expect(keyCommand(key('1'), { ...CTX, keys: false })).toBeNull();
    expect(keyCommand(key('x', { repeat: true }), CTX)).toBeNull();
    expect(keyCommand(key('ArrowDown'), CTX)).toBeNull();
  });

  it('knows ⇧M only for administrators, without effect for users', () => {
    expect(keyCommand(key('M', { shiftKey: true }), { ...CTX, isAdmin: false })).toBeNull();
    expect(keyCommand(key('m'), { ...CTX, isAdmin: false })).toEqual({ palette: 'm' });
  });

  it('takes "[" also via AltGr or Option (German keyboard)', () => {
    expect(keyCommand(key('[', { ctrlKey: true, altKey: true }), CTX)).toBe('sidebar');
    expect(keyCommand(key('[', { altKey: true }), CTX)).toBe('sidebar');
    const altGr = { getModifierState: (k: string) => k === 'AltGraph' };
    expect(keyCommand(key('[', altGr), CTX)).toBe('sidebar');
    // Other characters with Alt or AltGr (e.g. "@") do not open the palette.
    expect(keyCommand(key('@', { ctrlKey: true, altKey: true }), CTX)).toBeNull();
    expect(keyCommand(key('[', { ctrlKey: true }), CTX)).toBeNull();
  });

  it('leaves input fields, open dialogs and disabled shortcuts alone', () => {
    const input = document.createElement('input');
    expect(keyCommand(key('c', {}, input), CTX)).toBeNull();
    expect(keyCommand(key('Escape', {}, input), CTX)).toBe('escape');
    expect(keyCommand(key('k', { ctrlKey: true }, input), CTX)).toBe('togglePalette');
    expect(keyCommand(key('c', { altKey: true }), CTX)).toBeNull();
    expect(keyCommand(key('c'), { ...CTX, dialog: true })).toBeNull();
    expect(keyCommand(key('c'), { ...CTX, keys: false })).toBeNull();
    expect(keyCommand(key('k', { metaKey: true }), { ...CTX, keys: false })).toBe('togglePalette');
  });

  it('knows only Escape in a confirmation and on mobile', () => {
    expect(keyCommand(key('k', { metaKey: true }), { ...CTX, confirm: true })).toBeNull();
    expect(keyCommand(key('Escape'), { ...CTX, confirm: true })).toBe('escape');
    expect(keyCommand(key('?'), { ...CTX, isMobile: true })).toBeNull();
    expect(keyCommand(key('Escape'), { ...CTX, isMobile: true })).toBe('escape');
  });

  it('opens the reply with R or F in the reading view with reply bar (`rn.r`)', () => {
    const reply = { ...CTX, reader: true, reply: true };
    expect(keyCommand(key('r'), reply)).toBe('reply');
    expect(keyCommand(key('R', { shiftKey: true }), reply)).toBe('reply');
    expect(keyCommand(key('f'), reply)).toBe('forward');
    expect(keyCommand(key('r', { repeat: true }), reply)).toBeNull();
    // Without a reply bar (Drafts, Scheduled, Trash) and outside the reading view the palette.
    expect(keyCommand(key('r'), { ...CTX, reader: true })).toEqual({ palette: 'r' });
    expect(keyCommand(key('f'), CTX)).toEqual({ palette: 'f' });
    expect(keyCommand(key('r', {}, document.createElement('textarea')), reply)).toBeNull();
    expect(keyCommand(key('r'), { ...reply, isMobile: true })).toBeNull();
  });

  it('pages with J/K and ←/→ in the reading view, otherwise J opens the palette (`rdNav`)', () => {
    const reader = { ...CTX, reader: true };
    expect(keyCommand(key('j'), reader)).toBe('next');
    expect(keyCommand(key('ArrowRight'), reader)).toBe('next');
    expect(keyCommand(key('k'), reader)).toBe('prev');
    expect(keyCommand(key('J', { shiftKey: true }), reader)).toBe('next');
    expect(keyCommand(key('K'), reader)).toBe('prev');
    expect(keyCommand(key('ArrowLeft'), reader)).toBe('prev');
    expect(keyCommand(key('j'), CTX)).toEqual({ palette: 'j' });
    expect(keyCommand(key('ArrowLeft'), CTX)).toBeNull();
    expect(keyCommand(key('j', {}, document.createElement('input')), reader)).toBeNull();
    expect(keyCommand(key('j'), { ...reader, dialog: true })).toBeNull();
    expect(keyCommand(key('j'), { ...reader, isMobile: true })).toBeNull();
  });

  it('knows only Escape and ⌘K/Ctrl+K in compose (`cmp`)', () => {
    const cmp = { ...CTX, compose: true };
    expect(keyCommand(key('Escape'), cmp)).toBe('escape');
    expect(keyCommand(key('Escape', {}, document.createElement('textarea')), cmp)).toBe('escape');
    expect(keyCommand(key('k', { metaKey: true }), cmp)).toBe('togglePalette');
    expect(keyCommand(key('K', { ctrlKey: true }), cmp)).toBe('togglePalette');
    for (const k of ['/', '[', ',', '?', 'c', 'C', '1', '6', 'x', 'j', 'r', 'ArrowDown', 'Enter']) {
      expect(keyCommand(key(k), cmp)).toBeNull();
    }
    expect(keyCommand(key('M', { shiftKey: true }), cmp)).toBeNull();
    expect(keyCommand(key('[', { altKey: true }), cmp)).toBeNull();
    // ⌘/Ctrl+Enter stays with the field.
    expect(keyCommand(key('Enter', { metaKey: true }, document.createElement('textarea')), cmp)).toBeNull();
    expect(keyCommand(key('Enter', { ctrlKey: true }), cmp)).toBeNull();
  });

  it('takes J/K, R/F and C also in upper case (Caps Lock, Shift)', () => {
    const reply = { ...CTX, reader: true, reply: true };
    expect(keyCommand(key('J'), reply)).toBe('next');
    expect(keyCommand(key('K', { shiftKey: true }), reply)).toBe('prev');
    expect(keyCommand(key('R'), reply)).toBe('reply');
    expect(keyCommand(key('F', { shiftKey: true }), reply)).toBe('forward');
    expect(keyCommand(key('C', { shiftKey: true }), CTX)).toBe('compose');
  });

  it('ignores every shortcut on a select list and in editable content, Escape still applies', () => {
    const select = document.createElement('select');
    const editableDiv = document.createElement('div');
    editableDiv.contentEditable = 'true';
    // jsdom has no `isContentEditable`.
    Object.defineProperty(editableDiv, 'isContentEditable', { value: true });
    for (const target of [select, editableDiv]) {
      for (const k of ['/', '[', ',', '?', 'c', '1', 'x']) expect(keyCommand(key(k, {}, target), CTX)).toBeNull();
      expect(keyCommand(key('j', {}, target), { ...CTX, reader: true })).toBeNull();
      expect(keyCommand(key('Escape', {}, target), CTX)).toBe('escape');
    }
  });

  it('pages with held J/K and ←/→, but not R/F, 1–6 and the palette (`repeat`)', () => {
    const reply = { ...CTX, reader: true, reply: true };
    expect(keyCommand(key('j', { repeat: true }), reply)).toBe('next');
    expect(keyCommand(key('ArrowLeft', { repeat: true }), reply)).toBe('prev');
    expect(keyCommand(key('r', { repeat: true }), reply)).toBeNull();
    expect(keyCommand(key('f', { repeat: true }), reply)).toBeNull();
    for (const k of ['1', '3', '6']) expect(keyCommand(key(k, { repeat: true }), CTX)).toBeNull();
    expect(keyCommand(key('x', { repeat: true }), CTX)).toBeNull();
  });

  it('closes the reading view with Escape except from input fields and text areas', () => {
    const editableDiv = document.createElement('div');
    Object.defineProperty(editableDiv, 'isContentEditable', { value: true });
    expect(textField(document.createElement('input'))).toBe(true);
    expect(textField(document.createElement('textarea'))).toBe(true);
    expect(textField(document.createElement('select'))).toBe(false);
    expect(textField(editableDiv)).toBe(false);
    expect(textField(document.body)).toBe(false);
    expect(textField(null)).toBe(false);
  });

  it('selects a row with ↑/↓ in the list and opens it with Enter, not on buttons and links (`pfNav`)', () => {
    const list = { ...CTX, list: true };
    expect(keyCommand(key('ArrowDown'), list)).toBe('down');
    expect(keyCommand(key('ArrowUp'), list)).toBe('up');
    expect(keyCommand(key('Enter'), list)).toBe('open');
    const button = document.createElement('button');
    button.append(document.createElement('span'));
    expect(keyCommand(key('Enter', {}, button.firstChild), list)).toBeNull();
    expect(keyCommand(key('Enter', {}, document.createElement('a')), list)).toBeNull();
    expect(keyCommand(key('ArrowDown'), CTX)).toBeNull();
    expect(keyCommand(key('Enter'), CTX)).toBeNull();
    expect(keyCommand(key('ArrowDown'), { ...list, keys: false })).toBeNull();
    expect(keyCommand(key('ArrowDown'), { ...list, isMobile: true })).toBeNull();
  });
});
