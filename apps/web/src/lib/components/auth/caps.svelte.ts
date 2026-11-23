/**
 * Caps Lock in the password fields of a guest page (`PasswordField`), known
 * only from key events (`#lib/caps-lock.ts`). The page's password fields
 * share what they learnt: moving the focus to the other password field keeps
 * it, leaving them forgets it.
 */
import { MediaQuery } from 'svelte/reactivity';
import { CAPS_OFF, type CapsState } from '#lib/caps-lock.ts';

/** What the last key event said, and the field that has the focus. */
export const caps = $state<{ state: CapsState; at: string | null }>({ state: CAPS_OFF, at: null });
/** A phone's or tablet's on-screen keyboard has no Caps Lock (its shift shows the state itself). */
let coarse: MediaQuery | undefined;

/** Id of the focused password field while Caps Lock is on (physical keyboard), otherwise `null`. */
export function capsLockAt(): string | null {
  coarse ??= new MediaQuery('(pointer: coarse)');
  return caps.state.on && !coarse.current ? caps.at : null;
}
