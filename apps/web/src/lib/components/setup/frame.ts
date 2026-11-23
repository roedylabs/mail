/**
 * What every setup step passes to `AuthShell`: the seven step bars, the step
 * overview, the heads of all steps (the space kept above the overview) and
 * "Back" from step 2 on.
 */
import type { Back, Bars, Overview } from '#lib/components/auth/types.ts';
import type { StepHead } from '#lib/auth-layout.ts';
import { m } from '#lib/paraglide/messages.js';
import { setupHeads } from '#lib/setup-heads.ts';
import { STEPS, type SetupFlow, type Step } from '#lib/setup.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';

export interface SetupFrame {
  bars: Bars;
  overview: Overview;
  heads: StepHead[];
  back: Back | undefined;
}

export function setupFrame(flow: SetupFlow, step: Step): SetupFrame {
  return {
    bars: { n: step, total: STEPS, label: m.setup_step({ n: step }) },
    overview: {
      label: m.setup_steps_label(),
      items: [
        m.setup_step_prefs(),
        m.setup_step_token(),
        m.setup_step_admin(),
        m.setup_step_password(),
        m.setup_step_mfa(),
        m.setup_step_codes(),
        m.setup_step_review(),
      ],
      current: step,
    },
    heads: setupHeads(session.appName, flow.email.trim()),
    back: flow.canBack ? { label: m.setup_back(), onback: () => flow.back() } : undefined,
  };
}
