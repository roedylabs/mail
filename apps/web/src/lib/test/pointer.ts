/**
 * Pointer events for tests of the swipe gestures (`#lib/swipe.ts`) in jsdom.
 * Not a test file: imported by `swipe.test.ts` and the tests of the message
 * lists.
 */

/** Pointer event like from the browser (touch); jsdom does not know `PointerEvent` everywhere. */
export function pointer(type: string, x: number, y: number, target: EventTarget = window): void {
  const e = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, button: 0 });
  Object.assign(e, { pointerId: 1, isPrimary: true, pointerType: 'touch' });
  target.dispatchEvent(e);
}

/**
 * Swipes `target` horizontally by `dx`: press at (150, 40), decided as a
 * gesture after 10 px, then `dx` further; `during` runs before releasing.
 * Then a click into empty space that the gesture swallows (`swallowClick`, up
 * to 300 ms), so that later clicks of the test arrive.
 */
export function swipe(target: Element, dx: number, during?: () => void): void {
  const x = 150 + Math.sign(dx) * 10;
  pointer('pointerdown', 150, 40, target);
  pointer('pointermove', x, 40);
  pointer('pointermove', x + dx, 40);
  try {
    during?.();
  } finally {
    // Release even after a failed expectation, otherwise the gesture blocks the following tests.
    pointer('pointerup', x + dx, 40);
    window.dispatchEvent(new MouseEvent('click'));
  }
}
