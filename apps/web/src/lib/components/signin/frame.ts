/**
 * What every form screen of the sign-in page passes to `AuthShell`: the
 * light/dark button (no step bars), the heads of all screens (the space kept
 * above the overview) and the overview of the sign-in or of the reset.
 */
import type { Overview } from '#lib/components/auth/types.ts';
import type { StepHead } from '#lib/auth-layout.ts';
import { m } from '#lib/paraglide/messages.js';
import { signInHeads } from '#lib/signin-heads.ts';

export interface SignInFrame {
  themeToggle: boolean;
  heads: StepHead[];
  overview: Overview;
}

/**
 * `current`: the screen's item of the overview (from 1); `second`: the middle item ("Code from your app", or
 * "Recovery code" on its screen).
 */
export function signInFrame(current: number, second: string = m.login_flow_code()): SignInFrame {
  return {
    themeToggle: true,
    heads: signInHeads(),
    overview: {
      label: m.login_flow_label(),
      items: [m.login_flow_password(), second, m.login_flow_done()],
      current,
    },
  };
}

/** The screens of "Forgot password": the overview of the reset; `current` its item (from 1). */
export function resetFrame(current: number): SignInFrame {
  return {
    themeToggle: true,
    heads: signInHeads(),
    overview: {
      label: m.login_reset_flow_label(),
      items: [
        m.login_reset_flow_request(),
        m.login_reset_flow_mail(),
        m.login_reset_flow_new(),
        m.login_reset_flow_signin(),
      ],
      current,
    },
  };
}
