/**
 * Caps Lock state of a password field, known only from key events.
 *
 * Any other key reports it reliably (`getModifierState`). The Caps Lock key
 * itself does not: on Linux its own keydown and keyup still report the old
 * state, so a press toggles the known state instead. macOS sends only a
 * keydown when it turns on and only a keyup when it turns off, so a keyup
 * without a keydown before it means off. Any other key ends a press of
 * Caps Lock (macOS sends no keyup after the keydown that turns it on).
 */

/** The parts of a `KeyboardEvent` the state needs. */
export interface CapsKeyEvent {
  key: string;
  type: string;
  repeat: boolean;
  getModifierState(key: string): boolean;
}

export interface CapsState {
  on: boolean;
  /** A Caps Lock keydown was seen and its keyup is still to come. */
  down: boolean;
}

export const CAPS_OFF: CapsState = { on: false, down: false };

/** State after the key event `e`. */
export function capsAfter(state: CapsState, e: CapsKeyEvent): CapsState {
  if (e.key === 'CapsLock') {
    if (e.type === 'keydown') return e.repeat ? state : { on: !state.on, down: true };
    return { on: state.down ? state.on : false, down: false };
  }
  return { on: e.getModifierState('CapsLock'), down: false };
}
