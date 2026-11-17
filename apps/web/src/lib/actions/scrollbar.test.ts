import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverlayScrollbar, SCROLLBAR, type ScrollbarProfile } from './scrollbar.ts';

let bars: OverlayScrollbar[] = [];

interface Area {
  /** Scroll area: 400 × 300 px at (20, 30), content `height` px tall. */
  c: HTMLElement;
  bar: OverlayScrollbar;
}

/** Fixed geometry, since jsdom does not lay out. */
function geometry(el: HTMLElement, values: Record<string, number>) {
  for (const [key, value] of Object.entries(values)) Object.defineProperty(el, key, { configurable: true, value });
}

function area(
  opts: { height?: number; radius?: number; headings?: string[]; profile?: ScrollbarProfile; motion?: boolean } = {},
): Area {
  const parent = document.createElement('div');
  const c = document.createElement('div');
  if (opts.radius) {
    c.style.borderTopRightRadius = `${opts.radius}px`;
    c.style.borderBottomRightRadius = `${opts.radius}px`;
  }
  for (const text of opts.headings ?? []) {
    const h = document.createElement('h2');
    h.textContent = text;
    c.append(h);
  }
  const after = document.createElement('p');
  parent.append(c, after);
  document.body.append(parent);
  geometry(c, {
    offsetWidth: 400,
    offsetHeight: 300,
    offsetLeft: 20,
    offsetTop: 30,
    clientHeight: 300,
    scrollHeight: opts.height ?? 1200,
  });
  // jsdom does not scroll: keep `scrollTop` within 0 … scrollHeight − clientHeight.
  let top = 0;
  Object.defineProperty(c, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.min(Math.max(v, 0), c.scrollHeight - c.clientHeight);
    },
  });
  const profile = opts.profile ?? 'desk';
  const motion = opts.motion ?? true;
  const bar = new OverlayScrollbar(c, { profile: () => profile, motion: () => motion });
  bars.push(bar);
  return { c, bar };
}

function pointer(type: string, target: Element, clientY: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY, button: 0 });
  Object.assign(event, { pointerId: 1, pointerType: 'mouse' });
  target.dispatchEvent(event);
}

function wheel(target: Element, deltaY: number) {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
  target.dispatchEvent(event);
  return event;
}

const visible = (bar: OverlayScrollbar) => bar.pill.style.opacity === '1';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const bar of bars) bar.destroy();
  bars = [];
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('OverlayScrollbar', () => {
  it('sits right after the area, hidden from assistive technology, and goes with destroy()', () => {
    const { c, bar } = area();
    expect(c.nextElementSibling).toBe(bar.el);
    expect(bar.el.getAttribute('aria-hidden')).toBe('true');
    expect(bar.el.querySelector('[tabindex]')).toBeNull();
    expect(bar.el.style).toMatchObject({ left: '20px', top: '30px', width: '400px', height: '300px' });
    bar.destroy();
    expect(bar.el.isConnected).toBe(false);
  });

  it('only appears when the content overflows and the track is long enough', () => {
    expect(area({ height: 300 }).bar.can).toBe(false);
    expect(area().bar.can).toBe(true);
    const short = area();
    geometry(short.c, { offsetHeight: 80, clientHeight: 80 });
    short.bar.layout();
    // Track 80 − 2 × 10 − 4 = 56 px is not longer than 48 + 16 px.
    expect(short.bar.can).toBe(false);
  });

  it('insets the track by the corner radius of the area', () => {
    const { bar } = area({ radius: 32 });
    const rail = bar.el.firstElementChild as HTMLElement;
    // max(10, 32 × 0.85) = 27 at both ends.
    expect(rail.style.top).toBe('27px');
    expect(rail.style.height).toBe('246px');
    expect(area().bar.el.firstElementChild).toHaveProperty('style.top', '10px');
  });

  it('shows a 5 px thumb on hover over the area and the minimum length of 48 px', () => {
    const { c, bar } = area({ height: 30000 });
    expect(visible(bar)).toBe(false);
    c.dispatchEvent(new MouseEvent('mouseenter'));
    expect(visible(bar)).toBe(true);
    expect(bar.pill.style.width).toBe('5px');
    expect(bar.pill.style.backgroundColor).toContain('26%');
    expect(bar.thumb.style.height).toBe('48px');
    expect(bar.track.style.opacity).toBe('0');
    c.dispatchEvent(new MouseEvent('mouseleave'));
    expect(visible(bar)).toBe(false);
  });

  it('shows while scrolling and hides 1200 ms after the last scroll', () => {
    const { c, bar } = area();
    c.scrollTop = 450;
    c.dispatchEvent(new Event('scroll'));
    expect(visible(bar)).toBe(true);
    // Thumb 276 × 300 / 1200 = 69 px; offset (276 − 69) × 450 / 900.
    expect(bar.thumb.style.top).toBe(`${2 + 103.5}px`);
    vi.advanceTimersByTime(1199);
    expect(visible(bar)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(visible(bar)).toBe(false);
  });

  it('turns active in the hit zone: 10 px wide, track and grip lines', () => {
    const { bar } = area();
    expect(bar.zone.style.width).toBe('20px');
    bar.zone.dispatchEvent(new MouseEvent('mouseenter'));
    expect(bar.pill.style.width).toBe('10px');
    expect(bar.pill.style.backgroundColor).toContain('36%');
    expect(bar.pill.style.transition).toContain('width 320ms cubic-bezier(0.34, 1.45, 0.64, 1)');
    expect(bar.track.style.opacity).toBe('1');
    expect(bar.track.style.backgroundColor).toContain('6%');
    expect(bar.grip.style.opacity).toBe('0.55');
    bar.hit.dispatchEvent(new MouseEvent('mouseenter'));
    expect(bar.pill.style.backgroundColor).toContain('50%');
    expect(bar.grip.style.opacity).toBe('0.85');
  });

  it('jumps to a click in the zone', () => {
    const { c, bar } = area();
    // Track from 10 + 2 px, thumb 69 px centred on the click: (138 − 34.5) / 207 of 900 px.
    pointer('pointerdown', bar.zone, 12 + 138);
    expect(c.scrollTop).toBe(450);
    pointer('pointerup', bar.zone, 150);
    expect(bar.drag).toBe(false);
  });

  it('scrolls while dragging the thumb, in the accent colour with a ring', () => {
    const { c, bar } = area();
    pointer('pointerdown', bar.hit, 12 + 10);
    expect(bar.drag).toBe(true);
    expect(c.scrollTop).toBe(0);
    expect(bar.pill.style.backgroundColor).toBe('var(--acc)');
    expect(bar.pill.style.boxShadow).toContain('0 0 0 3px');
    pointer('pointermove', bar.hit, 12 + 10 + 207);
    expect(c.scrollTop).toBe(900);
    pointer('pointerup', bar.hit, 0);
    expect(bar.drag).toBe(false);
    expect(visible(bar)).toBe(true);
    vi.advanceTimersByTime(SCROLLBAR.desk.hide);
    expect(visible(bar)).toBe(false);
  });

  it('names the section while dragging when there are at least two headings', () => {
    const one = area({ headings: ['Only'] });
    pointer('pointerdown', one.bar.hit, 20);
    expect(one.bar.label.style.opacity).toBe('0');

    const { c, bar } = area({ headings: ['Profile', 'Security'] });
    // The second heading lies 500 px down, below 30 % of the view.
    const second = c.querySelectorAll('h2')[1] as HTMLElement;
    second.getBoundingClientRect = () => DOMRect.fromRect({ y: 500, height: 20 });
    pointer('pointerdown', bar.hit, 20);
    expect(bar.label.style.opacity).toBe('1');
    expect(bar.label.textContent).toBe('Profile');
    expect(bar.label.style.font).toContain('13px');
    pointer('pointermove', bar.hit, 20 + 207);
    c.dispatchEvent(new Event('scroll'));
    expect(bar.label.textContent).toBe('Security');
    pointer('pointerup', bar.hit, 20);
    expect(bar.label.style.opacity).toBe('0');
  });

  it('squashes the thumb with the wheel at the start and springs back in 520 ms', () => {
    const { c, bar } = area();
    wheel(c, 40);
    expect(bar.thumb.style.transform).toBe('');
    wheel(c, -90);
    expect(bar.thumb.style.transformOrigin).toBe('50% 0px');
    expect(bar.thumb.style.transform).toBe(`scaleY(${1 - 0.1})`);
    vi.advanceTimersByTime(110);
    expect(bar.thumb.style.transform).toBe('none');
    expect(bar.thumb.style.transition).toBe('transform 520ms cubic-bezier(0.34, 1.56, 0.64, 1)');
  });

  it('squashes at most to scaleY(.76) at the end', () => {
    const { c, bar } = area();
    c.scrollTop = 900;
    for (let i = 0; i < 5; i++) wheel(c, 120);
    expect(bar.thumb.style.transformOrigin).toBe('50% 100%');
    expect(bar.thumb.style.transform).toBe('scaleY(0.76)');
  });

  it('scrolls the area with the wheel over the bar', () => {
    const { c, bar } = area();
    const event = wheel(bar.zone, 100);
    expect(event.defaultPrevented).toBe(true);
    expect(c.scrollTop).toBe(100);
  });

  it('leaves Ctrl + wheel over the bar to the browser zoom', () => {
    const { c, bar } = area();
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100, ctrlKey: true });
    bar.zone.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(c.scrollTop).toBe(0);
  });

  it('springs back without a transition when animations turn off during the squash', () => {
    let motion = true;
    const parent = document.createElement('div');
    const c = document.createElement('div');
    parent.append(c);
    document.body.append(parent);
    geometry(c, { offsetWidth: 400, offsetHeight: 300, clientHeight: 300, scrollHeight: 1200, scrollTop: 0 });
    const bar = new OverlayScrollbar(c, { profile: () => 'desk', motion: () => motion });
    bars.push(bar);
    wheel(c, -90);
    motion = false;
    vi.advanceTimersByTime(110);
    expect(bar.thumb.style.transform).toBe('none');
    expect(bar.thumb.style.transition).toBe('none');
  });

  it('keeps dragging consistent when the area resizes mid-drag', () => {
    const { c, bar } = area();
    pointer('pointerdown', bar.hit, 12 + 10);
    // Taller view: track 576 px, thumb 576 × 600 / 1200 = 288 px, 300 px left to scroll.
    geometry(c, { offsetHeight: 600, clientHeight: 600 });
    bar.layout();
    pointer('pointermove', bar.hit, 12 + 10 + 2);
    expect(c.scrollTop).toBeCloseTo((2 / 288) * 600);
  });

  it('notices overflow from content added deeper down', async () => {
    const { c, bar } = area({ height: 300 });
    const child = document.createElement('div');
    c.append(child);
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    expect(bar.can).toBe(false);
    geometry(c, { scrollHeight: 1200 });
    child.append(document.createElement('p'));
    await Promise.resolve();
    vi.advanceTimersByTime(20);
    expect(bar.can).toBe(true);
  });

  it('has no transitions and no squash with animations off', () => {
    const { c, bar } = area({ motion: false });
    c.dispatchEvent(new MouseEvent('mouseenter'));
    expect(bar.pill.style.transition).toBe('none');
    expect(bar.track.style.transition).toBe('none');
    wheel(c, -90);
    expect(bar.thumb.style.transform).toBe('');
  });

  it('uses the tablet profile: wider zone, 44 px minimum, no hover, hides after 1000 ms', () => {
    const { c, bar } = area({ profile: 'tab', height: 30000 });
    expect(bar.zone.style.width).toBe('30px');
    expect(bar.thumb.style.height).toBe('44px');
    c.dispatchEvent(new MouseEvent('mouseenter'));
    expect(visible(bar)).toBe(false);
    c.dispatchEvent(new Event('scroll'));
    expect(visible(bar)).toBe(true);
    expect(bar.pill.style.backgroundColor).toContain('40%');
    vi.advanceTimersByTime(999);
    expect(visible(bar)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(visible(bar)).toBe(false);
  });

  it('shows no bar on mobile', () => {
    const { c, bar } = area({ profile: 'mob' });
    expect(bar.el.style.display).toBe('none');
    c.dispatchEvent(new Event('scroll'));
    expect(visible(bar)).toBe(false);
  });

  it('stays above a popover with a z-index', () => {
    const { c, bar } = area();
    c.style.position = 'absolute';
    c.style.zIndex = '30';
    bar.layout();
    expect(bar.el.style.zIndex).toBe('31');
  });
});
