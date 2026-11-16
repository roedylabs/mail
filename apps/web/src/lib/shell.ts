/**
 * Values of the shell components: prop types and the derivations
 * for the header, sidebar, folder tree, banners and pop-ups. Not in the
 * components so that tests and layout can import them type-checked.
 */
import type { LangChoice } from '#lib/language.ts';
import { MA_COLORS } from '@roedy/tokens';
import type { Snippet } from 'svelte';
import { isIconName, type IconName } from '#lib/icons.ts';
import type { KeyInput } from '#lib/keys.ts';
import { linkHref, urlOk } from '#lib/links.ts';
import type { LogoValues } from '#lib/logo.ts';
import type { FolderNode } from '#lib/state/mailboxes.svelte.ts';
import type { PublicBanner } from '#lib/state/session.svelte.ts';
import type { TagNode } from '#lib/state/tags.svelte.ts';
import type { ToastSwipe } from '#lib/swipe.ts';

// --- Header ---

export interface FilterButton {
  aria: string;
  exp: boolean;
  /** Search suggestions open in filter mode (`fOpen`): background `--accsoft`. */
  fill: boolean;
  hasN: boolean;
  n: string;
}

export interface HeaderValues {
  isMobile: boolean;
  appName: string;
  logo: LogoValues;
  sbToggleOn: boolean;
  hdrQ: string;
  hdrHasQ: boolean;
  searchPlaceholder: string;
  resOpen: boolean;
  resExp: boolean;
  sfBtn: FilterButton;
  bellBadge: boolean;
  bellBadgeN: string;
  bellLabel: string;
  bellOpen: boolean;
  appsOpen: boolean;
  accountOpen: boolean;
  userName: string;
  initials: string;
  /** Offer administration (only for administrators) and currently open. */
  showAdmin: boolean;
  adminOn: boolean;
  /** Settings currently open. */
  settingsOn: boolean;
}

export interface HeaderActions {
  toggleSidebar?: () => void;
  goHome?: () => void;
  onSearch?: (event: Event & { currentTarget: HTMLInputElement }) => void;
  onSearchKey?: (event: KeyboardEvent) => void;
  onSearchFocus?: () => void;
  clearSearch?: () => void;
  /** "All results" of the search suggestions: open the results for the search text. */
  openResults?: () => void;
  /** Focus has left the search field and suggestions: close the suggestions. */
  closeSuggestions?: () => void;
  toggleSf?: () => void;
  toggleBell?: () => void;
  openAdmin?: () => void;
  openSettingsBtn?: () => void;
  toggleApps?: () => void;
  toggleAccount?: () => void;
  openBellSheet?: () => void;
  openAccountSheet?: () => void;
}

// --- Sidebar ---

export type SidebarTab = 'mail' | 'folders' | 'tags';

export interface SidebarRow {
  id: string;
  label: string;
  icon: IconName;
  on: boolean;
  /** Font weight (`fw`): 800 selected, otherwise 600. */
  fw: number;
  shadow: string;
  hasCnt: boolean;
  cntU: string;
  cntN: string;
  cntLabel: string;
  tip: string | undefined;
  onClick: () => void;
}

export interface AccountSwitch {
  /** "All accounts", the address of the account or "Add email account" (on mobile in the mailboxes sheet). */
  email: string;
  isAll: boolean;
  letter: string;
  open: boolean;
  sub: string;
  tip: string | undefined;
  title: string;
  warn: boolean;
  /** Colours of the tile (`MA_COLORS` of the account or "Add"). */
  tileBg: string;
  tileInk: string;
}

export interface AccountTile {
  letter: string;
  bg: string;
  ink: string;
}

// --- Account switcher and mailboxes on mobile ---

/** Account in the account switcher. */
export interface SwitcherAccount {
  id: string;
  email: string;
  letter: string;
  tileBg: string;
  tileInk: string;
  /** "Sign-in required" (`needs_reauth`); on mobile otherwise the host (`ok`). */
  warn: boolean;
  host: string;
  /** Account of the sidebar (check mark). */
  checked: boolean;
  /** Default account (badge "Default", mobile only). */
  isDef: boolean;
  onClick: () => void;
}

export interface AccountSwitcherValues {
  isMobile: boolean;
  /** "All accounts": only with more than one account; `n` is the count shown as "‹n› mailboxes". */
  acctAll: { show: boolean; checked: boolean; n: string; onClick: () => void };
  /** Tiles of "All accounts": on the desktop the first three, on mobile up to four. */
  allTiles: AccountTile[];
  acctList: SwitcherAccount[];
  addMailAcct: () => void;
  manageMailAccts: () => void;
  /** Mobile: back to the sheet "Mailboxes". */
  closeSw: () => void;
}

export interface MailboxMenuValues {
  /** Mailboxes of the account or of "All accounts" without counters. */
  mFolderRows: NavItem[];
  /** Tab of the sheet, the same as in the sidebar. */
  sbTab: SidebarTab;
  /** Active folder in the tree (dot on the tab "Folders"). */
  inFolder: boolean;
  inTag: boolean;
  acctSw: AccountSwitch;
  allT2: AccountTile[];
  addFShow: boolean;
  onTab: (tab: SidebarTab) => void;
  /** "New folder" and "New tag". */
  addF?: () => void;
  addT?: () => void;
  /** Opens "Switch account" above the sheet or, without an account, "Add email account". */
  toggleMSw: () => void;
  closeSheet: () => void;
}

export interface RailTab {
  key: SidebarTab;
  label: string;
  icon: IconName;
  on: boolean;
  gap: string;
  tip: string | undefined;
}

export interface RailPanel {
  hidden: boolean;
  vis: 'visible' | 'hidden';
  visDelay: string;
}

/** Values the sidebar derives from its inputs (`folderVals()` and `renderVals()` of the shell). */
export interface SidebarDerived {
  labelOp: number;
  cmpTip: string | undefined;
  addFTip: string | undefined;
  addTTip: string | undefined;
  sbVis: 'visible' | 'hidden';
  sbVisDelay: string;
  rtTabs: RailTab[];
  rtCols: string;
  rtG: string | undefined;
  rtPm: RailPanel;
  rtPf: RailPanel;
  rtPt: RailPanel;
}

export interface SidebarInput {
  /** Labels visible (expanded). */
  wide: boolean;
  /** Hidden without a mail account or on the search results page (`rp || noAcctV`). */
  hidden: boolean;
  sbTab: SidebarTab;
  /** Active view lies in a folder or tag (dot on the tab). */
  inFolder?: boolean;
  inTag?: boolean;
  navRows: SidebarRow[];
  acctSw: AccountSwitch;
  acctSwOpen: boolean;
  allT2: AccountTile[];
  addFShow: boolean;
}

const RT = [
  ['mail', 'ti-inbox'],
  ['folders', 'ti-folders'],
  ['tags', 'ti-tags'],
] as const satisfies readonly (readonly [SidebarTab, IconName])[];

export function sidebarDerived(
  input: Pick<SidebarInput, 'wide' | 'hidden' | 'sbTab'>,
  labels: Record<SidebarTab, string>,
  texts: { compose: string; folder: string; tag: string },
): SidebarDerived {
  const { wide, hidden, sbTab } = input;
  const index = Math.max(
    0,
    RT.findIndex(([key]) => key === sbTab),
  );
  const panel = (i: number): RailPanel =>
    i === index
      ? { hidden: false, vis: 'visible', visDelay: '0s' }
      : { hidden: true, vis: 'hidden', visDelay: 'calc(var(--dur, 220ms) * 1.4)' };
  return {
    labelOp: wide ? 1 : 0,
    cmpTip: wide ? undefined : texts.compose,
    addFTip: wide ? undefined : texts.folder,
    addTTip: wide ? undefined : texts.tag,
    sbVis: hidden ? 'hidden' : 'visible',
    sbVisDelay: hidden ? 'calc(var(--dur, 220ms) * 1.4)' : '0s',
    rtTabs: RT.map(([key, icon]) => {
      const on = key === sbTab;
      const label = labels[key];
      return { key, label, icon, on, gap: on && wide ? '7px' : '0px', tip: on && wide ? undefined : label };
    }),
    rtCols: wide ? RT.map(([key]) => (key === sbTab ? 'minmax(0,4fr)' : 'minmax(0,1fr)')).join(' ') : 'minmax(0,1fr)',
    rtG: wide ? '1' : undefined,
    rtPm: panel(0),
    rtPf: panel(1),
    rtPt: panel(2),
  };
}

// --- Tab bar and navigation "More" ---

/** Entry of the tab bar (`mTabsL`, `mTabsR`) and of the menu "Mehr" (`mExtraRows`). */
export interface NavItem {
  label: string;
  icon: IconName;
  /** Font weight (`fw`): 800 selected, otherwise 600. */
  fw: number;
  on: boolean;
  onClick: () => void;
}

/** Font weight of selected and other entries (`fw` in `row()`, `mtab()`, `mrow()`). */
export const fontWeight = (on: boolean): number => (on ? 800 : 600);

/** Entry like `mtab()` or `mrow()` of the shell. */
export function navItem(label: string, icon: IconName, on: boolean, onClick: () => void): NavItem {
  return { label, icon, fw: fontWeight(on), on, onClick };
}

export interface TabBarValues {
  mTabsL: NavItem[];
  mTabsR: NavItem[];
}

export interface NavMenuValues {
  mNavTitle: string;
  mExtraRows: NavItem[];
  closeSheet: () => void;
}

// --- Folder tree ---

/** Header of an account in "All accounts" (collapsible). */
export interface FolderHeadRow {
  key: string;
  head: true;
  add: false;
  row: false;
  letter: string;
  /** Colours of the tile (`MA_COLORS` of the account). */
  aBg: string;
  aInk: string;
  email: string;
  /** Top spacing: 10px from the second row on. */
  mt: string;
  chevT: string;
  expanded: boolean;
  tip: string | undefined;
  toggle: () => void;
}

/** Row "New folder" below an account in "All accounts". */
export interface FolderAddRow {
  key: string;
  head: false;
  add: true;
  row: false;
  h: string;
  rr: string;
  fs: string;
  tip: string | undefined;
  onClick: () => void;
}

/** Vertical line of an ancestor that has further siblings. */
export interface FolderLine {
  x: string;
}

/**
 * Common part of a row in folder tree and tag list. From `sel` and `inside`
 * follow colour, tile and rotation, from `sub` the corners of the tile, from
 * `first` the arc; background and height depend on `mob` and stay values.
 */
export interface TreeItemRow extends ReturnType<typeof treeRow> {
  /** Subfolder or subtag (depth > 0). */
  sub: boolean;
  label: string;
  /** Badge of the tile with children: plus to expand, minus to collapse. */
  bIcon: IconName;
  kids: boolean;
  /** Active entry. */
  sel: boolean;
  /** Collapsed ancestor of the active entry. */
  inside: boolean;
  first: boolean;
  /** Further siblings follow: line to the end of the row. */
  cont: boolean;
  fw: number;
  hasCnt: boolean;
  cntU: string;
  cntN: string;
  cntLabel: string;
  isz: string;
  lines: FolderLine[];
  tileExp: boolean | undefined;
  tileLabel: string;
  tileTip: string | undefined;
  tip: string | undefined;
  tileClick: () => void;
  onClick: () => void;
}

/** Folder row; the tile colour follows from `sel`, `dotOp` from `dot`. */
export interface FolderItemRow extends TreeItemRow {
  /** `<account>/<folder>`. */
  key: string;
  head: false;
  add: false;
  row: true;
  icon: IconName;
  /** Dot on the tile: collapsed and unread conversations. */
  dot: boolean;
}

export type FolderRow = FolderHeadRow | FolderAddRow | FolderItemRow;

export interface FolderTreeValues {
  fRows: FolderRow[];
  fNone: boolean;
  /** Opacity of the labels: 1 when expanded or on mobile, otherwise 0. */
  ftLblOp: number;
  /** Active folder is in the tree (dot on the tab "Folders"). */
  inFolder: boolean;
}

export interface FolderTreeAccount {
  id: string;
  email: string;
  letter: string;
  bg: string;
  ink: string;
  tree: FolderNode[];
}

export interface FolderTreeInput {
  /** One account, all in "All accounts". */
  accounts: FolderTreeAccount[];
  /** Headers per account and row "New folder in …". */
  allMode: boolean;
  /** Labels visible (`wide || mob`). */
  full: boolean;
  mob: boolean;
  /** Active folder, otherwise null. */
  active: { account: string; folder: string } | null;
  isOpen: (account: string, id: string) => boolean;
  toggle: (account: string, id: string) => void;
  /** Account in "All accounts" expanded (collapsed by default). */
  isAccountOpen: (account: string) => boolean;
  toggleAccount: (account: string) => void;
  select: (account: string, id: string) => void;
  /** "New folder in …". */
  addFolder?: (account: string) => void;
}

/** Texts of the folder tree (`folders_*`, `mailbox_count`) so that shell.ts stays without Paraglide. */
export interface FolderTreeTexts {
  expand: string;
  collapse: string;
  newIn: (email: string) => string;
  count: (unread: number, total: number) => string;
}

/** Left edge of the line below a tile of depth `d` (`gx`). */
const treeX = (d: number): number => 24 + 23 * d;

/** Sizes and background of a row of depth `d` in folder tree and tag list (`sty()` and sizes of the shell). */
function treeRow(d: number, mob: boolean, sel: boolean) {
  const selBg = mob ? 'var(--accsoft)' : 'var(--surface)';
  return {
    h: mob
      ? d
        ? 'var(--rowh, 46px)'
        : 'calc(var(--rowh, 46px) + 6px)'
      : d
        ? 'calc(var(--rowh, 46px) - 8px)'
        : 'var(--rowh, 46px)',
    bl: d ? `${treeX(d - 1) + 11}px` : '0px',
    pl: d ? '0px' : '7px',
    gap: d ? '9px' : '13px',
    tw: d ? '24px' : '34px',
    fs: mob ? (d ? '14.5px' : '15.5px') : d ? '14px' : '15px',
    rr: mob ? (d ? '15px' : '18px') : d ? '13px' : '17px',
    ex: `${d ? treeX(d - 1) : 0}px`,
    bg: sel ? selBg : 'transparent',
    sh: sel && !mob ? 'var(--sh1)' : 'none',
    hoverBg: sel ? selBg : 'var(--hov)',
  };
}

/** IDs from the top node to the node `id`; empty if it is not in the tree. */
function pathTo<T extends { id: string; children: readonly T[] }>(tree: readonly T[], id: string | null): string[] {
  if (id === null) return [];
  for (const node of tree) {
    if (node.id === id) return [node.id];
    const below = pathTo(node.children, id);
    if (below.length) return [node.id, ...below];
  }
  return [];
}

/** Keys `<account>/<folder>` from the top folder to the active one; empty if it is not in the tree. */
function activePath(accounts: readonly FolderTreeAccount[], active: FolderTreeInput['active']): string[] {
  const account = active && accounts.find((a) => a.id === active.account);
  if (!active || !account) return [];
  return pathTo(account.tree, active.folder).map((id) => `${account.id}/${id}`);
}

/**
 * Rows of the folder tree like `folderVals()` (`fRows`, `fNone`, `ftLblOp`):
 * folders with indentation and lines, subfolders only when expanded (`full`)
 * and opened; the tile then opens and closes, otherwise it selects the folder.
 * In "All accounts" a header and "New folder" per account.
 */
export function folderRows(input: FolderTreeInput, texts: FolderTreeTexts): FolderTreeValues {
  const { accounts, allMode, full, mob, active } = input;
  const path = new Set(activePath(accounts, active));
  const rows: FolderRow[] = [];
  for (const a of accounts) {
    const closed = allMode && !input.isAccountOpen(a.id);
    if (allMode)
      rows.push({
        key: `head:${a.id}`,
        head: true,
        add: false,
        row: false,
        letter: a.letter,
        aBg: a.bg,
        aInk: a.ink,
        email: a.email,
        mt: rows.length ? '10px' : '0px',
        chevT: closed ? 'rotate(-90deg)' : 'none',
        expanded: !closed,
        tip: full ? undefined : a.email,
        toggle: () => input.toggleAccount(a.id),
      });
    if (closed) continue;
    const walk = (list: readonly FolderNode[], d: number, lines: readonly number[]): void =>
      list.forEach((f, i) => {
        const key = `${a.id}/${f.id}`;
        const kids = f.children.length > 0;
        const sel = active?.account === a.id && active.folder === f.id;
        const last = i === list.length - 1;
        const open = kids && input.isOpen(a.id, f.id);
        // When collapsed, subfolders are never visible: the folder then counts as closed.
        const shown = open && full;
        const inside = !sel && !shown && path.has(key);
        const toggles = kids && full;
        const tileText = open ? texts.collapse : texts.expand;
        rows.push({
          key,
          head: false,
          add: false,
          row: true,
          sub: d > 0,
          label: f.name,
          icon: shown ? 'ti-folder-open' : 'ti-folder',
          bIcon: open ? 'ti-minus' : 'ti-plus',
          kids,
          sel,
          inside,
          first: i === 0,
          cont: d > 0 && !last,
          dot: !full && f.unread > 0,
          fw: fontWeight(sel || inside),
          hasCnt: f.total > 0,
          cntU: String(f.unread),
          cntN: String(f.total),
          cntLabel: texts.count(f.unread, f.total),
          ...treeRow(d, mob, sel),
          isz: d ? '15px' : '19px',
          lines: lines.map((x) => ({ x: `${x}px` })),
          tileExp: toggles ? open : undefined,
          tileLabel: toggles ? tileText : f.name,
          tileTip: toggles ? tileText : full ? undefined : f.name,
          tip: full ? undefined : f.name,
          tileClick: toggles ? () => input.toggle(a.id, f.id) : () => input.select(a.id, f.id),
          onClick: () => input.select(a.id, f.id),
        });
        if (open && full) walk(f.children, d + 1, d && !last ? [...lines, treeX(d - 1)] : lines);
      });
    walk(a.tree, 0, []);
    if (allMode)
      rows.push({
        key: `add:${a.id}`,
        head: false,
        add: true,
        row: false,
        h: mob ? 'calc(var(--rowh, 46px) + 6px)' : 'var(--rowh, 46px)',
        rr: mob ? '18px' : '17px',
        fs: mob ? '15px' : '14.5px',
        tip: full ? undefined : texts.newIn(a.email),
        onClick: () => input.addFolder?.(a.id),
      });
  }
  return { fRows: rows, fNone: rows.length === 0, ftLblOp: full ? 1 : 0, inFolder: path.size > 0 };
}

// --- Tag list ---

/** Tag row like `tagRows` of the shell; `tileBg`, `sdC` and `eC` follow from `sel`, `inside` and the tag's colours. */
export interface TagRow extends TreeItemRow {
  /** Tag ID. */
  key: string;
  /** Background and text in the tag's colour (`MA_COLORS`). */
  c: string;
  ink: string;
  /** `aria-pressed` of the row (`pressed`). */
  pressed: boolean;
  /** Mark of the tag fix: mailbox missing, outside of "Tags" or differing; only when expanded. */
  warn: boolean;
  /** Tooltip and aria-label of the mark. */
  warnTip: string | undefined;
}

/** Notice row "Tags abgleichen" at the end of the tag list (`tsRow`). */
export interface TagFixRow {
  /** Number of differences. */
  n: string;
  aria: string;
  /** Tooltip, only when collapsed. */
  tip: string | undefined;
  h: string;
  rr: string;
  fs: string;
  open: () => void;
}

export interface TagListValues {
  tagRows: TagRow[];
  tNone: boolean;
  /** Opacity of the labels: 1 when expanded or on mobile, otherwise 0. */
  ftLblOp: number;
  /** Notice row visible: at least one difference in the accounts of the view. */
  tsShow: boolean;
  tsRow: TagFixRow;
}

export interface TagListInput {
  tree: TagNode[];
  /** Labels visible (`wide || mob`). */
  full: boolean;
  mob: boolean;
  /** Active tag, otherwise null. */
  active: string | null;
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  select: (id: string) => void;
  /** Tags with a difference (`missing`, `outside`, `renamed`) → email addresses of the affected accounts. */
  warnings: Readonly<Record<string, readonly string[]>>;
  /** Number of differences in the accounts of the view. */
  fixes: number;
  openFix: () => void;
}

/** Texts of the tag list (`tags_*`, `tagfix_*`, `mailbox_count`) so that shell.ts stays without Paraglide. */
export interface TagListTexts {
  expand: string;
  collapse: string;
  count: (unread: number, total: number) => string;
  /** Mark: one account or several. */
  warnOne: (email: string) => string;
  warnMany: (count: number) => string;
  fix: string;
  fixAria: (count: number) => string;
}

/**
 * Rows of the tag list like `tagRows` of the shell (`tagRows`, `tNone`): tags
 * with colour, indentation and lines, subtags only when expanded (`full`) and
 * opened; the tile then opens and closes, otherwise it selects the tag.
 */
export function tagRows(input: TagListInput, texts: TagListTexts): TagListValues {
  const { full, mob, active } = input;
  const path = new Set(pathTo(input.tree, active));
  const rows: TagRow[] = [];
  const walk = (list: readonly TagNode[], d: number, lines: readonly number[]): void =>
    list.forEach((t, i) => {
      const kids = t.children.length > 0;
      const sel = active === t.id;
      const last = i === list.length - 1;
      const open = kids && input.isOpen(t.id);
      // When collapsed, subtags are never visible: the tag then counts as closed (like in the folder tree).
      const shown = open && full;
      const inside = !sel && !shown && path.has(t.id);
      const toggles = kids && full;
      const tileText = open ? texts.collapse : texts.expand;
      const [, c, ink] = MA_COLORS[t.color] ?? MA_COLORS[0];
      // No mark when collapsed; a collapsed parent tag does not inherit it.
      const warned = full ? (input.warnings[t.id] ?? []) : [];
      rows.push({
        key: t.id,
        sub: d > 0,
        label: t.name,
        c,
        ink,
        bIcon: open ? 'ti-minus' : 'ti-plus',
        kids,
        sel,
        inside,
        first: i === 0,
        cont: d > 0 && !last,
        pressed: sel,
        warn: warned.length > 0,
        warnTip: warned.length > 1 ? texts.warnMany(warned.length) : warned[0] && texts.warnOne(warned[0]),
        fw: fontWeight(sel || inside),
        hasCnt: t.total > 0,
        cntU: String(t.unread),
        cntN: String(t.total),
        cntLabel: texts.count(t.unread, t.total),
        ...treeRow(d, mob, sel),
        isz: d ? '15px' : '18px',
        lines: lines.map((x) => ({ x: `${x}px` })),
        tileExp: toggles ? open : undefined,
        tileLabel: toggles ? tileText : t.name,
        tileTip: toggles ? tileText : full ? undefined : t.name,
        tip: full ? undefined : t.name,
        tileClick: toggles ? () => input.toggle(t.id) : () => input.select(t.id),
        onClick: () => input.select(t.id),
      });
      if (shown) walk(t.children, d + 1, d && !last ? [...lines, treeX(d - 1)] : lines);
    });
  walk(input.tree, 0, []);
  const n = input.fixes;
  return {
    tagRows: rows,
    tNone: rows.length === 0,
    ftLblOp: full ? 1 : 0,
    tsShow: n > 0,
    tsRow: {
      n: String(n),
      aria: texts.fixAria(n),
      tip: full ? undefined : texts.fix,
      h: mob ? 'calc(var(--rowh, 46px) + 6px)' : 'var(--rowh, 46px)',
      rr: mob ? '18px' : '17px',
      fs: mob ? '15px' : '14.5px',
      open: input.openFix,
    },
  };
}

// --- Splash screen ---

export interface SplashValues {
  appName: string;
  logo: LogoValues;
  /** `on` visible, `out` fades out (`splashOp`, `splashT`). */
  splash: 'on' | 'out';
}

// --- Sync pill ---

export interface SyncPillValues {
  isMobile: boolean;
  syncText: string;
  /** Account or number of accounts (desktop only). */
  syncSub: string;
}

// --- Skeleton ---

export type SkeletonKind = 'pfA' | 'pfB' | 'rd' | 'home' | 'srch' | 'set';
export type SkeletonSet = 'ueb' | 'list';

interface Row {
  a: string;
  b: string;
  d: string;
  sep: boolean;
}

interface Para {
  w: string;
  mb: string;
  d: string;
}

export interface SkeletonValues {
  skPf: boolean;
  skPfA: boolean;
  skPfB: boolean;
  skRd: boolean;
  skHome: boolean;
  skSrch: boolean;
  skSet: boolean;
  skSetUeb: boolean;
  skSetList: boolean;
  skRows: Row[];
  skRows3: Row[];
  skParas: Para[];
}

/** Widths of the rows in percent. */
const SKW = [
  [38, 62],
  [30, 74],
  [44, 56],
  [34, 68],
  [40, 60],
  [28, 70],
  [36, 64],
] as const;

const PARAS = [
  ['96%', 0],
  ['90%', 0],
  ['94%', 0],
  ['58%', 14],
  ['92%', 0],
  ['86%', 0],
  ['70%', 14],
  ['30%', 0],
] as const;

export function skeletonValues(kind: SkeletonKind, set: SkeletonSet = 'list'): SkeletonValues {
  return {
    skPf: kind === 'pfA' || kind === 'pfB',
    skPfA: kind === 'pfA',
    skPfB: kind === 'pfB',
    skRd: kind === 'rd',
    skHome: kind === 'home',
    skSrch: kind === 'srch',
    skSet: kind === 'set',
    skSetUeb: kind === 'set' && set === 'ueb',
    skSetList: kind === 'set' && set === 'list',
    skRows: SKW.map(([a, b], i) => ({ a: `${a}%`, b: `${b}%`, d: `${i * 110}ms`, sep: i > 0 })),
    skRows3: SKW.slice(0, 3).map(([a, b], i) => ({ a: `${a + 10}%`, b: `${b}%`, d: `${i * 140}ms`, sep: i > 0 })),
    skParas: PARAS.map(([w, mb], i) => ({ w, mb: `${mb}px`, d: `${i * 90}ms` })),
  };
}

// --- Toast ---

export interface ToastValues {
  isMobile: boolean;
  /** On mobile in the "Back to …" area without a tab bar further down. */
  isPanel: boolean;
  toastText: string;
  toastUndo: boolean;
  toastNoUndo: boolean;
  /** Error toast: ti-alert-triangle on `--danger` instead of ti-check. */
  toastErr: boolean;
  toastOk: boolean;
  /** `alert` for the error toast, otherwise `status`. */
  toastRole: 'alert' | 'status';
  /** The page has the bar "Unsaved changes": the toast sits 12 px above it. */
  toastLift?: boolean;
  /** Distance from the bottom edge with `toastLift` (e.g. `106px`), on the desktop and on mobile; measured (`#lib/toast-lift.svelte.ts`). */
  toastB?: string;
  closeToast: () => void;
  /** Swiping the toast (`#lib/swipe.ts`). */
  swipe: ToastSwipe;
}

// --- Notice bar ---

/** Colours per tone (`ANN_TONES`): background, text, description, button, button on hover. */
export const ANN_TONES = {
  accent: {
    bg: 'var(--acc)',
    ink: 'var(--accink)',
    sub: 'color-mix(in oklab, var(--accink) 78%, var(--acc))',
    actBg: 'color-mix(in oklab, var(--accink) 14%, transparent)',
    actHov: 'color-mix(in oklab, var(--accink) 24%, transparent)',
  },
  soft: {
    bg: 'var(--accsoft)',
    ink: 'var(--fg)',
    sub: 'color-mix(in oklab, var(--fg) 76%, var(--accsoft))',
    actBg: 'color-mix(in oklab, var(--fg) 9%, transparent)',
    actHov: 'color-mix(in oklab, var(--fg) 16%, transparent)',
  },
  dark: {
    bg: 'var(--ink)',
    ink: 'var(--inkfg)',
    sub: 'color-mix(in oklab, var(--inkfg) 72%, var(--ink))',
    actBg: 'color-mix(in oklab, var(--inkfg) 16%, transparent)',
    actHov: 'color-mix(in oklab, var(--inkfg) 26%, transparent)',
  },
  warning: {
    bg: 'var(--danger)',
    ink: 'var(--surface)',
    sub: 'color-mix(in oklab, var(--surface) 82%, var(--danger))',
    actBg: 'color-mix(in oklab, var(--surface) 16%, transparent)',
    actHov: 'color-mix(in oklab, var(--surface) 26%, transparent)',
  },
} as const;

export type ToneName = keyof typeof ANN_TONES;
export type BannerTone = (typeof ANN_TONES)[ToneName];

/** Colours of the banner "Offline" (dark in every theme, not a tone of the custom banner). */
const OFFLINE_TONE: BannerTone = {
  bg: 'var(--ink)',
  ink: 'var(--inkfg)',
  sub: 'color-mix(in oklab, var(--inkfg) 72%, var(--ink))',
  actBg: 'color-mix(in oklab, var(--inkfg) 16%, transparent)',
  actHov: 'color-mix(in oklab, var(--inkfg) 26%, transparent)',
};

/** Colours of a tone; unknown names as accent colour. */
export function toneOf(name: string): BannerTone {
  return Object.hasOwn(ANN_TONES, name) ? ANN_TONES[name as ToneName] : ANN_TONES.accent;
}

/** Icon of the custom banner; an unknown name falls back to a megaphone. */
export function bannerIconOf(name: string): IconName {
  return isIconName(name) ? name : 'ti-speakerphone';
}

export interface Banner {
  /** Key of the list (kind of banner). */
  id: string;
  icon: IconName;
  title: string;
  /** Title on mobile if it shows the bar's content there; otherwise `title`. */
  titleM?: string;
  text: string;
  act: string;
  hasAct: boolean;
  hasClose: boolean;
  tone: BannerTone;
  fn?: () => void;
  onClose?: () => void;
}

export interface NoticeBarValues {
  isMobile: boolean;
  banners: Banner[];
}

export interface BannerInput {
  /** Without a connection or in the offline simulation (`offline`). */
  offline: boolean;
  /** Offline with a queue: text with counter, otherwise `null`. */
  waiting: { text: string; titleM: string } | null;
  /** Per host: changes are waiting although the app is online. */
  stuck: readonly { host: string; text: string }[];
  /** Changes not accepted by the server, until closed. */
  lost: { text: string; titleM: string } | null;
  /** Notice bar "Two versions". */
  doubled: { text: string } | null;
  /** "Anzeigen": compose for a draft, otherwise drafts. */
  openDoubled: () => void;
  closeDoubled: () => void;
  retryQueue: () => void;
  closeLost: () => void;
  /** Text for "Sign-in expired" when accounts must sign in again (`stale`), otherwise `null`. */
  staleText: string | null;
  openAccounts: () => void;
  /** Offline simulation running: "End simulation". */
  offlineSimulated: boolean;
  endSimulation: () => void;
  isAdmin: boolean;
  /** Maintenance mode on (`public/config` › `maintenance.on`). */
  maintenance: boolean;
  /** Page Administration › Maintenance open: no "Manage" there. */
  onMaintenancePage: boolean;
  /** `auth/me` › `system_mail_configured` is `false` (only provided for administrators). */
  systemMailOff: boolean;
  /** Page Administration › E-Mail open: no "Set up" there. */
  onMailPage: boolean;
  /** Banner of the system mail closed until reload. */
  systemMailHidden: boolean;
  openMaintenance: () => void;
  /** "Set up": Administration › Email. */
  openSystemMail: () => void;
  hideSystemMail: () => void;
  /** Custom banner from `public/config`, `null` = switched off. */
  own: PublicBanner | null;
  /** Custom banner closed in this revision. */
  ownHidden: boolean;
  /** Open the link of the custom banner in a new tab (checked address). */
  openLink: (href: string) => void;
  /** Close the custom banner: remember the revision. */
  hideOwn: (revision: number) => void;
}

/**
 * Banners of the notice bar: maintenance mode and system emails only for
 * administrators ("Set up" leads to Administration › Email), then the custom
 * banner for everyone (closable if the administration allows it – until the
 * next change). "Offline" shows the queue, "Sign-in expired" names mail
 * accounts without access.
 */
export function bannersOf(
  input: BannerInput,
  texts: Record<
    | 'offlineTitle'
    | 'offlineText'
    | 'offlineAct'
    | 'failTitle'
    | 'retry'
    | 'draftTitle'
    | 'draftAct'
    | 'staleTitle'
    | 'staleAct'
    | 'maintTitle'
    | 'maintText'
    | 'maintAct'
    | 'mailTitle'
    | 'mailText'
    | 'mailAct'
    | 'more',
    string
  >,
): Banner[] {
  const out: Banner[] = [];
  if (input.offline) {
    out.push({
      id: 'offline',
      icon: 'ti-wifi-off',
      title: texts.offlineTitle,
      ...(input.waiting ? { titleM: input.waiting.titleM } : {}),
      text: input.waiting?.text ?? texts.offlineText,
      act: texts.offlineAct,
      hasAct: input.offlineSimulated,
      hasClose: false,
      tone: OFFLINE_TONE,
      fn: input.endSimulation,
    });
  } else {
    for (const { host, text } of input.stuck)
      out.push({
        id: `stuck:${host}`,
        icon: 'ti-cloud-off',
        title: texts.failTitle,
        text,
        act: texts.retry,
        hasAct: true,
        hasClose: false,
        tone: ANN_TONES.warning,
        fn: input.retryQueue,
      });
  }
  if (input.lost) {
    out.push({
      id: 'lost',
      icon: 'ti-alert-circle',
      title: texts.failTitle,
      titleM: input.lost.titleM,
      text: input.lost.text,
      act: '',
      hasAct: false,
      hasClose: true,
      tone: ANN_TONES.warning,
      onClose: input.closeLost,
    });
  }
  if (input.doubled) {
    out.push({
      id: 'doubled',
      icon: 'ti-file-pencil',
      title: texts.draftTitle,
      text: input.doubled.text,
      act: texts.draftAct,
      hasAct: true,
      hasClose: true,
      tone: ANN_TONES.soft,
      fn: input.openDoubled,
      onClose: input.closeDoubled,
    });
  }
  if (input.isAdmin && input.maintenance) {
    out.push({
      id: 'maintenance',
      icon: 'ti-tool',
      title: texts.maintTitle,
      text: texts.maintText,
      act: texts.maintAct,
      hasAct: !input.onMaintenancePage,
      hasClose: false,
      tone: ANN_TONES.accent,
      fn: input.openMaintenance,
    });
  }
  if (input.staleText) {
    out.push({
      id: 'stale',
      icon: 'ti-plug-connected-x',
      title: texts.staleTitle,
      text: input.staleText,
      act: texts.staleAct,
      hasAct: true,
      hasClose: false,
      tone: ANN_TONES.warning,
      fn: input.openAccounts,
    });
  }
  if (input.isAdmin && input.systemMailOff && !input.systemMailHidden) {
    out.push({
      id: 'system-mail',
      icon: 'ti-mail-off',
      title: texts.mailTitle,
      text: texts.mailText,
      act: texts.mailAct,
      hasAct: !input.onMailPage,
      hasClose: true,
      tone: ANN_TONES.soft,
      fn: input.openSystemMail,
      onClose: input.hideSystemMail,
    });
  }
  const own = input.own;
  if (own && !input.ownHidden) {
    // Like the page (`urlOk`) and the backend only `https://` with a dot in the host; it is
    // checked anyway before a tab opens.
    const href = urlOk(own.link) ? linkHref(own.link) : null;
    out.push({
      id: 'own',
      icon: bannerIconOf(own.icon),
      title: own.title,
      text: own.text,
      act: own.linkLabel || texts.more,
      hasAct: href !== null,
      hasClose: own.closable,
      tone: toneOf(own.tone),
      ...(href !== null && { fn: () => input.openLink(href) }),
      ...(own.closable && { onClose: () => input.hideOwn(own.revision) }),
    });
  }
  return out;
}

// --- Confirmation ---

export interface ConfirmDialogValues {
  isMobile: boolean;
  cf: {
    title: string;
    text: string;
    icon: IconName;
    ok: string;
    hasCancel: boolean;
    hasWord: boolean;
    word: string;
    /** Red instead of dark (`tileBg`, `okBg`). */
    danger: boolean;
    /** Word still missing (`okDis`). */
    okDis: boolean;
  };
  confirmIn: string;
  onConfirmIn: (event: Event & { currentTarget: HTMLInputElement }) => void;
  confirmKey: (event: KeyboardEvent) => void;
  confirmOk: () => void;
  confirmCancel: () => void;
  onConfirmOverlay: (event: MouseEvent) => void;
}

/** `cf` from a request (`ask()`); `ready` if the required word matches. */
export function confirmValues(
  request: {
    title: string;
    text: string;
    icon?: IconName;
    ok?: string;
    danger?: boolean;
    word?: string;
    noCancel?: boolean;
  },
  ready: boolean,
  okDefault: string,
): ConfirmDialogValues['cf'] {
  return {
    title: request.title,
    text: request.text,
    icon: request.icon ?? 'ti-help-circle',
    ok: request.ok ?? okDefault,
    hasCancel: !request.noCancel,
    hasWord: !!request.word,
    word: request.word ?? '',
    danger: !!request.danger,
    okDis: !ready,
  };
}

// --- Command palette ---

/** Command of the palette (`cmds` of the shell): group, label, icon, shortcut. */
export interface Command {
  g: string;
  label: string;
  icon: IconName;
  k?: string;
  run: () => void;
}

export interface PaletteRow {
  g: string;
  hasHdr: boolean;
  hasKey: boolean;
  icon: IconName;
  k: string;
  label: string;
  /** Marked row (`bg`, `iconBg`, `iconColor`, `tileT`). */
  sel: boolean;
  run: () => void;
  hover: () => void;
}

export interface CommandPaletteValues {
  palQ: string;
  palRows: PaletteRow[];
  palEmpty: boolean;
  onPalQ: (event: Event & { currentTarget: HTMLInputElement }) => void;
  onPalKey: (event: KeyboardEvent) => void;
  onPalOverlay: (event: MouseEvent) => void;
}

/**
 * Rows like `palRows`: filter commands by search text, with search text first
 * "‹Text› in ‹App› suchen", heading at every change of group. `run` closes the
 * palette first (`wrap`), `hover` marks the row.
 */
export function paletteRows(
  commands: readonly Command[],
  palQ: string,
  palIdx: number,
  ctx: { search: (q: string) => Command; close: () => void; select: (index: number) => void },
): PaletteRow[] {
  const q = palQ.trim();
  let list = commands;
  if (q) {
    const lower = q.toLowerCase();
    list = [ctx.search(q), ...commands.filter((c) => c.label.toLowerCase().includes(lower))];
  }
  const idx = Math.min(palIdx, Math.max(list.length - 1, 0));
  return list.map((c, i) => ({
    g: c.g,
    hasHdr: i === 0 || list[i - 1]?.g !== c.g,
    hasKey: !!c.k,
    icon: c.icon,
    k: c.k ?? '',
    label: c.label,
    sel: i === idx,
    run: () => {
      ctx.close();
      c.run();
    },
    hover: () => {
      if (palIdx !== i) ctx.select(i);
    },
  }));
}

// --- Keyboard shortcuts ---

export interface Shortcut {
  d: string;
  keys: { k: string }[];
}

export interface ShortcutsDialogValues {
  shortcuts: Shortcut[];
  closeHelp: () => void;
  onHelpOverlay: (event: MouseEvent) => void;
}

// --- Account menu and apps ---

export interface ModeSegment {
  label: string;
  icon: IconName;
  on: boolean;
  onClick: () => void;
}

export interface AccountMenuValues {
  isMobile: boolean;
  initials: string;
  userName: string;
  userEmail: string;
  modeSeg: ModeSegment[];
  /** Languages like on the page Language & region. */
  langSeg: LangChoice[];
  openAccountSettings: () => void;
  logout: () => void;
}

export interface AppsMenuValues {
  isMobile: boolean;
  logo: LogoValues;
  appSoonCal: () => void;
  appSoonCon: () => void;
  /** Desktop: close the popover (`closeMenus`), mobile: close the sheet (`closeSheet`). */
  closeMenus: () => void;
  closeSheet: () => void;
}

// --- Start page ---

export interface StartValues {
  /** Graphic above the heading (`emptyArt`, `#lib/components/EmptyArt.svelte`). */
  emptyArt: Snippet;
}

// --- No account ---

/** Spacing below the mobile card without a tab bar (`mTabPadB`, without device frame). */
export const M_TAB_PAD_B = '10px';

export interface NoAccountValues {
  /** Graphic above the heading (`emptyArt`, `#lib/components/EmptyArt.svelte`). */
  emptyArt: Snippet;
  mTabPadB: string;
  /** "Add email account". */
  addMailAcct: () => void;
}

// --- Select list ---

/** Entry of a select list (`pick.opts[]`, `mkSel` of the shell). */
export interface PickerOption {
  label: string;
  sub: string;
  hasSub: boolean;
  /** Selected value: check mark and bold font (`fw`). */
  on: boolean;
  fw: number;
  onClick: () => void;
}

/** Entry of the select list on the desktop: plus the mark. */
export interface PickOption extends PickerOption {
  /** Marked by arrow key or mouse (`hi`). */
  hi: boolean;
  hover: () => void;
}

/** What the keyboard of a select list needs (`mkSel` of the shell). */
export interface PickKeysInput {
  count: number;
  open: boolean;
  /** Disabled (nothing to choose, step running, mobile): keys do nothing. */
  disabled: boolean;
  /** Selected row with which the list opens. */
  idx: number;
  /** Marked row while the list is open. */
  hi: number;
  /** Set the mark (`null` = none, `selHi`). */
  mark: (i: number | null) => void;
  /** Open or close the list (`ui.menu`). */
  show: () => void;
  hide: () => void;
  choose: (i: number) => void;
}

/**
 * Keyboard of a select list like `mkSel` of the shell: arrow keys open and
 * mark, Enter selects, Tab closes (`keydown`); space selects only on release,
 * otherwise its click would open the list again (`keyup`).
 */
export function pickKeys(input: PickKeysInput): {
  onKey: (event: KeyInput) => void;
  onKeyUp: (event: KeyInput) => void;
} {
  const { count, open, disabled, idx, hi, mark, show, hide, choose } = input;
  return {
    onKey: (event) => {
      if (disabled) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!open) {
          show();
          mark(idx);
        } else {
          mark((hi + (event.key === 'ArrowDown' ? 1 : -1) + count) % count);
        }
      } else if (event.key === 'Enter' && open) {
        event.preventDefault();
        choose(hi);
      } else if (event.key === ' ' && open) {
        event.preventDefault();
      } else if (event.key === 'Tab' && open) {
        hide();
        mark(null);
      }
    },
    onKeyUp: (event) => {
      if (disabled || event.key !== ' ' || !open) return;
      event.preventDefault();
      choose(hi);
    },
  };
}

/** Values of the select list (on mobile in the sheet). */
export interface PickerValues {
  title: string;
  opts: PickerOption[];
}

export interface PickerListValues {
  pick: PickerValues;
  closeSheet: () => void;
}

/** What `overlayClose` needs from the event (in tests without a real `MouseEvent`). */
export type OverlayEvent = Pick<MouseEvent, 'target' | 'currentTarget' | 'preventDefault'>;

/**
 * A click on the backdrop of a dialog, not on the dialog, closes it
 * (`overlayClose`). Without `preventDefault()`, `mousedown` would take the
 * focus away again from the element that the dialog returns it to on closing.
 */
export function overlayClose(close: () => void): (event: OverlayEvent) => void {
  return (event) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    close();
  };
}
