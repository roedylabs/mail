import { fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tablist } from './tablist.ts';

let open: { destroy: () => void }[] = [];

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

/**
 * Tab list; `*` marks the chosen tab, `!` one disabled via `disabled`, `~` one
 * disabled via `aria-disabled`. A click selects like the component
 * (`aria-selected` moves).
 */
function list(spec: string[]) {
  const node = document.createElement('div');
  node.setAttribute('role', 'tablist');
  for (const entry of spec) {
    const button = document.createElement('button');
    button.id = entry.replace(/[*!~]/g, '');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(entry.includes('*')));
    if (entry.includes('!')) button.disabled = true;
    if (entry.includes('~')) button.setAttribute('aria-disabled', 'true');
    node.append(button);
  }
  const clicks: string[] = [];
  node.addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLElement>('[role="tab"]');
    if (!target) return;
    clicks.push(target.id);
    for (const el of node.querySelectorAll('[role="tab"]')) el.setAttribute('aria-selected', String(el === target));
  });
  document.body.append(node);
  open.push(tablist(node));
  return { node, clicks };
}

function tabStops(node: HTMLElement): Record<string, string | null> {
  return Object.fromEntries(
    [...node.querySelectorAll<HTMLElement>('[role="tab"]')].map((el) => [el.id, el.getAttribute('tabindex')]),
  );
}

/** Waits until the MutationObserver has run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  for (const handle of open) handle.destroy();
  open = [];
  document.body.innerHTML = '';
});

describe('use:tablist', () => {
  it('has a tab stop on the chosen tab that moves with aria-selected', async () => {
    const { node } = list(['a', 'b*', 'c']);
    expect(tabStops(node)).toEqual({ a: '-1', b: '0', c: '-1' });
    $('b').setAttribute('aria-selected', 'false');
    $('c').setAttribute('aria-selected', 'true');
    await settle();
    expect(tabStops(node)).toEqual({ a: '-1', b: '-1', c: '0' });
  });

  it('puts the tab stop on the first usable tab without a choice', () => {
    const { node } = list(['a!', 'b~', 'c']);
    expect(tabStops(node)).toEqual({ a: '-1', b: '-1', c: '0' });
  });

  it('switches with → and ← with wrap-around and selects the tab', async () => {
    const { node, clicks } = list(['a*', 'b', 'c']);
    $('a').focus();
    expect(await fireEvent.keyDown($('a'), { key: 'ArrowRight' })).toBe(false);
    expect(document.activeElement).toBe($('b'));
    await fireEvent.keyDown($('b'), { key: 'ArrowRight' });
    await fireEvent.keyDown($('c'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe($('a'));
    await fireEvent.keyDown($('a'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe($('c'));
    expect(clicks).toEqual(['b', 'c', 'a', 'c']);
    await settle();
    expect(tabStops(node)).toEqual({ a: '-1', b: '-1', c: '0' });
  });

  it('jumps with Home and End and skips disabled tabs', async () => {
    const { clicks } = list(['a!', 'b*', 'c~', 'd', 'e!']);
    $('b').focus();
    await fireEvent.keyDown($('b'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe($('d'));
    await fireEvent.keyDown($('d'), { key: 'Home' });
    expect(document.activeElement).toBe($('b'));
    await fireEvent.keyDown($('b'), { key: 'End' });
    expect(document.activeElement).toBe($('d'));
    expect(clicks).toEqual(['d', 'b', 'd']);
  });

  it('ignores ↑/↓, other keys and keys with Ctrl, Alt, Meta or Shift', async () => {
    const { clicks } = list(['a*', 'b']);
    $('a').focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter'])
      expect(await fireEvent.keyDown($('a'), { key }), key).toBe(true);
    for (const mod of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey']) {
      expect(await fireEvent.keyDown($('a'), { key: 'ArrowRight', [mod]: true }), mod).toBe(true);
    }
    expect(document.activeElement).toBe($('a'));
    expect(clicks).toEqual([]);
  });

  it('hides handled keys from the shortcuts of the page', async () => {
    list(['a*', 'b']);
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    try {
      $('a').focus();
      await fireEvent.keyDown($('a'), { key: 'ArrowRight' });
      expect(onWindow).not.toHaveBeenCalled();
      await fireEvent.keyDown($('b'), { key: 'Escape' });
      expect(onWindow).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });

  it('also works from an element inside the tab, not from an inner list', async () => {
    const { node, clicks } = list(['a*', 'b']);
    const inner = document.createElement('span');
    $('a').append(inner);
    await fireEvent.keyDown(inner, { key: 'ArrowRight' });
    expect(document.activeElement).toBe($('b'));
    const nested = document.createElement('div');
    nested.setAttribute('role', 'tablist');
    const own = document.createElement('button');
    own.setAttribute('role', 'tab');
    nested.append(own);
    node.append(nested);
    await fireEvent.keyDown(own, { key: 'ArrowRight' });
    expect(clicks).toEqual(['b']);
  });
});
