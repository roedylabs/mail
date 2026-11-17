import { MOBILE_BP } from '@roedy/tokens';
import { afterEach, describe, expect, it } from 'vitest';
import { scrollbarProfile } from '#lib/actions/scrollbar.ts';
import { layoutOf, Ui, ui } from '#lib/state/ui.svelte.ts';

const original = {
  matchMedia: Object.getOwnPropertyDescriptor(window, 'matchMedia'),
  innerWidth: window.innerWidth,
};

/** Window with this width, primary pointer and orientation; a new `Ui` reads it. */
function device(width: number, { coarse = false, portrait = false } = {}): Ui {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string): MediaQueryList =>
      ({
        matches: (query === '(pointer: coarse)' && coarse) || (query === '(orientation: portrait)' && portrait),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  });
  return new Ui(() => 0);
}

afterEach(() => {
  if (original.matchMedia) Object.defineProperty(window, 'matchMedia', original.matchMedia);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: original.innerWidth });
});

describe('layoutOf', () => {
  it('is mobile below the breakpoint, whatever the pointer', () => {
    expect(layoutOf(MOBILE_BP - 1, false, false)).toBe('mobile');
    expect(layoutOf(MOBILE_BP - 1, true, true)).toBe('mobile');
  });

  it('keeps the desktop layout with a fine pointer, even in portrait', () => {
    expect(layoutOf(MOBILE_BP, false, false)).toBe('desktop');
    expect(layoutOf(820, false, true)).toBe('desktop');
  });

  it('detects a tablet by a coarse primary pointer from the breakpoint on, in landscape and portrait', () => {
    expect(layoutOf(MOBILE_BP, true, false)).toBe('landscape');
    expect(layoutOf(1180, true, false)).toBe('landscape');
    expect(layoutOf(820, true, true)).toBe('portrait');
  });
});

describe('Ui on a tablet', () => {
  it('detects landscape and portrait and turns on the swipe gestures', () => {
    const land = device(1180, { coarse: true });
    expect(land.layout).toBe('landscape');
    expect(land.isTablet).toBe(true);
    expect(land.isPortrait).toBe(false);
    expect(land.swipeOn).toBe(true);

    const port = device(820, { coarse: true, portrait: true });
    expect(port.layout).toBe('portrait');
    expect(port.isTablet).toBe(true);
    expect(port.isPortrait).toBe(true);
  });

  it('is no tablet with a mouse or in the mobile layout', () => {
    const desk = device(1180);
    expect(desk.isTablet).toBe(false);
    expect(desk.swipeOn).toBe(false);

    const phone = device(390, { coarse: true, portrait: true });
    expect(phone.isTablet).toBe(false);
    expect(phone.isMobile).toBe(true);
    expect(phone.swipeOn).toBe(true);
  });

  it('starts expanded in landscape, also below the narrow desktop width', () => {
    const land = device(900, { coarse: true });
    expect(land.collapsed).toBe(false);
    land.toggleSidebar();
    expect(land.collapsed).toBe(true);
    land.toggleSidebar();
    expect(land.collapsed).toBe(false);
  });

  it('keeps the desktop state apart from the landscape state', () => {
    expect(device(900).collapsed).toBe(true);
    expect(device(1400).collapsed).toBe(false);
  });

  it('keeps the sidebar narrow in portrait; "Sidebar" opens the drawer in the mailbox', () => {
    const port = device(820, { coarse: true, portrait: true });
    expect(port.collapsed).toBe(true);
    expect(port.drawer).toBe(false);
    port.toggleSidebar(true);
    expect(port.drawer).toBe(true);
    expect(port.collapsed).toBe(true);
    port.toggleSidebar(true);
    expect(port.drawer).toBe(false);
  });

  it('collapses the settings navigation in portrait instead, expanded at start', () => {
    const port = device(820, { coarse: true, portrait: true });
    expect(port.navCollapsed).toBe(false);
    port.toggleSidebar(false);
    expect(port.navCollapsed).toBe(true);
    expect(port.drawer).toBe(false);
    port.toggleSidebar(false);
    expect(port.navCollapsed).toBe(false);
  });

  it('lets the settings navigation follow the sidebar outside portrait', () => {
    const land = device(1180, { coarse: true });
    land.toggleSidebar(false);
    expect(land.collapsed).toBe(true);
    expect(land.navCollapsed).toBe(true);
  });

  it('stays narrow in portrait when the appearance setting expands the sidebar', () => {
    const port = device(820, { coarse: true, portrait: true });
    port.collapsed = false;
    expect(port.collapsed).toBe(true);
    port.collapsed = true;
    expect(port.collapsed).toBe(true);
  });

  it('closes the drawer on sign-out', () => {
    const port = device(820, { coarse: true, portrait: true });
    port.toggleSidebar(true);
    port.reset();
    expect(port.drawer).toBe(false);
  });
});

describe('scrollbarProfile', () => {
  it('uses the desktop profile without a tablet', () => {
    expect(ui.isTablet).toBe(false);
    expect(scrollbarProfile()).toBe(ui.isMobile ? 'mob' : 'desk');
  });
});
