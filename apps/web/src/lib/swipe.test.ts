import { afterEach, describe, expect, it, vi } from 'vitest';
import { pointer } from '#lib/test/pointer.ts';
import {
  backChipY,
  backFires,
  backProgress,
  backReady,
  dragSheet,
  flingDecay,
  pullOffset,
  pullScrim,
  pullSheet,
  pullStays,
  pullStaysEarly,
  rubber,
  sheetCloses,
  sheetOutMs,
  swipeAction,
  swipeBack,
  swipeFires,
  swipeOffset,
  swipeRow,
  swipeThreshold,
  swipeToast,
  toastGone,
  toastOffset,
  toastOpacity,
  velocity,
  type BackSwipe,
  type RowSwipe,
  type SheetDrag,
  type SheetPull,
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

  it('springs back when the browser cancels the gesture, even beyond 30 %', () => {
    vi.useFakeTimers();
    const { el, closed } = sheet({ animations: true });
    pointer('pointerdown', 100, 100, el);
    pointer('pointermove', 100, 110);
    pointer('pointermove', 100, 300);
    expect(el.style.translate).toBe('0px 190px');
    pointer('pointercancel', 100, 300);
    window.dispatchEvent(new MouseEvent('click'));
    expect(el.style.transition).toBe('translate 440ms cubic-bezier(0.2, 1.15, 0.35, 1)');
    expect(el.style.translate).toBe('0px');
    vi.advanceTimersByTime(470);
    expect(closed).not.toHaveBeenCalled();
    expect(el.style.translate).toBe('');
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

describe('pull-up gesture maths', () => {
  it('starts the sheet its height + 16 px below its place, beyond it a rubber band with factor 30', () => {
    expect(pullOffset(0, 400)).toBe(400);
    expect(pullOffset(150, 400)).toBe(250);
    expect(pullOffset(400, 400)).toBe(0);
    expect(pullOffset(460, 400)).toBeCloseTo(-rubber(60, 30));
    expect(pullOffset(10_000, 400)).toBeGreaterThan(-30);
  });

  it('fades the backdrop in with the lift', () => {
    expect(pullScrim(-20, 400)).toBe(0);
    expect(pullScrim(0, 400)).toBe(0);
    expect(pullScrim(100, 400)).toBe(0.25);
    expect(pullScrim(400, 400)).toBe(1);
    expect(pullScrim(600, 400)).toBe(1);
  });

  it('stays open when flung up faster than 0.35 px/ms', () => {
    expect(pullStays(390, 400, -0.36)).toBe(true);
    expect(pullStays(390, 400, -0.35)).toBe(false);
    expect(pullStays(-20, 400, -2)).toBe(true);
  });

  it('stays open above 70 % of the start offset unless flung down at 0.35 px/ms or faster', () => {
    expect(pullStays(279, 400, 0)).toBe(true);
    expect(pullStays(280, 400, 0)).toBe(false);
    expect(pullStays(100, 400, 0.34)).toBe(true);
    expect(pullStays(100, 400, 0.35)).toBe(false);
    expect(pullStays(-20, 400, 0.2)).toBe(true);
  });

  it('without a sheet stays open only when flung up faster than 0.3 px/ms or pulled up more than 80 px', () => {
    expect(pullStaysEarly(-81, 0)).toBe(true);
    expect(pullStaysEarly(-80, 0)).toBe(false);
    expect(pullStaysEarly(-10, -0.31)).toBe(true);
    expect(pullStaysEarly(-10, -0.3)).toBe(false);
    expect(pullStaysEarly(-200, 1)).toBe(true);
  });
});

describe('pullSheet', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  /**
   * Tab bar with one tab; `open` renders a sheet 384 px high (start offset
   * 400 px) with its backdrop before it, unless `render` is false.
   */
  function bar(o: Partial<SheetPull> | null = {}, render = true) {
    const nav = document.createElement('nav');
    nav.innerHTML = '<button type="button">More</button>';
    document.body.append(nav);
    const tab = nav.querySelector('button');
    if (!tab) throw new Error('no tab');
    const tapped = vi.fn();
    tab.addEventListener('click', tapped);
    const scrim = document.createElement('div');
    scrim.setAttribute('data-scrim', '');
    const el = document.createElement('div');
    el.setAttribute('data-sheet', '1');
    Object.defineProperty(el, 'offsetHeight', { value: 384 });
    const closed = vi.fn();
    scrim.addEventListener('mousedown', closed);
    const open = vi.fn(() => {
      if (render) document.body.append(scrim, el);
    });
    const close = vi.fn();
    const values: SheetPull | null = o && { animations: false, open, close, ...o };
    const off = pullSheet(() => values)(nav);
    return { nav, tab, tapped, scrim, el, open, close, closed, off };
  }

  /** Pulls up from (100, 700): decided after 10 px, then `lift` px further, released after standing still. */
  function pull(target: Element, lift: number) {
    pointer('pointerdown', 100, 700, target);
    pointer('pointermove', 100, 690);
    pointer('pointermove', 100, 690 - lift);
    vi.advanceTimersByTime(200);
    pointer('pointerup', 100, 690 - lift);
    window.dispatchEvent(new MouseEvent('click'));
  }

  it('opens the sheet at once on an upward drag; it follows the finger and the backdrop fades in', () => {
    vi.useFakeTimers();
    const { tab, el, scrim, open } = bar();
    pointer('pointerdown', 100, 700, tab);
    pointer('pointermove', 100, 695);
    expect(open).not.toHaveBeenCalled();
    pointer('pointermove', 100, 690);
    expect(open).toHaveBeenCalledTimes(1);
    // Open animation and transitions off, start 384 + 16 px below its place.
    expect(el.style.animation).toBe('none');
    expect(el.style.transition).toBe('none');
    expect(scrim.style.animation).toBe('none');
    expect(scrim.style.transition).toBe('none');
    expect(el.style.translate).toBe('0px 400px');
    expect(scrim.style.opacity).toBe('0');
    pointer('pointermove', 100, 590);
    expect(el.style.translate).toBe('0px 300px');
    expect(scrim.style.opacity).toBe('0.25');
    pointer('pointermove', 100, 230);
    expect(el.style.translate).toBe(`0px ${-rubber(60, 30)}px`);
    expect(scrim.style.opacity).toBe('1');
    pointer('pointerup', 100, 230);
    window.dispatchEvent(new MouseEvent('click'));
  });

  it('stays open above 70 % and springs into place in 440 ms', () => {
    vi.useFakeTimers();
    const { tab, tapped, el, scrim, close, closed } = bar({ animations: true });
    pull(tab, 121);
    expect(el.style.transition).toBe('translate 440ms cubic-bezier(0.2, 1.15, 0.35, 1)');
    expect(el.style.translate).toBe('0px');
    expect(scrim.style.transition).toBe('opacity 440ms');
    expect(scrim.style.opacity).toBe('1');
    vi.advanceTimersByTime(470);
    expect(el.style.translate).toBe('');
    expect(el.style.transition).toBe('');
    expect(scrim.style.opacity).toBe('');
    // Removing the animation would play it again.
    expect(el.style.animation).toBe('none');
    expect(close).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    // The click of the gesture does not reach the tab.
    expect(tapped).not.toHaveBeenCalled();
  });

  it('leaves the sheet to a drag down that starts while it springs into place', () => {
    vi.useFakeTimers();
    const { tab, el, scrim, closed } = bar({ animations: true });
    const off = dragSheet(() => ({ animations: true, scrim }))(el);
    pull(tab, 121);
    // 300 ms after the release the sheet is dragged down beyond 30 % and released: 240 ms to slide out.
    pointer('pointerdown', 100, 400, el);
    pointer('pointermove', 100, 410);
    pointer('pointermove', 100, 530);
    vi.advanceTimersByTime(300);
    pointer('pointerup', 100, 530);
    window.dispatchEvent(new MouseEvent('click'));
    expect(el.style.translate).toBe('0px 408px');
    // The pull's reset (470 ms after its release) does not put it back while it slides out.
    vi.advanceTimersByTime(200);
    expect(el.style.translate).toBe('0px 408px');
    expect(scrim.style.opacity).toBe('0');
    expect(closed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(40);
    expect(closed).toHaveBeenCalledTimes(1);
    off?.();
  });

  it('closes like a sheet dragged down when released below 70 %', () => {
    vi.useFakeTimers();
    const { tab, el, scrim, closed } = bar();
    pull(tab, 120);
    expect(el.style.transition).toBe('translate 0ms cubic-bezier(0.3, 0.6, 0.4, 1)');
    expect(el.style.translate).toBe('0px 408px');
    expect(scrim.style.opacity).toBe('0');
    expect(closed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('stays open when flung up, even below 70 %', () => {
    vi.useFakeTimers();
    const { tab, el, closed } = bar();
    pointer('pointerdown', 100, 700, tab);
    pointer('pointermove', 100, 690);
    vi.advanceTimersByTime(10);
    pointer('pointermove', 100, 670);
    pointer('pointerup', 100, 670);
    window.dispatchEvent(new MouseEvent('click'));
    // 30 px in 10 ms: −3 px/ms.
    expect(el.style.translate).toBe('0px');
    vi.advanceTimersByTime(500);
    expect(closed).not.toHaveBeenCalled();
  });

  it('slides out at the speed of the release', () => {
    vi.useFakeTimers();
    const { tab, el, closed } = bar({ animations: true });
    pull(tab, 50);
    // Standing still: 384 px at 1.6 px/ms, 240 ms.
    expect(el.style.transition).toBe('translate 240ms cubic-bezier(0.3, 0.6, 0.4, 1)');
    vi.advanceTimersByTime(239);
    expect(closed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('closes when the browser cancels the gesture, even above 70 %', () => {
    vi.useFakeTimers();
    const { tab, el, closed } = bar();
    pointer('pointerdown', 100, 700, tab);
    pointer('pointermove', 100, 690);
    pointer('pointermove', 100, 390);
    pointer('pointercancel', 100, 390);
    window.dispatchEvent(new MouseEvent('click'));
    expect(el.style.translate).toBe('0px 408px');
    vi.advanceTimersByTime(0);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('without a sheet closes again unless pulled up more than 80 px', () => {
    vi.useFakeTimers();
    let b = bar({}, false);
    pull(b.tab, 80);
    expect(b.open).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
    b.off?.();
    document.body.innerHTML = '';

    b = bar({}, false);
    pull(b.tab, 81);
    expect(b.close).not.toHaveBeenCalled();
  });

  it('leaves taps, sideways and downward drags alone', () => {
    vi.useFakeTimers();
    const { tab, tapped, open } = bar();
    pointer('pointerdown', 100, 700, tab);
    pointer('pointerup', 100, 700);
    tab.click();
    expect(tapped).toHaveBeenCalledTimes(1);
    pointer('pointerdown', 100, 700, tab);
    pointer('pointermove', 120, 690);
    pointer('pointerup', 120, 690);
    pointer('pointerdown', 100, 700, tab);
    pointer('pointermove', 100, 720);
    pointer('pointerup', 100, 720);
    expect(open).not.toHaveBeenCalled();
  });

  it('does nothing when turned off', () => {
    vi.useFakeTimers();
    const { tab } = bar(null);
    pull(tab, 300);
    expect(document.querySelector('[data-sheet]')).toBeNull();
  });
});

describe('back gesture maths', () => {
  it('reaches full progress at 45 % of the width, at most 360 px', () => {
    expect(backProgress(-20, 400)).toBe(0);
    expect(backProgress(90, 400)).toBe(0.5);
    expect(backProgress(400, 400)).toBe(1);
    expect(backProgress(180, 1000)).toBe(0.5);
  });

  it('is ready beyond 25 % of the width, at most 180 px', () => {
    expect(backReady(100, 400)).toBe(false);
    expect(backReady(101, 400)).toBe(true);
    expect(backReady(180, 1000)).toBe(false);
    expect(backReady(181, 1000)).toBe(true);
  });

  it('goes back when ready or flung faster than 0.45 px/ms after more than 24 px', () => {
    expect(backFires(120, 0, 400)).toBe(true);
    expect(backFires(30, 0.5, 400)).toBe(true);
    expect(backFires(24, 0.9, 400)).toBe(false);
    expect(backFires(60, 0.45, 400)).toBe(false);
  });

  it('keeps the chip at finger height between 70 px from the top and 120 px from the bottom', () => {
    expect(backChipY(300, 800)).toBe(278);
    expect(backChipY(40, 800)).toBe(70);
    expect(backChipY(790, 800)).toBe(680);
  });
});

describe('swipeBack', () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  /** Page inside a 400 × 800 px root with the layer underneath and the chip. */
  function page(o: Partial<BackSwipe> | null = {}) {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-back-under></div><div class="page"><div class="strip" style="overflow-x: auto"><button type="button">Row</button></div><input></div><div data-back-chip></div>';
    document.body.append(root);
    Object.defineProperty(root, 'offsetWidth', { value: 400 });
    Object.defineProperty(root, 'offsetHeight', { value: 800 });
    const el = root.querySelector<HTMLElement>('.page');
    const under = root.querySelector<HTMLElement>('[data-back-under]');
    const chip = root.querySelector<HTMLElement>('[data-back-chip]');
    const strip = root.querySelector<HTMLElement>('.strip');
    if (!el || !under || !chip || !strip) throw new Error('no page');
    const back = vi.fn(() => Promise.resolve());
    const off = swipeBack(() => (o ? { animations: false, back, ...o } : null))(el);
    return { root, el, under, chip, strip, back, off };
  }

  /** Lets pending promises (navigation, `tick`) settle. */
  async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  /** Swipes from (100, 300) sideways by `dx`: decided after 10 px, released after standing still. */
  function drag(target: Element, dx: number, end = 'pointerup') {
    const x = 100 + Math.sign(dx) * 10;
    pointer('pointerdown', 100, 300, target);
    pointer('pointermove', x, 300);
    pointer('pointermove', x + dx, 300);
    vi.advanceTimersByTime(200);
    pointer(end, x + dx, 300);
    window.dispatchEvent(new MouseEvent('click'));
  }

  it('moves and shrinks the page, fades in the layer and brings the chip to finger height', () => {
    vi.useFakeTimers();
    const { el, under, chip } = page();
    pointer('pointerdown', 100, 300, el);
    pointer('pointermove', 110, 300);
    expect(el.style.transition).toBe('none');
    expect(el.style.background).toBe('var(--cnv)');
    expect(el.style.overflow).toBe('hidden');
    expect(el.style.boxShadow).toBe('var(--sh3)');
    expect(under.style.transition).toBe('none');
    pointer('pointermove', 200, 320);
    // 90 px of 180 px: half way, not yet ready.
    expect(el.style.translate).toBe('14px 0.8px');
    expect(el.style.scale).toBe('0.96');
    expect(el.style.borderRadius).toBe('18px');
    expect(under.style.opacity).toBe('0.5');
    expect(chip.style.opacity).toBe('1');
    expect(chip.style.translate).toBe('-19px 298px');
    expect(chip.style.scale).toBe('0.825');
    expect(chip.style.background).toBe('var(--surface)');
    expect(chip.style.color).toBe('var(--fg)');
    pointer('pointermove', 220, 320);
    // Beyond 100 px (25 % of 400 px): ready.
    expect(chip.style.scale).toBe('1.08');
    expect(chip.style.background).toBe('var(--acc)');
    expect(chip.style.color).toBe('var(--accink)');
    vi.advanceTimersByTime(200);
    pointer('pointerup', 220, 320);
    window.dispatchEvent(new MouseEvent('click'));
    // Released when ready: goes back (without animations at once).
    vi.advanceTimersByTime(0);
  });

  it('flies out when ready, goes back and then resets the page and fades out the layer', async () => {
    vi.useFakeTimers();
    const { el, under, chip, back } = page({ animations: true });
    drag(el, 120);
    expect(el.style.transition).toBe(
      'translate 190ms cubic-bezier(0.4, 0, 1, 1), scale 190ms cubic-bezier(0.4, 0, 1, 1), opacity 190ms ease-in',
    );
    expect(el.style.translate).toBe('140px');
    expect(el.style.scale).toBe('0.86');
    expect(el.style.opacity).toBe('0');
    expect(chip.style.opacity).toBe('0');
    expect(chip.style.scale).toBe('1.3');
    vi.advanceTimersByTime(189);
    expect(back).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(back).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(el.style.opacity).toBe(''));
    expect(el.style.translate).toBe('');
    expect(el.style.background).toBe('');
    expect(under.style.transition).toBe('opacity 260ms');
    expect(under.style.opacity).toBe('0');
  });

  it('starts no new gesture until the new view is shown', async () => {
    vi.useFakeTimers();
    const { el, back } = page();
    let shown = () => {};
    back.mockImplementationOnce(() => new Promise<void>((done) => (shown = done)));
    drag(el, 120);
    vi.advanceTimersByTime(0);
    expect(back).toHaveBeenCalledTimes(1);
    pointer('pointerdown', 100, 300, el);
    pointer('pointermove', 110, 300);
    pointer('pointermove', 150, 300);
    // The page stays flown out, the second swipe does not paint.
    expect(el.style.opacity).toBe('0');
    expect(el.style.scale).toBe('0.86');
    pointer('pointerup', 150, 300);
    window.dispatchEvent(new MouseEvent('click'));
    shown();
    await vi.waitFor(() => expect(el.style.opacity).toBe(''));
    drag(el, 120);
    vi.advanceTimersByTime(0);
    expect(back).toHaveBeenCalledTimes(2);
  });

  it('frees the other gestures when the page goes while going back', async () => {
    vi.useFakeTimers();
    const first = page();
    let shown = () => {};
    first.back.mockImplementationOnce(() => new Promise<void>((done) => (shown = done)));
    drag(first.el, 120);
    vi.advanceTimersByTime(0);
    expect(first.back).toHaveBeenCalledTimes(1);
    first.off?.();
    const second = page();
    let shown2 = () => {};
    second.back.mockImplementationOnce(() => new Promise<void>((done) => (shown2 = done)));
    drag(second.el, 120);
    vi.advanceTimersByTime(0);
    expect(second.back).toHaveBeenCalledTimes(1);
    // The late completion of the first page does not free the lock of the second one.
    shown();
    await settle();
    drag(second.el, 120);
    vi.advanceTimersByTime(0);
    expect(second.back).toHaveBeenCalledTimes(1);
    shown2();
    await vi.waitFor(() => expect(second.el.style.opacity).toBe(''));
    drag(second.el, 120);
    vi.advanceTimersByTime(0);
    expect(second.back).toHaveBeenCalledTimes(2);
  });

  it('leaves a new gesture on the same page alone when an old completion arrives late', async () => {
    vi.useFakeTimers();
    const { el, off, back } = page();
    let shown = () => {};
    back.mockImplementationOnce(() => new Promise<void>((done) => (shown = done)));
    drag(el, 120);
    vi.advanceTimersByTime(0);
    expect(back).toHaveBeenCalledTimes(1);
    off?.();
    // Attached again to the same page (e.g. after switching the layout).
    const again = swipeBack(() => ({ animations: false, back }))(el);
    pointer('pointerdown', 100, 300, el);
    pointer('pointermove', 110, 300);
    pointer('pointermove', 200, 300);
    expect(el.style.boxShadow).toBe('var(--sh3)');
    expect(el.style.translate).not.toBe('');
    // The first gesture's navigation settles late: the second one keeps its painting.
    shown();
    await settle();
    expect(el.style.boxShadow).toBe('var(--sh3)');
    expect(el.style.translate).not.toBe('');
    vi.advanceTimersByTime(200);
    pointer('pointerup', 150, 300);
    window.dispatchEvent(new MouseEvent('click'));
    vi.advanceTimersByTime(0);
    again?.();
  });

  it('goes back on a fling before the threshold', () => {
    vi.useFakeTimers();
    const { el, back } = page();
    pointer('pointerdown', 100, 300, el);
    pointer('pointermove', 110, 300);
    vi.advanceTimersByTime(10);
    pointer('pointermove', 125, 300);
    vi.advanceTimersByTime(10);
    pointer('pointermove', 140, 300);
    pointer('pointerup', 140, 300);
    window.dispatchEvent(new MouseEvent('click'));
    vi.advanceTimersByTime(0);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('springs back below the threshold and after pointercancel', () => {
    vi.useFakeTimers();
    const { el, under, chip, back } = page({ animations: true });
    drag(el, 60);
    expect(el.style.transition).toBe(
      'translate 380ms cubic-bezier(0.2, 1.15, 0.35, 1), scale 380ms cubic-bezier(0.2, 1.15, 0.35, 1), border-radius 380ms',
    );
    expect(el.style.translate).toBe('0px');
    expect(el.style.scale).toBe('1');
    expect(el.style.borderRadius).toBe('0px');
    expect(under.style.transition).toBe('opacity 380ms');
    expect(under.style.opacity).toBe('0');
    expect(chip.style.transition).toBe('opacity 160ms, translate 380ms');
    expect(chip.style.opacity).toBe('0');
    vi.advanceTimersByTime(410);
    expect(el.style.transition).toBe('');
    expect(el.style.translate).toBe('');
    // Cancelled by the browser or the system: back, even when ready.
    drag(el, 200, 'pointercancel');
    vi.advanceTimersByTime(410);
    expect(back).not.toHaveBeenCalled();
    expect(el.style.translate).toBe('');
  });

  it('ignores movement to the left, vertical movement, fields, scrolled content and a missing gesture', () => {
    vi.useFakeTimers();
    const { el, strip, back } = page();
    drag(el, -120);
    pointer('pointerdown', 100, 300, el);
    pointer('pointermove', 110, 330);
    pointer('pointermove', 200, 500);
    expect(el.style.translate).toBe('');
    pointer('pointerup', 200, 500);
    const input = el.querySelector('input');
    if (!input) throw new Error('no input');
    drag(input, 120);
    // Content scrolled sideways scrolls back first.
    Object.defineProperty(strip, 'scrollWidth', { value: 800 });
    Object.defineProperty(strip, 'clientWidth', { value: 300 });
    strip.scrollLeft = 40;
    drag(strip, 120);
    expect(el.style.translate).toBe('');
    vi.advanceTimersByTime(0);
    expect(back).not.toHaveBeenCalled();
    // Not scrolled: the gesture goes back.
    strip.scrollLeft = 0;
    drag(strip, 120);
    vi.advanceTimersByTime(0);
    expect(back).toHaveBeenCalledTimes(1);
    document.body.innerHTML = '';

    const off = page(null);
    drag(off.el, 120);
    expect(off.el.style.translate).toBe('');
    vi.advanceTimersByTime(0);
    expect(off.back).not.toHaveBeenCalled();
  });
});
