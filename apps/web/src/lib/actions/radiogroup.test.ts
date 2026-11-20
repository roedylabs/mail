import { fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { radiogroup, type RadioGroupOptions } from './radiogroup.ts';

let open: { destroy: () => void }[] = [];

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

/**
 * Group with options; `*` marks the chosen one, `!` one disabled via `disabled`,
 * `~` one disabled via `aria-disabled`. A click selects like the
 * component (`aria-checked` moves).
 */
function group(spec: string[], options?: RadioGroupOptions) {
  const node = document.createElement('div');
  node.id = 'group';
  node.setAttribute('role', 'radiogroup');
  for (const entry of spec) {
    const id = entry.replace(/[*!~]/g, '');
    const button = document.createElement('button');
    button.id = id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(entry.includes('*')));
    if (entry.includes('!')) button.disabled = true;
    if (entry.includes('~')) button.setAttribute('aria-disabled', 'true');
    node.append(button);
  }
  const clicks: string[] = [];
  node.addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLElement>('[role="radio"]');
    if (!target) return;
    clicks.push(target.id);
    for (const el of node.querySelectorAll('[role="radio"]')) el.setAttribute('aria-checked', String(el === target));
  });
  document.body.append(node);
  const handle = radiogroup(node, options);
  open.push(handle);
  return { node, handle, clicks };
}

function tabStops(node: HTMLElement): Record<string, string | null> {
  return Object.fromEntries(
    [...node.querySelectorAll<HTMLElement>('[role="radio"]')].map((el) => [el.id, el.getAttribute('tabindex')]),
  );
}

/** Waits until the MutationObserver has run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  for (const handle of open) handle.destroy();
  open = [];
  document.body.innerHTML = '';
});

describe('use:radiogroup', () => {
  describe('tab stop', () => {
    it('lies on the chosen option', () => {
      const { node } = group(['a', 'b*', 'c']);
      expect(tabStops(node)).toEqual({ a: '-1', b: '0', c: '-1' });
    });

    it('lies on the first usable option without a choice', () => {
      const { node } = group(['a!', 'b~', 'c', 'd']);
      expect(tabStops(node)).toEqual({ a: '-1', b: '-1', c: '0', d: '-1' });
    });

    it('is missing if all options are disabled', () => {
      const { node } = group(['a!', 'b~*']);
      expect(tabStops(node)).toEqual({ a: '-1', b: '-1' });
    });

    it('moves with aria-checked, disabled and new options', async () => {
      const { node } = group(['a*', 'b', 'c']);
      $('a').setAttribute('aria-checked', 'false');
      $('c').setAttribute('aria-checked', 'true');
      await settle();
      expect(tabStops(node)).toEqual({ a: '-1', b: '-1', c: '0' });

      // Chosen option disabled: tab stop on the first usable one.
      $('c').setAttribute('aria-disabled', 'true');
      await settle();
      expect(tabStops(node)).toEqual({ a: '0', b: '-1', c: '-1' });

      const added = document.createElement('div');
      added.id = 'd';
      added.setAttribute('role', 'radio');
      added.setAttribute('aria-checked', 'false');
      node.append(added);
      await settle();
      expect(tabStops(node)).toEqual({ a: '0', b: '-1', c: '-1', d: '-1' });
    });
  });

  describe('arrow keys', () => {
    it('move by a row with ↑/↓ in a grid of `cols` columns, stopping at the ends', async () => {
      const { handle, clicks } = group(['a*', 'b', 'c', 'd', 'e', 'f', 'g'], { cols: 3 });
      $('a').focus();
      await fireEvent.keyDown($('a'), { key: 'ArrowDown' });
      expect(document.activeElement).toBe($('d'));
      await fireEvent.keyDown($('d'), { key: 'ArrowDown' });
      expect(document.activeElement).toBe($('g'));
      // Past the last row: the last option, no wrapping.
      await fireEvent.keyDown($('g'), { key: 'ArrowDown' });
      await fireEvent.keyDown($('g'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe($('g'));
      await fireEvent.keyDown($('g'), { key: 'ArrowUp' });
      expect(document.activeElement).toBe($('d'));
      await fireEvent.keyDown($('d'), { key: 'ArrowLeft' });
      expect(document.activeElement).toBe($('c'));
      await fireEvent.keyDown($('c'), { key: 'Home' });
      expect(document.activeElement).toBe($('a'));
      await fireEvent.keyDown($('a'), { key: 'ArrowLeft' });
      expect(document.activeElement).toBe($('a'));
      expect(clicks).toEqual(['d', 'g', 'd', 'c', 'a']);
      // The column count follows the layout.
      handle.update({ cols: 2 });
      await fireEvent.keyDown($('a'), { key: 'ArrowDown' });
      expect(document.activeElement).toBe($('c'));
    });

    it('move with →/↓ to the next option and select it, wrapping at the end', async () => {
      const { node, clicks } = group(['a*', 'b', 'c']);
      $('a').focus();
      expect(await fireEvent.keyDown($('a'), { key: 'ArrowRight' })).toBe(false);
      expect(document.activeElement).toBe($('b'));
      expect(await fireEvent.keyDown($('b'), { key: 'ArrowDown' })).toBe(false);
      expect(document.activeElement).toBe($('c'));
      await fireEvent.keyDown($('c'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe($('a'));
      expect(clicks).toEqual(['b', 'c', 'a']);
      await settle();
      expect(tabStops(node)).toEqual({ a: '0', b: '-1', c: '-1' });
    });

    it('move with ←/↑ to the previous option, wrapping at the start', async () => {
      const { clicks } = group(['a*', 'b', 'c']);
      $('a').focus();
      expect(await fireEvent.keyDown($('a'), { key: 'ArrowLeft' })).toBe(false);
      expect(document.activeElement).toBe($('c'));
      expect(await fireEvent.keyDown($('c'), { key: 'ArrowUp' })).toBe(false);
      expect(document.activeElement).toBe($('b'));
      expect(clicks).toEqual(['c', 'b']);
    });

    it('jump with Home and End to the first or last option', async () => {
      const { clicks } = group(['a', 'b*', 'c']);
      $('b').focus();
      expect(await fireEvent.keyDown($('b'), { key: 'End' })).toBe(false);
      expect(document.activeElement).toBe($('c'));
      expect(await fireEvent.keyDown($('c'), { key: 'Home' })).toBe(false);
      expect(document.activeElement).toBe($('a'));
      expect(clicks).toEqual(['c', 'a']);
    });

    it('do not click the already chosen option again', async () => {
      const { clicks } = group(['a*']);
      $('a').focus();
      expect(await fireEvent.keyDown($('a'), { key: 'ArrowRight' })).toBe(false);
      expect(document.activeElement).toBe($('a'));
      expect(clicks).toEqual([]);
    });

    it('skip disabled options', async () => {
      const { clicks } = group(['a!', 'b*', 'c~', 'd', 'e!']);
      $('b').focus();
      await fireEvent.keyDown($('b'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe($('d'));
      await fireEvent.keyDown($('d'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe($('b'));
      await fireEvent.keyDown($('b'), { key: 'ArrowLeft' });
      expect(document.activeElement).toBe($('d'));
      await fireEvent.keyDown($('d'), { key: 'Home' });
      expect(document.activeElement).toBe($('b'));
      await fireEvent.keyDown($('b'), { key: 'End' });
      expect(document.activeElement).toBe($('d'));
      expect(clicks).toEqual(['d', 'b', 'd', 'b', 'd']);
    });

    it('do not react if all options are disabled', async () => {
      const { clicks } = group(['a~', 'b~']);
      $('a').focus();
      expect(await fireEvent.keyDown($('a'), { key: 'ArrowRight' })).toBe(true);
      expect(document.activeElement).toBe($('a'));
      expect(clicks).toEqual([]);
    });

    it('ignore other keys and keys with Ctrl, Alt, Meta or Shift', async () => {
      const { clicks } = group(['a*', 'b']);
      $('a').focus();
      expect(await fireEvent.keyDown($('a'), { key: 'Enter' })).toBe(true);
      for (const mod of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey']) {
        expect(await fireEvent.keyDown($('a'), { key: 'ArrowRight', [mod]: true }), mod).toBe(true);
      }
      expect(document.activeElement).toBe($('a'));
      expect(clicks).toEqual([]);
    });

    it('hide the key from the shortcuts of the page', async () => {
      group(['a*', 'b']);
      const onWindow = vi.fn();
      window.addEventListener('keydown', onWindow);
      try {
        $('a').focus();
        expect(await fireEvent.keyDown($('a'), { key: 'ArrowDown' })).toBe(false);
        expect(onWindow).not.toHaveBeenCalled();
        // Unhandled keys pass on.
        await fireEvent.keyDown($('b'), { key: 'Escape' });
        expect(onWindow).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener('keydown', onWindow);
      }
    });

    it('also work from an element inside the option', async () => {
      const { node, clicks } = group(['a*', 'b']);
      const inner = document.createElement('span');
      $('a').append(inner);
      await fireEvent.keyDown(inner, { key: 'ArrowRight' });
      expect(document.activeElement).toBe($('b'));
      expect(clicks).toEqual(['b']);
      expect(node.contains(document.activeElement)).toBe(true);
    });
  });

  describe('select: false', () => {
    it('only moves focus and does not click', async () => {
      const { node, clicks } = group(['a*', 'b', 'c'], { select: false });
      $('a').focus();
      expect(await fireEvent.keyDown($('a'), { key: 'ArrowRight' })).toBe(false);
      expect(document.activeElement).toBe($('b'));
      await fireEvent.keyDown($('b'), { key: 'End' });
      expect(document.activeElement).toBe($('c'));
      expect(clicks).toEqual([]);
      // The tab stop stays on the chosen option.
      expect(tabStops(node)).toEqual({ a: '0', b: '-1', c: '-1' });
    });

    it('can be switched via update', async () => {
      const { handle, clicks } = group(['a*', 'b', 'c']);
      handle.update({ select: false });
      $('a').focus();
      await fireEvent.keyDown($('a'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe($('b'));
      expect(clicks).toEqual([]);

      // Without a value the default applies again: arrows also select.
      handle.update();
      await fireEvent.keyDown($('b'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe($('c'));
      expect(clicks).toEqual(['c']);
    });
  });

  describe('nested group', () => {
    it('does not count the options of the inner group', async () => {
      const { node, clicks } = group(['a*', 'b']);
      const inner = document.createElement('div');
      inner.setAttribute('role', 'radiogroup');
      inner.innerHTML = `<div id="x" role="radio" aria-checked="true" tabindex="0"></div><div id="y" role="radio" aria-checked="false"></div>`;
      node.append(inner);
      await settle();
      // The inner group manages its tab stops itself.
      expect(tabStops(node)).toEqual({ a: '0', b: '-1', x: '0', y: null });

      await fireEvent.keyDown($('b'), { key: 'ArrowRight' });
      expect(document.activeElement).toBe($('a'));

      $('x').focus();
      expect(await fireEvent.keyDown($('x'), { key: 'ArrowRight' })).toBe(true);
      expect(document.activeElement).toBe($('x'));
      expect(clicks).toEqual([]);
    });
  });

  describe('destroy', () => {
    it('removes listeners and observers', async () => {
      const { node, handle, clicks } = group(['a*', 'b']);
      handle.destroy();
      $('a').focus();
      expect(await fireEvent.keyDown($('a'), { key: 'ArrowRight' })).toBe(true);
      expect(document.activeElement).toBe($('a'));
      expect(clicks).toEqual([]);

      $('a').setAttribute('aria-checked', 'false');
      $('b').setAttribute('aria-checked', 'true');
      await settle();
      expect(tabStops(node)).toEqual({ a: '0', b: '-1' });
    });
  });
});
