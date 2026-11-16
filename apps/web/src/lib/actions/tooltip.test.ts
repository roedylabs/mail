import { fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  TIP_DELAY,
  TIP_FADE,
  TIP_ID,
  TIP_LONG_PRESS,
  TIP_TOUCH_HIDE,
  hideTooltip,
  placeTip,
  tipValues,
  tooltip,
} from './tooltip.ts';

const VIEW = { w: 1000, h: 800 };
const SIZE = { w: 100, h: 30 };

describe('placeTip', () => {
  it('places the tooltip centred above the element', () => {
    expect(placeTip({ x: 450, y: 400, w: 100, h: 40 }, SIZE, VIEW, 'top')).toEqual({
      side: 'top',
      x: 450,
      y: 362,
      ax: 50,
      // Arrow at most 10 px from the edge of the tooltip.
      ay: 20,
    });
  });

  it('moves to the other side and stays in the window', () => {
    // No room at the top: bottom.
    expect(placeTip({ x: 450, y: 10, w: 100, h: 40 }, SIZE, VIEW, 'top')).toMatchObject({ side: 'bottom', y: 58 });
    // At the right edge: pushed inwards, the arrow still points at the element.
    const right = placeTip({ x: 960, y: 400, w: 40, h: 40 }, SIZE, VIEW, 'top');
    expect(right.x).toBe(VIEW.w - SIZE.w - 8);
    expect(right.ax).toBe(88);
    // No room on the left: to the right.
    expect(placeTip({ x: 20, y: 400, w: 40, h: 40 }, SIZE, VIEW, 'left')).toMatchObject({ side: 'right', x: 68 });
  });
});

describe('tipValues', () => {
  const anchor = { x: 0, y: 0, w: 10, h: 10 };

  it('measures invisibly, then pops up and hides', () => {
    const base = { text: 'Edit', side: 'top' as const, warm: false, anchor };
    expect(tipValues({ ...base, phase: 'measure' })).toMatchObject({ op: 0, anim: 'none', text: 'Edit' });
    const shown = tipValues({ ...base, phase: 'show', x: 5, y: 6, w: 80, h: 30, ax: 40, ay: 15 });
    expect(shown).toMatchObject({ x: 5, y: 6, op: 1, origin: '40px 100%', arL: 35, arT: 23, pad: '7px 12px' });
    expect(shown.anim).toMatch(/^snTipT 260ms/);
    expect(tipValues({ ...base, phase: 'show', warm: true }).anim).toBe('snFade 110ms ease-out');
    expect(tipValues({ ...base, phase: 'hide' })).toMatchObject({ op: 0, tr: 'opacity 120ms ease' });
  });
});

describe('use:tooltip', () => {
  let button: HTMLButtonElement;
  let action: ReturnType<typeof tooltip>;

  beforeEach(() => {
    vi.useFakeTimers();
    button = document.createElement('button');
    button.setAttribute('aria-label', 'Edit');
    document.body.append(button);
    action = tooltip(button, 'Edit');
  });

  afterEach(() => {
    action?.destroy?.();
    button.remove();
    hideTooltip();
    vi.advanceTimersByTime(TIP_FADE + 500);
    ui.tip = null;
    vi.useRealTimers();
  });

  const hover = (el: HTMLElement) => fireEvent.pointerEnter(el, { pointerType: 'mouse' });

  it('shows the text after 520 ms and hides it on leave', async () => {
    await hover(button);
    vi.advanceTimersByTime(TIP_DELAY - 1);
    expect(ui.tip).toBeNull();
    vi.advanceTimersByTime(1);
    expect(ui.tip).toMatchObject({ text: 'Edit', side: 'top', phase: 'measure' });
    // Same text as aria-label: no aria-describedby.
    expect(button).not.toHaveAttribute('aria-describedby');
    ui.tip = { ...ui.tip!, phase: 'show' };
    await fireEvent.pointerLeave(button, { pointerType: 'mouse' });
    expect(ui.tip).toMatchObject({ phase: 'hide' });
    vi.advanceTimersByTime(TIP_FADE);
    expect(ui.tip).toBeNull();
  });

  it('hides on blur only after the event (teardown of a block)', async () => {
    await hover(button);
    vi.advanceTimersByTime(TIP_DELAY);
    ui.tip = { ...ui.tip!, phase: 'show' };
    button.dispatchEvent(new FocusEvent('blur'));
    expect(ui.tip).toMatchObject({ phase: 'show' });
    await Promise.resolve();
    expect(ui.tip).toMatchObject({ phase: 'hide' });
  });

  it('describes elements whose name differs and shows the next one at once', async () => {
    const other = document.createElement('button');
    other.setAttribute('aria-label', 'Notifications, 2 new');
    document.body.append(other);
    const second = tooltip(other, { text: 'Notifications', side: 'bottom' });
    await hover(other);
    vi.advanceTimersByTime(TIP_DELAY);
    expect(other).toHaveAttribute('aria-describedby', TIP_ID);
    ui.tip = { ...ui.tip!, phase: 'show' };
    await fireEvent.pointerLeave(other, { pointerType: 'mouse' });
    expect(other).not.toHaveAttribute('aria-describedby');
    // Shortly afterwards ("warm"): without delay.
    await hover(button);
    expect(ui.tip).toMatchObject({ text: 'Edit', warm: true });
    second?.destroy?.();
    other.remove();
  });

  it('hides on click and shows no new one until leave', async () => {
    await hover(button);
    vi.advanceTimersByTime(TIP_DELAY);
    ui.tip = { ...ui.tip!, phase: 'show' };
    await fireEvent.pointerDown(button, { pointerType: 'mouse' });
    expect(ui.tip).toMatchObject({ phase: 'hide' });
    vi.advanceTimersByTime(TIP_FADE);
    await hover(button);
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip).toBeNull();
  });

  it('shows on touch devices after a long press and swallows the click', async () => {
    await fireEvent.pointerEnter(button, { pointerType: 'touch' });
    await fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 5, clientY: 5 });
    vi.advanceTimersByTime(TIP_LONG_PRESS);
    expect(ui.tip).toMatchObject({ text: 'Edit' });
    ui.tip = { ...ui.tip!, phase: 'show' };
    await fireEvent.pointerUp(button, { pointerType: 'touch' });
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    await fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(TIP_TOUCH_HIDE);
    expect(ui.tip).toMatchObject({ phase: 'hide' });
  });

  it('hides with Escape and on scrolling, not at all without text', async () => {
    await hover(button);
    vi.advanceTimersByTime(TIP_DELAY);
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(ui.tip).toBeNull();
    vi.advanceTimersByTime(1000);
    await fireEvent.pointerLeave(button, { pointerType: 'mouse' });
    await hover(button);
    vi.advanceTimersByTime(TIP_DELAY);
    ui.tip = { ...ui.tip!, phase: 'show' };
    await fireEvent.scroll(window);
    expect(ui.tip).toMatchObject({ phase: 'hide' });
    vi.advanceTimersByTime(TIP_FADE + 1000);
    await fireEvent.pointerLeave(button, { pointerType: 'mouse' });
    action?.update?.(undefined);
    await hover(button);
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip).toBeNull();
  });

  it('describes without aria-label only if the content does not already contain the text', async () => {
    const named = document.createElement('button');
    named.innerHTML = '<span aria-hidden="true">MM</span><span>Max Mustermann</span>';
    const plain = document.createElement('button');
    plain.textContent = 'MM';
    document.body.append(named, plain);
    const handles = [
      tooltip(named, { text: 'Max Mustermann', side: 'top' }),
      tooltip(plain, { text: 'Max Mustermann', side: 'top' }),
    ];
    await hover(named);
    vi.advanceTimersByTime(TIP_DELAY);
    expect(named).not.toHaveAttribute('aria-describedby');
    hideTooltip();
    await hover(plain);
    vi.advanceTimersByTime(TIP_DELAY);
    expect(plain).toHaveAttribute('aria-describedby', TIP_ID);
    hideTooltip();
    for (const h of handles) h?.destroy?.();
    named.remove();
    plain.remove();
  });

  it('keeps other descriptions in aria-describedby', async () => {
    button.setAttribute('aria-label', 'Save');
    button.setAttribute('aria-describedby', 'err-1');
    await hover(button);
    vi.advanceTimersByTime(TIP_DELAY);
    expect(button).toHaveAttribute('aria-describedby', `err-1 ${TIP_ID}`);
    hideTooltip();
    expect(button).toHaveAttribute('aria-describedby', 'err-1');
  });

  it('hides on a keyboard click', async () => {
    await hover(button);
    vi.advanceTimersByTime(TIP_DELAY);
    ui.tip = { ...ui.tip!, phase: 'show' };
    // Enter on a button triggers a click without pointerdown.
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    await fireEvent.click(button);
    expect(onClick).toHaveBeenCalled();
    expect(ui.tip).toMatchObject({ phase: 'hide' });
  });

  it('lets the click through after a long press without text', async () => {
    action?.update?.(undefined);
    await fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 5, clientY: 5 });
    vi.advanceTimersByTime(TIP_LONG_PRESS);
    expect(ui.tip).toBeNull();
    await fireEvent.pointerUp(button, { pointerType: 'touch' });
    const onClick = vi.fn();
    button.addEventListener('click', onClick);
    await fireEvent.click(button);
    expect(onClick).toHaveBeenCalled();
  });
});
