/**
 * Shake on rejected input on the guest pages (setup, sign-in and
 * invitation): card sideways, tile of the graphic rotated. Uses Web
 * Animations; the CSS rule for "animations off" does not cover it, hence
 * the check here.
 */
import { prefs } from '#lib/state/prefs.svelte.ts';

export function shake(card: HTMLElement | undefined, tile: HTMLElement | undefined): void {
  if (!prefs.motion) return;
  card?.animate?.(
    [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-10px)' },
      { transform: 'translateX(8px)' },
      { transform: 'translateX(-5px)' },
      { transform: 'translateX(3px)' },
      { transform: 'translateX(0)' },
    ],
    { duration: 460, easing: 'ease-out' },
  );
  tile?.animate?.(
    [
      { transform: 'rotate(0)' },
      { transform: 'rotate(-9deg)' },
      { transform: 'rotate(7deg)' },
      { transform: 'rotate(-4deg)' },
      { transform: 'rotate(0)' },
    ],
    { duration: 560, easing: 'ease-out' },
  );
}
