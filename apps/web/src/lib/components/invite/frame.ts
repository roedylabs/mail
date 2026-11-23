/**
 * What every screen of the invitation passes to the shell: the four step
 * bars, the step overview, the heads of all steps (the space kept above the
 * overview), the height-fit table and the height levels of step 1 (the
 * shared ones with the rows of the invitation's details).
 */
import type { Bars, Overview } from '#lib/components/auth/types.ts';
import {
  DESK_LEVELS,
  MOB_LEVELS,
  SHARED_FIT,
  type DeskLevel,
  type FitTable,
  type MobLevel,
  type StepHead,
} from '#lib/auth-layout.ts';
import { inviteHeads } from '#lib/invite-heads.ts';
import type { InviteFlow, InviteStep } from '#lib/invite.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { session } from '#lib/state/session.svelte.ts';

export const INVITE_STEPS = 4;

/**
 * Window and card heights per level of the invitation's four steps (`FitTable`): the shared table of the setup and the
 * sign-in, so all four steps start at the same level and card height; a step only goes denser on its own when a
 * message makes it overflow.
 */
export const INVITE_FIT: FitTable = SHARED_FIT;

export interface InviteFrame {
  bars: Bars;
  overview: Overview;
  heads: StepHead[];
}

export function inviteFrame(flow: InviteFlow, step: InviteStep): InviteFrame {
  return {
    bars: { n: step, total: INVITE_STEPS, label: m.invite_step({ n: step }) },
    overview: {
      label: m.invite_steps_label(),
      items: [m.invite_step_invite(), m.invite_step_account(), m.invite_step_mfa(), m.invite_step_codes()],
      current: step,
    },
    heads: inviteHeads(session.appName, flow.info?.inviter || null),
  };
}

/** Rows of the invitation's details: row height and tile size in px per level. */
export interface DetailRows {
  rowH: number;
  tile: number;
}

const DESK_ROWS: DetailRows[] = [
  { rowH: 62, tile: 42 },
  { rowH: 58, tile: 40 },
  { rowH: 54, tile: 38 },
  { rowH: 50, tile: 36 },
  { rowH: 48, tile: 34 },
  { rowH: 46, tile: 32 },
  { rowH: 44, tile: 30 },
];
const MOB_ROWS: DetailRows[] = [
  { rowH: 58, tile: 40 },
  { rowH: 54, tile: 38 },
  { rowH: 50, tile: 36 },
  { rowH: 48, tile: 34 },
];

/** Step 1 (and its loading placeholders): in one column the details start one section gap (`gap`) below the intro. */
export const INVITE_DESK: (DeskLevel & DetailRows)[] = DESK_LEVELS.map((l, i) => ({
  ...l,
  fieldsTop: l.gap,
  ...DESK_ROWS[i]!,
}));
export const INVITE_MOB: (MobLevel & DetailRows)[] = MOB_LEVELS.map((l, i) => ({
  ...l,
  fieldsTop: l.gap,
  ...MOB_ROWS[i]!,
}));

/** Rows of the details at `level` (mobile or desktop). */
export function detailRows(mobile: boolean, level: number): DetailRows {
  const table = mobile ? INVITE_MOB : INVITE_DESK;
  return table[Math.min(level, table.length - 1)]!;
}

/** Previous sizes of the screens that keep their previous content (`LegacyFrame`), at their level (0–3). */
export interface LegacyValues {
  row: string;
  qr: string;
  codeCols: string;
  otpGap: string;
  otpBoxH: string;
}
