import { ACCENTS, derivedAccentVars, MODES, type CssVars, type ModeName } from '@roedy/tokens';
import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Toast from './Toast.svelte';
import SOURCE from './Toast.svelte?raw';
import { TOAST_HOVER } from '#lib/color.ts';
import { contrast, hex, mixOklab, over, type Rgb } from '#lib/test/contrast.ts';

const swipe = { animations: false, hold: () => {}, away: () => {}, back: () => {} };

// Colors of pill and "Undo" from the component's source (`SOURCE`)
function rule(selector: string): string {
  const escaped = selector.replace(/[\\^$.*+?()[\]{}|:]/g, '\\$&');
  const body = new RegExp(`^ {2}${escaped} \\{([^}]*)\\}`, 'm').exec(SOURCE)?.[1];
  if (body === undefined) throw new Error(`Rule ${selector} missing in Toast.svelte`);
  return body;
}

const varOf = (body: string, prop: string) => new RegExp(`${prop}: var\\((--[\\w-]+)\\)`).exec(body)?.[1];

/** Value of a variable for an accent: base value, `var(--acc)` or `color-mix(in oklab, var(--acc) P%, #rrggbb)`. */
function resolve(mode: ModeName, name: string, base: string): Rgb {
  const vars: CssVars = { ...MODES[mode], ...derivedAccentVars(mode), '--acc': 'var(--acc)' };
  const value = vars[name as `--${string}`] ?? '';
  if (value === 'var(--acc)') return hex(base);
  const mix = /^color-mix\(in oklab, var\(--acc\) (\d+)%, (#[0-9a-f]{6})\)$/.exec(value);
  if (mix) return mixOklab(hex(base), hex(mix[2]!), Number(mix[1]) / 100);
  if (/^#[0-9a-f]{6}$/.test(value)) return hex(value);
  throw new Error(`${name} unknown: ${value}`);
}

// WCAG AA 4.5:1 plus a margin for the approximation in `#lib/test/contrast.ts`
const MIN_CONTRAST = 4.6;

describe('Toast', () => {
  it('shows the text and "Undo"', async () => {
    const closeToast = vi.fn();
    const { getByRole } = render(Toast, {
      isMobile: false,
      isPanel: false,
      toastText: 'Device signed out',
      toastUndo: true,
      toastNoUndo: false,
      toastErr: false,
      toastOk: true,
      toastRole: 'status',
      closeToast,
      swipe,
    });
    expect(getByRole('status')).toHaveTextContent('Device signed out');
    await fireEvent.click(getByRole('button', { name: 'Undo' }));
    expect(closeToast).toHaveBeenCalled();
  });

  it('stays in place in the desktop layout (`swipe` null) and "Undo" still works with the mouse', async () => {
    const closeToast = vi.fn();
    const { getByRole } = render(Toast, {
      isMobile: false,
      isPanel: false,
      toastText: 'Message deleted',
      toastUndo: true,
      toastNoUndo: false,
      toastErr: false,
      toastOk: true,
      toastRole: 'status',
      closeToast,
      swipe: null,
    });
    const toast = getByRole('status');
    const at = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
    });
    await fireEvent.pointerDown(toast, at(100, 100));
    await fireEvent.pointerMove(window, at(100, 200));
    await fireEvent.pointerUp(window, at(100, 200));
    expect(toast.style.translate).toBe('');
    await fireEvent.click(getByRole('button', { name: 'Undo' }));
    expect(closeToast).toHaveBeenCalled();
  });

  it('shows notices without undo, on mobile further down in the "Back to …" area', () => {
    const { getByRole, queryByRole } = render(Toast, {
      isMobile: true,
      isPanel: true,
      toastText: 'Calendar coming soon',
      toastUndo: false,
      toastNoUndo: true,
      toastErr: false,
      toastOk: true,
      toastRole: 'status',
      closeToast: () => {},
      swipe,
    });
    expect(queryByRole('button')).toBeNull();
    expect(getByRole('status')).toHaveClass('mobile', 'panel');
  });

  it('sits above the bar "Unsaved changes" and glides there', async () => {
    const props = {
      isMobile: true,
      isPanel: true,
      toastText: 'Please check the highlighted fields',
      toastUndo: false,
      toastNoUndo: true,
      toastErr: false,
      toastOk: true,
      toastRole: 'status' as const,
      closeToast: () => {},
      swipe,
    };
    const { getByRole, rerender } = render(Toast, { ...props, toastLift: true, toastB: '126px' });
    expect(getByRole('status').style.bottom).toBe('126px');
    await rerender({ ...props, toastLift: false, toastB: '' });
    // Without the bar back to the position from the stylesheet (on mobile in the panel 14 px).
    expect(getByRole('status').style.bottom).toBe('');
    expect(rule('.toast')).toMatch(/transition: bottom var\(--dur, 220ms\) ease;/);
  });

  it('reports errors as `alert` with a warning icon and without undo', () => {
    const { getByRole, queryByRole, container } = render(Toast, {
      isMobile: false,
      isPanel: false,
      toastText: 'Change not saved. Please try again.',
      toastUndo: false,
      toastNoUndo: true,
      toastErr: true,
      toastOk: false,
      toastRole: 'alert',
      closeToast: () => {},
      swipe,
    });
    expect(getByRole('alert')).toHaveTextContent('Change not saved.');
    expect(queryByRole('button')).toBeNull();
    expect(container.querySelector('.tile.err')).not.toBeNull();
  });

  it('can be swiped (`data-g="toast"`)', () => {
    const { getByRole } = render(Toast, {
      isMobile: true,
      isPanel: false,
      toastText: 'Moved to Trash',
      toastUndo: true,
      toastNoUndo: false,
      toastErr: false,
      toastOk: false,
      toastRole: 'status',
      closeToast: () => {},
      swipe,
    });
    expect(getByRole('status')).toHaveAttribute('data-g', 'toast');
  });

  describe('contrast of "Undo"', () => {
    const pill = varOf(rule('.toast'), 'background');
    const text = varOf(rule('.undo'), 'color');
    const hover = /background: color-mix\(in oklab, var\(--inkfg\) (\d+(?:\.\d+)?)%, transparent\)/.exec(
      rule('.undo:hover'),
    )?.[1];

    it('sits in `--toastacc` on `--ink`, hover from `--inkfg`', () => {
      expect(pill).toBe('--ink');
      expect(text).toBe('--toastacc');
      expect(hover).toBe('8');
      // Custom accents compute "Undo" for the same hover surface (`accentText()`).
      expect(Number(hover) / 100).toBe(TOAST_HOVER);
      expect(rule('.mobile .undo')).not.toMatch(/color:/);
    });

    for (const mode of ['light', 'dark'] as const) {
      it(`reaches ${MIN_CONTRAST}:1 in ${mode} mode with every accent color, also on hover`, () => {
        for (const [name, { base }] of Object.entries(ACCENTS)) {
          const bg = resolve(mode, pill!, base);
          const fg = resolve(mode, text!, base);
          // `color-mix(…, transparent)` is `--inkfg` with opacity over the pill
          const hovered = over(bg, hex(MODES[mode]['--inkfg']), Number(hover) / 100);
          expect(contrast(fg, bg), name).toBeGreaterThanOrEqual(MIN_CONTRAST);
          expect(contrast(fg, hovered), `${name} (Hover)`).toBeGreaterThanOrEqual(MIN_CONTRAST);
        }
      });
    }
  });
});
