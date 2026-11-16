/**
 * Select lists and segments of the settings pages: on the
 * desktop a popover, on mobile a list in the sheet (`ui.pick`); the
 * page remembers which list is open and which row is marked (`open`, `hi`).
 */
import { tick } from 'svelte';
import type { Action } from 'svelte/action';
import type { SegOption } from '#lib/appearance.ts';
import type { KeyInput } from '#lib/keys.ts';
import { pickKeys, type PickOption } from '#lib/shell.ts';

/** Select list; on mobile in the sheet (`ui.pick`). */
export interface SelectValues {
  title: string;
  /** Selected value on the button. */
  label: string;
  /** Popover open (desktop only; on mobile the layout shows the sheet). */
  open: boolean;
  disabled: boolean;
  opts: PickOption[];
  /** Marked row while the list is open (`aria-activedescendant`). */
  active: number;
  toggle: () => void;
  /** Arrow keys, Enter, Tab (`keydown`). */
  onKey: (event: KeyInput) => void;
  /** Space selects only on release (`keyup`). */
  onKeyUp: (event: KeyInput) => void;
}

/** Entry of a select list: value `v`, label `l`, optional button label and sub line. */
export interface SelOption<V extends string = string> {
  v: V;
  l: string;
  /** Label on the button if it differs from `l`. */
  tl?: string;
  sub?: string;
}

/** What the page knows about the open list. */
export interface SelectState<K extends string> {
  /** Open select list (only while `ui.menu` is `pick`). */
  open: K | null;
  /** Marked row of the open list (`selHi`); `null` = the selected one. */
  hi: number | null;
  isMobile: boolean;
}

export interface SelectContext<K extends string> {
  /** Open or close (`null`) a select list; the marking starts anew. */
  show: (key: K | null) => void;
  /** Mark a row (`null` = none). */
  mark: (i: number | null) => void;
}

/** What every select list passes. */
export interface PickListInput<V extends string> {
  opts: readonly SelOption<V>[];
  /** Selected value (`null`: none, e.g. for users with different roles). */
  cur: string | null;
  open: boolean;
  /** Marked row of the open list (`selHi`); `null` = the selected one. */
  hi: number | null;
  /** Disabled or mobile (where the sheet selects): the keys do nothing. */
  disabled: boolean;
  /** Mark a row (`null` = none). */
  mark: (i: number | null) => void;
  show: () => void;
  hide: () => void;
  choose: (v: V) => void;
}

/** Options, marking and keys of a select list. */
export type PickList = Pick<SelectValues, 'opts' | 'active' | 'onKey' | 'onKeyUp'>;

/**
 * Core of all select lists: the list opens
 * with the selected row marked, the mouse and the arrow keys (`pickKeys`) move
 * the mark, a click or Enter selects.
 */
export function pickList<V extends string>(input: PickListInput<V>): PickList {
  const { opts, cur, open, mark, choose } = input;
  const idx = Math.max(
    0,
    opts.findIndex((o) => o.v === cur),
  );
  const hi = open && input.hi !== null ? input.hi : idx;
  return {
    opts: opts.map((o, i) => ({
      label: o.l,
      sub: o.sub ?? '',
      hasSub: !!o.sub,
      on: o.v === cur,
      hi: i === hi,
      fw: o.v === cur ? 800 : 600,
      onClick: () => choose(o.v),
      hover: () => {
        if (input.hi !== i) mark(i);
      },
    })),
    active: hi,
    ...pickKeys({
      count: opts.length,
      open,
      disabled: input.disabled,
      idx,
      hi,
      mark,
      show: input.show,
      hide: input.hide,
      choose: (i) => {
        const o = opts[i];
        if (o) choose(o.v);
      },
    }),
  };
}

export function selectValues<K extends string>(
  key: K,
  title: string,
  opts: readonly SelOption[],
  cur: string,
  set: (v: string) => void,
  disabled: boolean,
  state: SelectState<K>,
  ctx: SelectContext<K>,
): SelectValues {
  const open = state.open === key;
  const shown = opts.find((o) => o.v === cur) ?? opts[0];
  return {
    title,
    label: shown ? (shown.tl ?? shown.l) : cur,
    open: open && !state.isMobile,
    disabled,
    toggle: () => {
      if (!disabled) ctx.show(open ? null : key);
    },
    ...pickList({
      opts,
      cur,
      open,
      hi: state.hi,
      // On mobile the sheet selects, the button's keys do nothing.
      disabled: disabled || state.isMobile,
      mark: ctx.mark,
      show: () => ctx.show(key),
      hide: () => ctx.show(null),
      choose: (v) => {
        set(v);
        ctx.show(null);
      },
    }),
  };
}

/** Segments like `seg` of the shell. */
export function segOptions<T extends string>(
  opts: readonly T[],
  current: string,
  label: (value: T) => string,
  set: (value: T) => void,
): SegOption<T>[] {
  return opts.map((value) => ({ value, label: label(value), on: value === current, onClick: () => set(value) }));
}

/** IDs of a select list (`selIds`). */
export interface SelIds {
  /** Visible label (row, field or prefix in the button). */
  label: string;
  /** Selected value in the button. */
  value: string;
  /** Value for `aria-labelledby` on the button: label, then value. */
  labelledby: string;
  /** List (`aria-controls`, while it is open). */
  list: string;
  /** Option `i` of the list (`aria-activedescendant`). */
  opt: (i: number) => string;
}

/**
 * IDs of a select list. Accessible name (WCAG 2.5.3): the button shows
 * the selected value, its name names the visible label and this value
 * (`aria-labelledby`) instead of only the title via `aria-label`. Announcing
 * the mark: the button is a "select-only combobox" of the WAI-ARIA
 * Authoring Practices (`role="combobox"`, `aria-expanded`, when open
 * `aria-controls` on the list and `aria-activedescendant` on the marked
 * option); the focus stays on the button. `uid` from `$props.id()`, `key`
 * distinguishes the lists of a page.
 */
export function selIds(uid: string, key: string): SelIds {
  const label = `${uid}-${key}-l`;
  const value = `${uid}-${key}-v`;
  const list = `${uid}-${key}-lb`;
  return { label, value, labelledby: `${label} ${value}`, list, opt: (i) => `${list}-${i}` };
}

/**
 * Keeps the marked row in the visible part of the list (like the shell on
 * opening and with arrow keys); without a mark the selected one (`.opt.on`),
 * e.g. when the target select of the rules opens by click. If the list
 * extends beyond the window edge, the page scrolls afterwards too until the
 * row is visible; jsdom has no `scrollIntoView`.
 */
export function keepHi(list: Element | null | undefined): void {
  if (!(list instanceof HTMLElement)) return;
  const el =
    list.querySelector<HTMLElement>('.hi[role="option"]') ?? list.querySelector<HTMLElement>('.on[role="option"]');
  if (!el) return;
  if (list.scrollHeight > list.clientHeight) {
    if (el.offsetTop < list.scrollTop + 6) list.scrollTop = el.offsetTop - 6;
    else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight - 6)
      list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight + 6;
  }
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
}

/**
 * `keydown` on the button of a select list: the arrow keys, Enter and Tab; after the
 * arrow keys show the marked row (`keepHi`). The list sits next to the button
 * in the same container (`data-pop`).
 */
export function selKey(
  handler: (event: KeyInput) => void,
): (event: KeyboardEvent & { currentTarget: EventTarget & HTMLElement }) => void {
  return (event) => {
    const wrap = event.currentTarget.parentElement;
    handler(event);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      void tick().then(() => keepHi(wrap?.querySelector('[role="listbox"]')));
    }
  };
}

/**
 * Popover of a select list (`use:pickPop` on `role="listbox"`): shows the
 * marked row on opening (`keepHi`), and once more at its final place after
 * the fade-in (the list initially moves and shrinks). A click on an
 * option does not take the focus from the button (`mousedown` without default
 * action), otherwise it would fall to `body` as soon as the option disappears
 * with the list. Safari does not focus clicked buttons anyway; there it
 * stays where it was.
 */
export const pickPop: Action<HTMLElement> = (node) => {
  keepHi(node);
  const down = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest('[role="option"]')) event.preventDefault();
  };
  const shown = (event: AnimationEvent) => {
    if (event.target === node) keepHi(node);
  };
  node.addEventListener('mousedown', down);
  node.addEventListener('animationend', shown);
  return {
    destroy: () => {
      node.removeEventListener('mousedown', down);
      node.removeEventListener('animationend', shown);
    },
  };
};
