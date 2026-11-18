import { afterEach, describe, expect, it, vi } from 'vitest';
import { autofocus } from './autofocus.ts';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function field() {
  const el = document.createElement('textarea');
  document.body.append(el);
  return { el, focus: vi.spyOn(el, 'focus') };
}

/** Vertical position on screen. */
const at = (el: Element, top: number, bottom: number) =>
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ y: top, height: bottom - top }));

/**
 * Scroll area 100–400 (300 px visible of 800) with the field at `top` on screen;
 * the field's first line ends 30 px below its top (padding 4 px, line 26 px).
 */
function inArea(top: number) {
  const area = document.createElement('div');
  area.style.overflowY = 'auto';
  Object.defineProperty(area, 'clientHeight', { value: 300 });
  Object.defineProperty(area, 'scrollHeight', { value: 800 });
  area.scrollTop = 0;
  const { el, focus } = field();
  el.style.paddingTop = '4px';
  el.style.lineHeight = '26px';
  area.append(el);
  document.body.append(area);
  at(area, 100, 400);
  at(el, top, top + 300);
  return { area, el, focus };
}

describe('autofocus', () => {
  it('focuses by default and with `true`, scrolling as the browser does', () => {
    for (const on of [undefined, true, { on: true }, { scroll: 'browser' as const }]) {
      const { el, focus } = field();
      autofocus(el, on);
      expect(el).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith();
    }
  });

  it('leaves the focus alone with `false` or `on: false`', () => {
    for (const opts of [false, { on: false, scroll: 'minimal' as const }]) {
      const { el, focus } = field();
      autofocus(el, opts);
      expect(el).not.toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
    }
  });

  it('focuses without scrolling with `scroll: minimal` while the first line is visible', () => {
    const { area, el, focus } = inArea(370);
    autofocus(el, { scroll: 'minimal' });
    expect(el).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(area.scrollTop).toBe(0);
  });

  it('scrolls only as far as the first line with `scroll: minimal` if it is clipped', () => {
    const { area, el } = inArea(450.5);
    autofocus(el, { on: true, scroll: 'minimal' });
    expect(el).toHaveFocus();
    // 450.5 + 30 − 400
    expect(area.scrollTop).toBe(81);
  });

  it('focuses without scrolling with `scroll: minimal` outside a scroll area', () => {
    const { el, focus } = field();
    autofocus(el, { scroll: 'minimal' });
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
});
