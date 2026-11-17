import { afterEach, describe, expect, it, vi } from 'vitest';
import { pointer } from '#lib/test/pointer.ts';
import {
  dragSheet,
  flingDecay,
  rubber,
  sheetCloses,
  sheetOutMs,
  swipeAction,
  swipeFires,
  swipeOffset,
  swipeRow,
  swipeThreshold,
  swipeToast,
  toastGone,
  toastOffset,
  toastOpacity,
  velocity,
  type RowSwipe,
  type SheetDrag,
  type SwipeAction,
} from './swipe.ts';

const inbox = { role: 'inbox' } as const;
const plain = { unread: false, star: false };

describe('swipeAction', () => {
  it('returns the actions with colours and sliding out', () => {
    expect(swipeAction('del', plain, inbox)).toEqual({
      key: 'del',
      icon: 'ti-trash',
      label: 'Delete',
      c: 'var(--danger)',
      ink: 'light-dark(#fffaf3, #2b0d07)',
      out: true,
    });
    expect(swipeAction('move', plain, inbox)).toMatchObject({
      icon: 'ti-folder-symlink',
      label: 'Move to folder',
      out: false,
    });
    expect(swipeAction('spam', plain, inbox)).toMatchObject({
      icon: 'ti-alert-octagon',
      label: 'Spam',
      out: true,
    });
  });

  it('follows the row: read and star per state', () => {
    expect(swipeAction('read', { unread: true, star: false }, inbox)).toMatchObject({
      icon: 'ti-mail-opened',
      label: 'Read',
    });
    expect(swipeAction('read', plain, inbox)).toMatchObject({ icon: 'ti-mail', label: 'Unread' });
    expect(swipeAction('star', { unread: false, star: true }, inbox)).toMatchObject({
      icon: 'ti-star-off',
      label: 'Unflag',
    });
    expect(swipeAction('star', plain, inbox)).toMatchObject({ icon: 'ti-star', label: 'Flag' });
  });

  it('omits actions where they are not possible', () => {
    const trash = { role: 'trash' } as const;
    const scheduled = { role: 'scheduled' } as const;
    expect(swipeAction('none', plain, inbox)).toBeNull();
    expect(swipeAction('unknown', plain, inbox)).toBeNull();
    expect(swipeAction('read', plain, trash)).toBeNull();
    expect(swipeAction('read', plain, scheduled)).toBeNull();
    expect(swipeAction('move', plain, { role: 'drafts' })).toBeNull();
    expect(swipeAction('move', plain, scheduled)).toBeNull();
    expect(swipeAction('spam', plain, { role: 'sent' })).toBeNull();
    expect(swipeAction('spam', plain, trash)).toBeNull();
    expect(swipeAction('star', plain, scheduled)).not.toBeNull();
  });

  it('deletes in scheduled too, where it cancels the sending', () => {
    expect(swipeAction('del', plain, { role: 'scheduled' })).toMatchObject({
      key: 'del',
      icon: 'ti-trash',
      label: 'Delete',
      out: true,
    });
  });

  it('deletes permanently in the trash, without sliding out (confirmation), and knows "Not spam"', () => {
    expect(swipeAction('del', plain, { role: 'trash' })).toMatchObject({
      icon: 'ti-trash-x',
      label: 'Delete permanently',
      out: false,
    });
    expect(swipeAction('spam', plain, { role: 'spam' })).toMatchObject({
      icon: 'ti-shield-check',
      label: 'Not spam',
    });
    expect(swipeAction('move', plain, { folder: true })).not.toBeNull();
    expect(swipeAction('spam', plain, { tag: true })).not.toBeNull();
  });
});

describe('gesture maths', () => {
  it('rubber band and offset of the row', () => {
    expect(rubber(0, 28)).toBe(0);
    expect(rubber(1000, 28)).toBeLessThan(28);
    expect(swipeOffset(-100, 400, true)).toBe(-100);
    expect(swipeOffset(400, 400, true)).toBeCloseTo(340 + rubber(60, 40));
    expect(swipeOffset(-100, 400, false)).toBeCloseTo(-rubber(100, 28));
  });

  it('threshold and triggering', () => {
    expect(swipeThreshold(300)).toBe(90);
    expect(swipeThreshold(1000)).toBe(130);
    expect(swipeFires(-90, 0, 90)).toBe(true);
    expect(swipeFires(-89, 0, 90)).toBe(false);
    // Flung fast, but only after 48 px and only in the direction of the gesture.
    expect(swipeFires(-60, -0.8, 90)).toBe(true);
    expect(swipeFires(-40, -0.8, 90)).toBe(false);
    expect(swipeFires(-60, 0.8, 90)).toBe(false);
  });

  it('toast: upwards only a rubber band, gone from 56 px or 0.5 px/ms', () => {
    expect(toastOffset(10, 20)).toEqual([10, 20]);
    expect(toastOffset(0, -100)[1]).toBeCloseTo(-rubber(100, 18));
    expect(toastOpacity(0, 0)).toBe(1);
    expect(toastOpacity(0, 1000)).toBeCloseTo(0.25);
    expect(toastGone(57, 0, 0, 0)).toBe(true);
    expect(toastGone(0, 50, 0, 0)).toBe(false);
    expect(toastGone(0, -200, 0, 0)).toBe(false);
    expect(toastGone(0, 0, 0, 0.6)).toBe(true);
    expect(toastGone(0, 0, 0, -0.6)).toBe(false);
  });

  it('sheet: closes from 30 % unless flung back up, or when flung down', () => {
    expect(sheetCloses(121, 400, 0)).toBe(true);
    expect(sheetCloses(120, 400, 0)).toBe(false);
    expect(sheetCloses(200, 400, -0.29)).toBe(true);
    expect(sheetCloses(200, 400, -0.3)).toBe(false);
    expect(sheetCloses(10, 400, 0.51)).toBe(true);
    expect(sheetCloses(10, 400, 0.5)).toBe(false);
  });

  it('sheet: slides out in 150 to 300 ms at the release velocity of at least 1.6 px/ms', () => {
    expect(sheetOutMs(400, 0)).toBe(250);
    expect(sheetOutMs(400, 2)).toBe(200);
    expect(sheetOutMs(400, 10)).toBe(150);
    expect(sheetOutMs(800, 0)).toBe(300);
    expect(sheetOutMs(800, -2)).toBe(300);
  });

  it('fling decays by 0.996 per ms', () => {
    expect(flingDecay(1, 0)).toBe(1);
    expect(flingDecay(1, 16)).toBeCloseTo(0.996 ** 16);
    expect(flingDecay(-2, 100)).toBeCloseTo(-2 * 0.996 ** 100);
  });

  it('velocity only with fresh movement', () => {
    const pts = [
      [0, 0, 0],
      [50, 10, 50],
    ] as const;
    expect(velocity(pts, 60)).toEqual([1, 0.2]);
    expect(velocity(pts, 140)).toEqual([0, 0]);
    expect(velocity([[0, 0, 0]], 10)).toEqual([0, 0]);
    expect(velocity([], 10)).toEqual([0, 0]);
  });
});

function rowDom() {
  const el = document.createElement('div');
  el.innerHTML =
    '<div data-sw-bg><span></span><span></span></div><div data-sw-row><button type="button">Stern</button></div>';
  Object.defineProperty(el, 'offsetWidth', { value: 300 });
  document.body.append(el);
  return el;
}

describe('swipeRow', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const del = swipeAction('del', plain, inbox)!;
  const star = swipeAction('star', plain, inbox)!;
  const values = (run: (a: SwipeAction) => void): RowSwipe => ({
    left: del,
    right: star,
    fill: 'var(--surface2)',
    animations: false,
    run,
  });

  it('triggers beyond the threshold, slides out on delete and swallows the click', () => {
    vi.useFakeTimers();
    const el = rowDom();
    const run = vi.fn();
    const cleanup = swipeRow(() => values(run))(el);
    const row = el.querySelector<HTMLElement>('[data-sw-row]')!;
    const bg = el.querySelector<HTMLElement>('[data-sw-bg]')!;
    const click = vi.fn();
    row.querySelector('button')!.addEventListener('click', click);

    pointer('pointerdown', 200, 50, row.querySelector('button')!);
    pointer('pointermove', 190, 51);
    pointer('pointermove', 90, 52);
    expect(row.style.transform).toBe('translateX(-100px)');
    expect(bg.style.background).toBe('var(--danger)');
    expect((bg.children[1] as HTMLElement).style.opacity).toBe('1');
    pointer('pointerup', 90, 52);
    row.querySelector('button')!.click();
    expect(click).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(run).toHaveBeenCalledWith(del);
    if (typeof cleanup === 'function') cleanup();
  });

  it('triggers nothing after a cancellation by the browser (`pointercancel`)', () => {
    vi.useFakeTimers();
    const el = rowDom();
    const run = vi.fn();
    swipeRow(() => values(run))(el);
    const row = el.querySelector<HTMLElement>('[data-sw-row]')!;
    pointer('pointerdown', 200, 50, row);
    pointer('pointermove', 190, 50);
    pointer('pointermove', 50, 50);
    pointer('pointercancel', 50, 50);
    vi.advanceTimersByTime(1000);
    expect(run).not.toHaveBeenCalled();
    expect(row.style.transform).toBe('');
  });

  it('drops the action if the row disappears while sliding out', () => {
    vi.useFakeTimers();
    const el = rowDom();
    const run = vi.fn();
    const cleanup = swipeRow(() => ({ ...values(run), animations: true }))(el);
    const row = el.querySelector<HTMLElement>('[data-sw-row]')!;
    pointer('pointerdown', 200, 50, row);
    pointer('pointermove', 190, 50);
    pointer('pointermove', 50, 50);
    pointer('pointerup', 50, 50);
    if (typeof cleanup === 'function') cleanup();
    vi.advanceTimersByTime(300);
    expect(run).not.toHaveBeenCalled();
  });

  it('springs back below the threshold, without an action', () => {
    vi.useFakeTimers();
    const el = rowDom();
    const run = vi.fn();
    swipeRow(() => values(run))(el);
    const row = el.querySelector<HTMLElement>('[data-sw-row]')!;
    pointer('pointerdown', 100, 50, row);
    pointer('pointermove', 110, 50);
    pointer('pointermove', 140, 50);
    expect(row.style.transform).toBe('translateX(30px)');
    pointer('pointerup', 140, 50);
    vi.advanceTimersByTime(100);
    expect(run).not.toHaveBeenCalled();
    expect(row.style.transform).toBe('');
  });

  it('runs star immediately and leaves vertical movements to scrolling', () => {
    vi.useFakeTimers();
    const el = rowDom();
    const run = vi.fn();
    swipeRow(() => values(run))(el);
    const row = el.querySelector<HTMLElement>('[data-sw-row]')!;
    pointer('pointerdown', 100, 50, row);
    pointer('pointermove', 100, 70);
    pointer('pointermove', 250, 70);
    expect(row.style.transform).toBe('');
    pointer('pointerup', 250, 70);

    pointer('pointerdown', 100, 50, row);
    pointer('pointermove', 110, 50);
    pointer('pointermove', 210, 50);
    pointer('pointerup', 210, 50);
    expect(run).toHaveBeenCalledWith(star);
  });

  it('no gesture without values', () => {
    const el = rowDom();
    swipeRow(() => null)(el);
    const row = el.querySelector<HTMLElement>('[data-sw-row]')!;
    pointer('pointerdown', 100, 50, row);
    pointer('pointermove', 0, 50);
    pointer('pointerup', 0, 50);
    expect(row.style.transform).toBe('');
  });
});

describe('swipeToast', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  const toast = () => {
    const el = document.createElement('div');
    document.body.append(el);
    const o = { animations: false, hold: vi.fn(), away: vi.fn(), back: vi.fn() };
    swipeToast(() => o)(el);
    return { el, o };
  };

  it('stops while dragging and goes when dragged far enough', () => {
    vi.useFakeTimers();
    const { el, o } = toast();
    pointer('pointerdown', 100, 100, el);
    pointer('pointermove', 100, 110);
    expect(o.hold).toHaveBeenCalled();
    pointer('pointermove', 100, 180);
    expect(el.style.translate).toBe('0px 70px');
    pointer('pointerup', 100, 180);
    vi.advanceTimersByTime(0);
    expect(o.away).toHaveBeenCalled();
    expect(o.back).not.toHaveBeenCalled();
  });

  it('springs back when dragged briefly and keeps running', () => {
    vi.useFakeTimers();
    const { el, o } = toast();
    pointer('pointerdown', 100, 100, el);
    pointer('pointermove', 110, 100);
    pointer('pointermove', 130, 100);
    vi.advanceTimersByTime(200);
    pointer('pointerup', 130, 100);
    expect(o.back).toHaveBeenCalled();
    expect(o.away).not.toHaveBeenCalled();
  });
});

describe('dragSheet', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  /** Dialog inside its backdrop (desktop layout), 400 px high, optionally with a scrolled list inside. */
  function sheet(o: SheetDrag | null = { animations: false }, scroll?: number) {
    const scrim = document.createElement('div');
    const el = document.createElement('div');
    el.innerHTML = '<div class="list" style="overflow-y: auto"><button type="button">Row</button></div>';
    scrim.append(el);
    document.body.append(scrim);
    Object.defineProperty(el, 'offsetHeight', { value: 400 });
    const list = el.querySelector<HTMLElement>('.list');
    if (!list) throw new Error('no list');
    if (scroll !== undefined) {
      Object.defineProperty(list, 'scrollHeight', { value: 1000 });
      Object.defineProperty(list, 'clientHeight', { value: 300 });
      list.scrollTop = scroll;
    }
    const closed = vi.fn();
    scrim.addEventListener('mousedown', (e) => {
      if (e.target === scrim) closed();
    });
    const off = dragSheet(() => o)(el);
    const row = list.querySelector('button');
    if (!row) throw new Error('no row');
    return { scrim, el, list, row, closed, off };
  }

  /** Drags from (100, 100) to `y`: decided after 10 px, released after standing still (no velocity). */
  function drag(target: Element, ...ys: number[]) {
    pointer('pointerdown', 100, 100, target);
    for (const y of ys) pointer('pointermove', 100, y);
    vi.advanceTimersByTime(200);
    pointer('pointerup', 100, ys[ys.length - 1] ?? 100);
    window.dispatchEvent(new MouseEvent('click'));
  }

  it('follows downwards, fades the backdrop and closes the layer via the backdrop when released beyond 30 %', () => {
    vi.useFakeTimers();
    const { scrim, el, closed } = sheet();
    pointer('pointerdown', 100, 100, el);
    pointer('pointermove', 100, 110);
    expect(el.style.transition).toBe('none');
    expect(scrim.style.transition).toBe('none');
    pointer('pointermove', 100, 270);
    expect(el.style.translate).toBe('0px 160px');
    expect(scrim.style.opacity).toBe('0.6');
    vi.advanceTimersByTime(200);
    pointer('pointerup', 100, 270);
    window.dispatchEvent(new MouseEvent('click'));
    expect(el.style.transition).toBe('translate 0ms cubic-bezier(0.3, 0.6, 0.4, 1)');
    expect(el.style.translate).toBe('0px 424px');
    expect(scrim.style.opacity).toBe('0');
    expect(closed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(closed).toHaveBeenCalledTimes(1);
    // The layer did not close (the test leaves it there): back into place.
    vi.advanceTimersByTime(20);
    expect(el.style.translate).toBe('');
    expect(scrim.style.opacity).toBe('');
  });

  it('slides out at the speed of the release', () => {
    vi.useFakeTimers();
    const { el, closed } = sheet({ animations: true });
    pointer('pointerdown', 100, 100, el);
    pointer('pointermove', 100, 110);
    vi.advanceTimersByTime(10);
    pointer('pointermove', 100, 140);
    vi.advanceTimersByTime(10);
    pointer('pointerup', 100, 160);
    window.dispatchEvent(new MouseEvent('click'));
    // Flung down at 4 px/ms: closes after only 50 px of 400 px, as fast as possible.
    expect(el.style.transition).toBe('translate 150ms cubic-bezier(0.3, 0.6, 0.4, 1)');
    vi.advanceTimersByTime(149);
    expect(closed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('springs back in 440 ms when released before 30 %', () => {
    vi.useFakeTimers();
    const { scrim, el, closed } = sheet({ animations: true });
    drag(el, 110, 200);
    expect(el.style.transition).toBe('translate 440ms cubic-bezier(0.2, 1.15, 0.35, 1)');
    expect(el.style.translate).toBe('0px');
    expect(scrim.style.transition).toBe('opacity 440ms');
    expect(scrim.style.opacity).toBe('1');
    vi.advanceTimersByTime(470);
    expect(el.style.translate).toBe('');
    expect(el.style.transition).toBe('');
    expect(closed).not.toHaveBeenCalled();
  });

  it('goes upwards only as a rubber band', () => {
    vi.useFakeTimers();
    const { scrim, el } = sheet();
    pointer('pointerdown', 100, 100, el);
    pointer('pointermove', 100, 90);
    pointer('pointermove', 100, 30);
    expect(el.style.translate).toBe(`0px ${-rubber(60, 30)}px`);
    expect(scrim.style.opacity).toBe('1');
    vi.advanceTimersByTime(200);
    pointer('pointerup', 100, 30);
    window.dispatchEvent(new MouseEvent('click'));
    vi.advanceTimersByTime(30);
  });

  it('leaves scrolled content to the browser and follows from the top, scrolling the content again upwards', () => {
    vi.useFakeTimers();
    const scrolled = sheet({ animations: false }, 50);
    drag(scrolled.row, 110, 200);
    expect(scrolled.el.style.translate).toBe('');
    expect(scrolled.list.scrollTop).toBe(50);
    scrolled.off?.();
    document.body.innerHTML = '';

    const { el, list, row } = sheet({ animations: false }, 0);
    pointer('pointerdown', 100, 100, row);
    pointer('pointermove', 100, 110);
    pointer('pointermove', 100, 160);
    expect(el.style.translate).toBe('0px 50px');
    pointer('pointermove', 100, 70);
    expect(el.style.translate).toBe('0px');
    expect(list.scrollTop).toBe(40);
    vi.advanceTimersByTime(200);
    pointer('pointerup', 100, 70);
    window.dispatchEvent(new MouseEvent('click'));
    // Released while the content scrolls: the sheet stays.
    expect(el.style.translate).toBe('');
  });

  it('ignores sideways movement, fields and a missing gesture', () => {
    vi.useFakeTimers();
    const { el } = sheet();
    pointer('pointerdown', 100, 100, el);
    pointer('pointermove', 120, 100);
    pointer('pointermove', 160, 140);
    expect(el.style.translate).toBe('');
    pointer('pointerup', 160, 140);

    el.insertAdjacentHTML('beforeend', '<input>');
    const input = el.querySelector('input');
    if (!input) throw new Error('no input');
    drag(input, 110, 300);
    expect(el.style.translate).toBe('');
    document.body.innerHTML = '';

    const off = sheet(null);
    drag(off.el, 110, 300);
    expect(off.el.style.translate).toBe('');
    expect(off.closed).not.toHaveBeenCalled();
  });
});
