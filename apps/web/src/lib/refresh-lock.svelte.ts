/**
 * "Refresh" of the mailbox list: a click turns the icon two more revolutions
 * (+720°) and locks the button for a fixed time, 900 ms, or 500 ms with motion
 * off. The lock does not wait for the response of the mail server; clicks
 * while it runs do nothing and add no further turn.
 */

/** Lock after a click in ms, with motion. */
export const REFRESH_LOCK_MS = 900;
/** Lock after a click in ms, with motion off (setting "Animations" or reduced motion in the system). */
export const REFRESH_LOCK_STILL_MS = 500;
/** Turn of the icon per refresh in degrees. */
export const REFRESH_TURN = 720;

export class RefreshLock {
  /** Locked: a click does nothing. */
  locked = $state(false);
  /** Angle of the icon. */
  rot = $state(0);

  /**
   * Locks and turns the icon. Returns a promise that resolves when the lock
   * ends, or `null` if the button is still locked.
   */
  press(motion: boolean): Promise<void> | null {
    if (this.locked) return null;
    this.locked = true;
    this.rot += REFRESH_TURN;
    return new Promise((done) => {
      setTimeout(
        () => {
          this.locked = false;
          done();
        },
        motion ? REFRESH_LOCK_MS : REFRESH_LOCK_STILL_MS,
      );
    });
  }
}
