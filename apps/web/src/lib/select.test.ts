import { fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keepHi, pickList, pickPop, selIds, selKey, type PickListInput } from './select.ts';

/** List like the popover of a select list; `hi` marks, `on` the selected row. */
function list(labels: string[], hi: number | null, on: number) {
  const wrap = document.createElement('div');
  const button = document.createElement('button');
  button.textContent = labels[on] ?? '';
  const node = document.createElement('div');
  node.setAttribute('role', 'listbox');
  const opts = labels.map((label, i) => {
    const opt = document.createElement('button');
    opt.setAttribute('role', 'option');
    opt.textContent = label;
    if (i === hi) opt.classList.add('hi');
    if (i === on) opt.classList.add('on');
    node.append(opt);
    return opt;
  });
  wrap.append(button, node);
  document.body.append(wrap);
  return { wrap, button, node, opts };
}

/** jsdom knows neither layout nor `scrollIntoView`; emulate both for the row. */
function layout(node: HTMLElement, opts: HTMLElement[], height: number) {
  Object.defineProperty(node, 'clientHeight', { value: height, configurable: true });
  Object.defineProperty(node, 'scrollHeight', { value: opts.length * 40, configurable: true });
  opts.forEach((opt, i) => {
    Object.defineProperty(opt, 'offsetTop', { value: i * 40, configurable: true });
    Object.defineProperty(opt, 'offsetHeight', { value: 40, configurable: true });
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  delete (Element.prototype as Partial<Element>).scrollIntoView;
});

describe('selIds', () => {
  it('names label and value for aria-labelledby', () => {
    expect(selIds('s1', 'tz')).toMatchObject({ label: 's1-tz-l', value: 's1-tz-v', labelledby: 's1-tz-l s1-tz-v' });
  });

  it('names list and options for aria-controls and aria-activedescendant', () => {
    const ids = selIds('s1', 'tz');
    expect(ids.list).toBe('s1-tz-lb');
    expect(ids.opt(0)).toBe('s1-tz-lb-0');
    expect(ids.opt(3)).toBe('s1-tz-lb-3');
  });

  it('gives the button the visible value in its name', () => {
    const ids = selIds('s2', 'start');
    document.body.innerHTML = `<div id="${ids.label}">Open on start</div>
      <button aria-labelledby="${ids.labelledby}"><span id="${ids.value}">Inbox</span></button>`;
    const btn = document.querySelector('button')!;
    expect(btn).toHaveAccessibleName('Open on start Inbox');
  });
});

/** Input of `pickList` with three rows, `b` selected; callbacks as mocks. */
function pick(over: Partial<PickListInput<'a' | 'b' | 'c'>> = {}) {
  const input: PickListInput<'a' | 'b' | 'c'> = {
    opts: [
      { v: 'a', l: 'A' },
      { v: 'b', l: 'B', sub: 'second' },
      { v: 'c', l: 'C' },
    ],
    cur: 'b',
    open: false,
    hi: null,
    disabled: false,
    mark: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    choose: vi.fn(),
    ...over,
  };
  return { input, list: pickList(input) };
}

/** Key like on the button of the select list. */
function key(k: string) {
  return { key: k, preventDefault: vi.fn() };
}

describe('pickList', () => {
  it('opens with the selected row marked', () => {
    const { list } = pick({ open: true });
    expect(list.active).toBe(1);
    expect(list.opts.map((o) => o.on)).toEqual([false, true, false]);
    expect(list.opts.map((o) => o.hi)).toEqual([false, true, false]);
    expect(list.opts[1]).toMatchObject({ label: 'B', sub: 'second', hasSub: true, fw: 800 });
    expect(list.opts[0]).toMatchObject({ sub: '', hasSub: false, fw: 600 });
    // The keyboard mark only applies while the list is open.
    expect(pick({ open: true, hi: 2 }).list.active).toBe(2);
    expect(pick({ open: false, hi: 2 }).list.active).toBe(1);
  });

  it('marks the first row without a selected value, none is selected', () => {
    const { list } = pick({ cur: null, open: true });
    expect(list.active).toBe(0);
    expect(list.opts.some((o) => o.on)).toBe(false);
    expect(list.opts[0]!.hi).toBe(true);
  });

  it('opens with ↓ and marks the selected row', () => {
    const { input, list } = pick();
    const ev = key('ArrowDown');
    list.onKey(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(input.show).toHaveBeenCalledTimes(1);
    expect(input.mark).toHaveBeenCalledWith(1);
  });

  it('moves the mark with ↓ when open and selects the marked one with Enter', () => {
    const { input, list } = pick({ open: true, hi: 2 });
    list.onKey(key('ArrowDown'));
    expect(input.mark).toHaveBeenCalledWith(0);
    list.onKey(key('Enter'));
    expect(input.choose).toHaveBeenCalledWith('c');
    expect(input.show).not.toHaveBeenCalled();
  });

  it('selects by click and marks only another row on hover', () => {
    const { input, list } = pick({ open: true, hi: 1 });
    list.opts[1]!.hover();
    expect(input.mark).not.toHaveBeenCalled();
    list.opts[2]!.hover();
    expect(input.mark).toHaveBeenCalledWith(2);
    list.opts[0]!.onClick();
    expect(input.choose).toHaveBeenCalledWith('a');
  });

  it('does nothing on any key when disabled', () => {
    const closed = pick({ disabled: true });
    closed.list.onKey(key('ArrowDown'));
    const open = pick({ disabled: true, open: true });
    open.list.onKey(key('Enter'));
    open.list.onKeyUp(key(' '));
    for (const { input } of [closed, open]) {
      expect(input.show).not.toHaveBeenCalled();
      expect(input.mark).not.toHaveBeenCalled();
      expect(input.choose).not.toHaveBeenCalled();
    }
  });
});

describe('keepHi', () => {
  it('scrolls the list to the marked row and the page along', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { node, opts } = list(['a', 'b', 'c', 'd', 'e', 'f'], 5, 0);
    layout(node, opts, 120);
    keepHi(node);
    expect(node.scrollTop).toBe(6 * 40 - 120 + 6);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(opts[5]);
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
  });

  it('also scrolls the page if the list itself does not scroll', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { node, opts } = list(['a', 'b', 'c'], null, 2);
    layout(node, opts, 200);
    keepHi(node);
    expect(node.scrollTop).toBe(0);
    expect(scroll.mock.contexts[0]).toBe(opts[2]);
  });

  it('runs without scrollIntoView (jsdom) and without a list', () => {
    const { node, opts } = list(['a', 'b', 'c', 'd'], 1, 3);
    layout(node, opts, 80);
    node.scrollTop = 100;
    expect(() => keepHi(node)).not.toThrow();
    expect(node.scrollTop).toBe(40 - 6);
    expect(() => keepHi(null)).not.toThrow();
  });
});

describe('selKey', () => {
  it('passes the key on and shows the marked row after arrow keys', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { button, opts } = list(['a', 'b'], 1, 0);
    const handler = vi.fn();
    button.addEventListener('keydown', selKey(handler) as EventListener);
    await fireEvent.keyDown(button, { key: 'Enter' });
    await tick();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(scroll).not.toHaveBeenCalled();
    await fireEvent.keyDown(button, { key: 'ArrowDown' });
    await tick();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(scroll.mock.contexts[0]).toBe(opts[1]);
  });
});

describe('pickPop', () => {
  it('shows the marked row on opening', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { node, opts } = list(['a', 'b'], null, 1);
    pickPop(node);
    expect(scroll.mock.contexts[0]).toBe(opts[1]);
    // After the fade-in the list sits at its place: show it once more.
    node.dispatchEvent(new Event('animationend', { bubbles: true }));
    expect(scroll).toHaveBeenCalledTimes(2);
    opts[0]!.dispatchEvent(new Event('animationend', { bubbles: true }));
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it('keeps the focus on the button when clicking an option', () => {
    const { button, node, opts } = list(['a', 'b'], null, 0);
    const handle = pickPop(node) as { destroy: () => void };
    button.focus();
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    opts[1]!.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    // The option disappears with the list; the focus stays on the button.
    node.remove();
    expect(document.activeElement).toBe(button);
    handle.destroy();
  });

  it('leaves mousedown outside the options untouched and cleans up', () => {
    const { node } = list(['a'], null, 0);
    const handle = pickPop(node) as { destroy: () => void };
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    node.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    handle.destroy();
    const opt = node.querySelector('[role="option"]')!;
    const later = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    opt.dispatchEvent(later);
    expect(later.defaultPrevented).toBe(false);
  });
});
