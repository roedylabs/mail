import { afterEach, describe, expect, it, vi } from 'vitest';
import { autofocus } from './autofocus.ts';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function field() {
  const el = document.createElement('input');
  document.body.append(el);
  return { el, focus: vi.spyOn(el, 'focus') };
}

describe('autofocus', () => {
  it('focuses by default and with `true`, scrolling as the browser does', () => {
    for (const on of [undefined, true]) {
      const { el, focus } = field();
      autofocus(el, on);
      expect(el).toHaveFocus();
      expect(focus).toHaveBeenCalledExactlyOnceWith(undefined);
    }
  });

  it('leaves the focus alone with `false` or `on: false`', () => {
    for (const opts of [false, { on: false, preventScroll: true }]) {
      const { el, focus } = field();
      autofocus(el, opts);
      expect(el).not.toHaveFocus();
      expect(focus).not.toHaveBeenCalled();
    }
  });

  it('focuses without scrolling with `preventScroll`', () => {
    const { el, focus } = field();
    autofocus(el, { on: true, preventScroll: true });
    expect(el).toHaveFocus();
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });

  it('focuses when only `preventScroll` is given', () => {
    const { el, focus } = field();
    autofocus(el, { preventScroll: true });
    expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
  });
});
