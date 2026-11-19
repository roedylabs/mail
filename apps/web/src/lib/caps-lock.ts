/**
 * Caps Lock state of a password field, known only from key events.
 *
 * Any other key reports it reliably (`getModifierState`). The Caps Lock key
 * itself does not: on Linux its own keydown and keyup still report the old
 * state, so a press toggles the known state instead. macOS sends only a
 * keydown when it turns on and only a keyup when it turns off, so a keyup
 * without a keydown before it means off. That keyup may also follow the
 * keydown that turned it on (nothing typed in between): a keydown that
 * reported on and a keyup that reports off cannot be one press on Linux
 * (both report the old state), so that keyup means off too. Any other key
 * ends a press of Caps Lock.
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
  /** What that keydown reported (`getModifierState`). */
  downMod: boolean;
}

export const CAPS_OFF: CapsState = { on: false, down: false, downMod: false };

/** State after the key event `e`. */
export function capsAfter(state: CapsState, e: CapsKeyEvent): CapsState {
  const mod = e.getModifierState('CapsLock');
  if (e.key === 'CapsLock') {
    if (e.type === 'keydown') return e.repeat ? state : { on: !state.on, down: true, downMod: mod };
    const paired = state.down && !(state.downMod && !mod);
    return { on: paired ? state.on : false, down: false, downMod: false };
  }
  return { on: mod, down: false, downMod: false };
}
