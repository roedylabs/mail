/**
 * Sizes of the recovery codes card per height level, shared by the setup's step 6 and the invitation's step 4.
 */

/** Height of a code row, size of the codes, padding and gap of the card (px); `cols3` three columns if there is room. */
export interface CodesLevel {
  rowH: number;
  fs: number;
  cbPad: number;
  cbGap: number;
  cols3: boolean;
}

const x = (rowH: number, fs: number, cbPad: number, cbGap: number, cols3 = false): CodesLevel => ({
  rowH,
  fs,
  cbPad,
  cbGap,
  cols3,
});

/** Desktop levels 0–6: rows 42/40/36/34/32/30/28 px, three columns only at the densest one. */
export const CODES_DESK: readonly CodesLevel[] = [
  x(42, 15, 14, 8),
  x(40, 15, 12, 7),
  x(36, 14.5, 12, 6),
  x(34, 14, 10, 6),
  x(32, 14, 10, 5),
  x(30, 13.5, 8, 5),
  x(28, 13.5, 8, 4, true),
];

/** Mobile levels 0–3: rows 38/36/32/30 px. */
export const CODES_MOB: readonly CodesLevel[] = [
  x(38, 14.5, 12, 6),
  x(36, 14, 10, 6),
  x(32, 13.5, 10, 5),
  x(30, 13.5, 8, 4),
];
