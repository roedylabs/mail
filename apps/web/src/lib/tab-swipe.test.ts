import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pointer } from '#lib/test/pointer.ts';
import { dragSheet, rubber } from '#lib/swipe.ts';
import { swipeTabs, tabDrag, tabPanel, tabRelease, tabSegment, type TabSwipe } from '#lib/tab-swipe.ts';

describe('tab swipe maths', () => {
  it('follows the finger towards a neighbour, at most one width', () => {
    expect(tabDrag(-90, 0, 3, 300)).toEqual({ x: -90, next: 1, out: false, p: 0.3 });
    expect(tabDrag(120, 2, 3, 300)).toEqual({ x: 120, next: 1, out: false, p: 0.4 });
    expect(tabDrag(-400, 1, 3, 300)).toMatchObject({ x: -300, next: 2, p: 1 });
  });

  it('pulls as a rubber band with factor 60 beyond the first and last tab', () => {
    const first = tabDrag(90, 0, 3, 300);
    expect(first).toMatchObject({ next: -1, out: true, p: 0 });
    expect(first.x).toBeCloseTo(rubber(90, 60));
    expect(first.x).toBeCloseTo(36);
    expect(tabDrag(-90, 2, 3, 300).x).toBeCloseTo(-36);
  });

  it('cross-fades and scales the panels with the progress', () => {
    const d = tabDrag(-150, 0, 3, 300);
    expect(tabPanel(0, 0, d)).toEqual({ opacity: 0.75, scale: 0.985 });
    expect(tabPanel(1, 0, d)).toEqual({ opacity: 0.7, scale: 0.985 });
    expect(tabPanel(2, 0, d)).toEqual({ opacity: 0, scale: 0.97 });
    const start = tabDrag(0, 1, 3, 300);
    expect(tabPanel(1, 1, start)).toEqual({ opacity: 1, scale: 1 });
  });

  // Mobile segment: 328 px wide, padding 4, gap 4, active column 2.4 fr.
  const box = { width: 328, pad: 4, gap: 4, fr: 2.4 };

  it('interpolates columns, indicator and labels between the old and the new tab', () => {
    const rest = tabSegment(box, 0, 3, tabDrag(0, 0, 3, 300));
    expect(rest.cols).toEqual([2.4, 1, 1]);
    expect(rest.left).toBe(4);
    expect(rest.width).toBeCloseTo((312 * 2.4) / 4.4);
    expect(rest.labels).toEqual([1, 0, 0]);

    const half = tabSegment(box, 0, 3, tabDrag(-150, 0, 3, 300));
    expect(half.cols).toEqual([1.7, 1.7, 1]);
    expect(half.labels).toEqual([0.5, 0.5, 0]);
    // Columns 1.7/1.7/1 of 312 px: the indicator lies between both columns.
    const w = (312 * 1.7) / 4.4;
    expect(half.width).toBeCloseTo(w);
    expect(half.left).toBeCloseTo(4 + (w + 4) / 2);

    const done = tabSegment(box, 0, 3, tabDrag(-300, 0, 3, 300));
    expect(done.cols).toEqual([1, 2.4, 1]);
    expect(done.left).toBeCloseTo(4 + 312 / 4.4 + 4);
    expect(done.labels).toEqual([0, 1, 0]);
  });

  it('lets the indicator give way by 8 % of the rubber band at the ends', () => {
    const d = tabDrag(90, 0, 3, 300);
    const s = tabSegment(box, 0, 3, d);
    expect(s.cols).toEqual([2.4, 1, 1]);
    expect(s.left).toBeCloseTo(4 - d.x * 0.08);
  });

  it('switches from 28 % of the width or when flung faster than 0.35 px/ms in the direction', () => {
    expect(tabRelease(-84, 0, 0, 3, 300).go).toBe(false);
    expect(tabRelease(-85, 0, 0, 3, 300)).toMatchObject({ go: true, next: 1 });
    expect(tabRelease(40, 0.36, 1, 3, 300)).toMatchObject({ go: true, next: 0 });
    expect(tabRelease(-40, -0.36, 1, 3, 300)).toMatchObject({ go: true, next: 2 });
    expect(tabRelease(-40, -0.35, 1, 3, 300).go).toBe(false);
    // Flung against the drag: back.
    expect(tabRelease(-40, 0.8, 1, 3, 300).go).toBe(false);
    // Released right after the decision (no offset): the fling gives the direction.
    expect(tabRelease(0, -0.8, 1, 3, 300)).toMatchObject({ go: true, next: 2 });
    expect(tabRelease(0, 0.8, 1, 3, 300)).toMatchObject({ go: true, next: 0 });
    expect(tabRelease(0, 0, 1, 3, 300).go).toBe(false);
    // No tab beyond the ends.
    expect(tabRelease(200, 2, 0, 3, 300).go).toBe(false);
    expect(tabRelease(-200, -2, 2, 3, 300).go).toBe(false);
  });

  it('settles in clamp(170, 4 · rest / |vx|, 380) ms, with at least 0.6 px/ms', () => {
    // Rest 300 − 100 = 200 px at 0.6 px/ms: 1333 ms, capped.
    expect(tabRelease(-100, 0, 0, 3, 300).ms).toBe(380);
    // Rest 200 px at 4 px/ms: 200 ms.
    expect(tabRelease(-100, -4, 0, 3, 300).ms).toBe(200);
    // Rest 30 px at 2 px/ms: 60 ms, at least 170.
    expect(tabRelease(-270, -2, 0, 3, 300).ms).toBe(170);
    // Back: the shown way, at the ends the rubber band (90 → 36 px at 0.6 px/ms = 240 ms).
    expect(tabRelease(90, 0, 0, 3, 300).ms).toBe(240);
    expect(tabRelease(-50, 0, 0, 3, 300).ms).toBe(333);
  });
});

describe('swipeTabs', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  /** Segment and panels inside the root `data-g-tabsw`, panels 300 px wide. */
  function tabs(o: Partial<TabSwipe> | null = {}) {
    const root = document.createElement('div');
    root.setAttribute('data-g-tabsw', '');
    root.innerHTML =
      '<div role="tablist" style="padding: 4px; column-gap: 4px"></div>' +
      '<div data-g-tabs><div class="track"><div class="panel"><button type="button">Row</button></div></div></div>';
    document.body.append(root);
    const seg = root.querySelector<HTMLElement>('[role="tablist"]')!;
    const panels = root.querySelector<HTMLElement>('[data-g-tabs]')!;
    Object.defineProperty(seg, 'offsetWidth', { value: 328 });
    Object.defineProperty(panels, 'offsetWidth', { value: 300 });
    const select = vi.fn();
    const values: TabSwipe | null = o && { animations: true, index: 0, count: 3, fr: 2.4, desk: false, select, ...o };
    const off = swipeTabs(() => values)(panels);
    const row = panels.querySelector('button')!;
    return { root, panels, row, select, off };
  }

  /** Moves from (150, 100) by `dx`/`dy` (decided after 10 px), then releases standing still or with `fling` px/ms. */
  function drag(target: Element, dx: number, dy = 0, during?: () => void) {
    pointer('pointerdown', 150, 100, target);
    const sx = Math.sign(dx) * 10;
    const sy = Math.sign(dy) * 10;
    pointer('pointermove', 150 + sx, 100 + sy);
    pointer('pointermove', 150 + sx + dx, 100 + sy + dy);
    during?.();
    vi.advanceTimersByTime(200);
    pointer('pointerup', 150 + sx + dx, 100 + sy + dy);
    window.dispatchEvent(new MouseEvent('click'));
  }

  const prop = (el: HTMLElement, k: string) => el.style.getPropertyValue(k);

  it('follows the finger with panels and segment and switches beyond 28 %', async () => {
    vi.useFakeTimers();
    const { root, row, select } = tabs();
    drag(row, -150, 0, () => {
      expect(prop(root, '--gdx')).toBe('-150px');
      expect(prop(root, '--gtd')).toBe('0ms');
      expect(prop(root, '--gp0o')).toBe('0.75');
      expect(prop(root, '--gp1t')).toBe('scale(0.985)');
      expect(prop(root, '--gp2v')).toBe('visible');
      expect(prop(root, '--gcols')).toBe('minmax(0,1.7000fr) minmax(0,1.7000fr) minmax(0,1.0000fr)');
      expect(prop(root, '--gt0w')).toBe('60px');
      expect(prop(root, '--gt1o')).toBe('0.5');
      expect(prop(root, '--gt1g')).toBe('3.5px');
      expect(prop(root, '--gt1c')).toBe('color-mix(in oklab, var(--fg) 50%, var(--mfg))');
    });
    expect(select).toHaveBeenCalledWith(1);
    expect(prop(root, '--gtd')).toBe('380ms');
    expect(prop(root, '--gte')).toBe('cubic-bezier(.2,.8,.2,1)');
    // The new tab applies first, then the drag values go (after `tick`).
    await tick();
    await Promise.resolve();
    expect(prop(root, '--gdx')).toBe('');
    expect(prop(root, '--gp1o')).toBe('');
    vi.advanceTimersByTime(440);
    expect(prop(root, '--gtd')).toBe('');
  });

  it('springs back below 28 % and pulls as a rubber band at the first tab', () => {
    vi.useFakeTimers();
    const { root, row, select } = tabs();
    drag(row, -80);
    expect(select).not.toHaveBeenCalled();
    expect(prop(root, '--gdx')).toBe('');
    drag(row, 90, 0, () => {
      expect(parseFloat(prop(root, '--gdx'))).toBeCloseTo(36);
    });
    expect(select).not.toHaveBeenCalled();
  });

  it('switches on a fast fling released right after the decision (one movement)', () => {
    vi.useFakeTimers();
    const { row, select } = tabs({ index: 1 });
    pointer('pointerdown', 150, 100, row);
    vi.advanceTimersByTime(20);
    pointer('pointermove', 120, 100);
    pointer('pointerup', 120, 100);
    window.dispatchEvent(new MouseEvent('click'));
    expect(select).toHaveBeenCalledWith(2);
  });

  it('settles at once without animations', () => {
    vi.useFakeTimers();
    const { root, row, select } = tabs({ animations: false, index: 1 });
    drag(row, 150);
    expect(select).toHaveBeenCalledWith(0);
    expect(prop(root, '--gtd')).toBe('0ms');
  });

  it('leaves vertical movement to the sheet around it', () => {
    vi.useFakeTimers();
    const { root, row, select } = tabs();
    const scrim = document.createElement('div');
    const sheet = document.createElement('div');
    document.body.append(scrim);
    scrim.append(sheet);
    sheet.append(root);
    Object.defineProperty(sheet, 'offsetHeight', { value: 400 });
    dragSheet(() => ({ animations: false }))(sheet);
    pointer('pointerdown', 150, 100, row);
    pointer('pointermove', 150, 110);
    pointer('pointermove', 150, 160);
    // 50 px since the decision after 10 px.
    expect(sheet.style.translate).toBe('0px 50px');
    expect(prop(root, '--gdx')).toBe('');
    pointer('pointermove', 150, 110);
    pointer('pointerup', 150, 110);
    window.dispatchEvent(new MouseEvent('click'));
    expect(select).not.toHaveBeenCalled();
    // Horizontally the tabs take it, the sheet stays.
    drag(row, -150);
    expect(select).toHaveBeenCalledWith(1);
    expect(sheet.style.translate).toBe('');
  });

  it('on a tablet leaves a swipe to the left on the last tab to the other gestures', () => {
    vi.useFakeTimers();
    const { root, row, select } = tabs({ desk: true, index: 2 });
    drag(row, -150, 0, () => expect(prop(root, '--gdx')).toBe(''));
    drag(row, 150);
    expect(select).toHaveBeenCalledWith(1);
  });

  it('goes back after a cancellation by the browser (`pointercancel`)', () => {
    vi.useFakeTimers();
    const { root, row, select } = tabs();
    pointer('pointerdown', 150, 100, row);
    pointer('pointermove', 140, 100);
    pointer('pointermove', -100, 100);
    pointer('pointercancel', -100, 100);
    expect(select).not.toHaveBeenCalled();
    expect(prop(root, '--gdx')).toBe('');
  });

  it('no gesture without values', () => {
    vi.useFakeTimers();
    const { root, row, select } = tabs(null);
    drag(row, -150, 0, () => expect(prop(root, '--gdx')).toBe(''));
    expect(select).not.toHaveBeenCalled();
  });
});
