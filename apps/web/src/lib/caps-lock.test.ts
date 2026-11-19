import { describe, expect, it } from 'vitest';
import { CAPS_OFF, capsAfter, type CapsKeyEvent, type CapsState } from './caps-lock.ts';

/** A key event; `mod` is what `getModifierState('CapsLock')` reports. */
function ev(type: 'keydown' | 'keyup', key: string, mod: boolean, repeat = false): CapsKeyEvent {
  return { type, key, repeat, getModifierState: (k) => k === 'CapsLock' && mod };
}

function run(events: CapsKeyEvent[], start: CapsState = CAPS_OFF): boolean[] {
  let state = start;
  return events.map((e) => (state = capsAfter(state, e)).on);
}

describe('Caps Lock', () => {
  it('takes the state from any other key', () => {
    expect(run([ev('keydown', 'a', true), ev('keyup', 'a', true), ev('keydown', 'b', false)])).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('toggles on the Caps Lock key itself (Linux reports the old state on its own events)', () => {
    expect(
      run([
        ev('keydown', 'CapsLock', false),
        ev('keyup', 'CapsLock', false),
        ev('keydown', 'CapsLock', true),
        ev('keyup', 'CapsLock', true),
      ]),
    ).toEqual([true, true, false, false]);
  });

  it('follows macOS: keydown only when it turns on, keyup only when it turns off', () => {
    expect(
      run([
        ev('keydown', 'CapsLock', true),
        ev('keydown', 'A', true),
        ev('keyup', 'A', true),
        ev('keyup', 'CapsLock', false),
      ]),
    ).toEqual([true, true, true, false]);
    // On from an earlier key, then turned off: only the keyup arrives.
    expect(run([ev('keydown', 'A', true), ev('keyup', 'CapsLock', false)])).toEqual([true, false]);
  });

  it('ignores a repeated keydown', () => {
    expect(run([ev('keydown', 'CapsLock', false), ev('keydown', 'CapsLock', false, true)])).toEqual([true, true]);
  });
});
