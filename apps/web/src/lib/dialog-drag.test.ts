import { afterEach, describe, expect, it, vi } from 'vitest';
import { pointer } from '#lib/test/pointer.ts';
import { dialogDrag } from './dialog-drag.ts';

const ui = vi.hoisted(() => ({ swipeOn: false }));
vi.mock('#lib/state/ui.svelte.ts', () => ({ ui }));

/** Dialog inside its backdrop, dragged down by 150 px and held there. */
function dragged(can?: () => boolean): HTMLElement {
  const scrim = document.createElement('div');
  const el = document.createElement('div');
  scrim.append(el);
  document.body.append(scrim);
  Object.defineProperty(el, 'offsetHeight', { value: 400 });
  dialogDrag(can)(el);
  pointer('pointerdown', 100, 100, el);
  pointer('pointermove', 100, 110);
  pointer('pointermove', 100, 260);
  return el;
}

describe('dialogDrag', () => {
  afterEach(() => {
    pointer('pointerup', 100, 100);
    window.dispatchEvent(new MouseEvent('click'));
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('drags dialogs only on a tablet or mobile, not with a mouse on the desktop', () => {
    vi.useFakeTimers();
    ui.swipeOn = false;
    expect(dragged().style.translate).toBe('');
  });

  it('follows on a tablet', () => {
    vi.useFakeTimers();
    ui.swipeOn = true;
    expect(dragged().style.translate).toBe('0px 150px');
  });

  it('stays put for a layer that its backdrop does not close', () => {
    vi.useFakeTimers();
    ui.swipeOn = true;
    expect(dragged(() => false).style.translate).toBe('');
  });
});
