/**
 * What every form screen of the sign-in page passes to `AuthShell`: the
 * light/dark button (no step bars), the heads of all screens (the space kept
 * above the overview) and the overview of the sign-in.
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

/** `current`: the screen's item of the overview (from 1). */
export function signInFrame(current: number): SignInFrame {
  return {
    themeToggle: true,
    heads: signInHeads(),
    overview: {
      label: m.login_flow_label(),
      items: [m.login_flow_password(), m.login_flow_code(), m.login_flow_done()],
      current,
    },
  };
}
