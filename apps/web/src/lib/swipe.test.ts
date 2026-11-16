import { afterEach, describe, expect, it, vi } from 'vitest';
import { pointer } from '#lib/test/pointer.ts';
import {
  rubber,
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
