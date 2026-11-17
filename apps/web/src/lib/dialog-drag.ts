/**
 * Dragging the dialogs of the desktop layout down to close them
 * (`dragSheet` in `#lib/swipe.ts`): the dialog lies inside its backdrop.
 */
import type { Attachment } from 'svelte/attachments';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { dragSheet } from '#lib/swipe.ts';

/**
 * Only on a tablet (coarse primary pointer without the mobile layout,
 * `ui.swipeOn`) and as a sheet on mobile, not with a mouse on the desktop;
 * `can` turns it off for a layer that its backdrop does not close either.
 */
export const dialogDrag = (can: () => boolean = () => true): Attachment<HTMLElement> =>
  dragSheet(() => (ui.swipeOn && can() ? { animations: prefs.motion } : null));
