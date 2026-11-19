/**
 * Colour editor for a custom accent ("More colors"): 18 preset colours, a
 * field for any hex code with validation and contrast hints, and where the
 * desktop popover goes. Shared by the setup wizard and Settings ›
 * Appearance; the markup is `#lib/components/ColorEditor.svelte`.
 */
import { contrast, parseHex, type HexColor } from '#lib/color.ts';
import { m } from '#lib/paraglide/messages.js';

/** The preset colours, six per row: in the palette's soft tone, each standing out in both themes. */
export const PRESETS = [
  ['coral', '#f08a7e'],
  ['honey', '#ecb655'],
  ['lemon', '#cbbd4a'],
  ['lime', '#a8c65e'],
  ['mint', '#78c895'],
  ['jade', '#68c7ae'],
  ['turquoise', '#66c3cc'],
  ['cornflower', '#8ea6ee'],
  ['lilac', '#c3a0ee'],
  ['orchid', '#d99ae3'],
  ['fuchsia', '#ec90cb'],
  ['raspberry', '#e8798f'],
  ['sand', '#cdb48e'],
  ['mocha', '#bc9c85'],
  ['moss', '#a5b386'],
  ['slate', '#a0adbb'],
  ['dove', '#b5aac3'],
  ['pebble', '#bfb8ad'],
] as const satisfies readonly (readonly [string, HexColor])[];

export type PresetName = (typeof PRESETS)[number][0];

/** Columns of the preset grid (arrow keys up and down move by a row). */
export const GRID_COLS = 6;

const PRESET_LABELS: Record<PresetName, () => string> = {
  coral: m.color_coral,
  honey: m.color_honey,
  lemon: m.color_lemon,
  lime: m.color_lime,
  mint: m.color_mint,
  jade: m.color_jade,
  turquoise: m.color_turquoise,
  cornflower: m.color_cornflower,
  lilac: m.color_lilac,
  orchid: m.color_orchid,
  fuchsia: m.color_fuchsia,
  raspberry: m.color_raspberry,
  sand: m.color_sand,
  mocha: m.color_mocha,
  moss: m.color_moss,
  slate: m.color_slate,
  dove: m.color_dove,
  pebble: m.color_pebble,
};

export function presetLabel(name: PresetName): string {
  return PRESET_LABELS[name]();
}

/** The preset with this colour. */
export function presetOf(hex: HexColor): PresetName | undefined {
  return PRESETS.find(([, x]) => x === hex)?.[0];
}

/** Name of a custom accent: the preset's name, otherwise "Custom #RRGGBB". */
export function customName(hex: HexColor): string {
  const preset = presetOf(hex);
  return preset ? presetLabel(preset) : m.color_custom({ hex: hex.toUpperCase() });
}

/** Surfaces of the dark and the light theme (`--surface`). */
export const SURFACE_DARK: HexColor = '#221d19';
export const SURFACE_LIGHT: HexColor = '#fffdfa';
/** Below this contrast to a surface a colour is barely visible there. */
export const LOW_CONTRAST = 1.6;

/** Theme in which `hex` is barely visible (the dark one first), `null` if it stands out in both. */
export function lowContrast(hex: HexColor): 'dark' | 'light' | null {
  if (contrast(hex, SURFACE_DARK) < LOW_CONTRAST) return 'dark';
  if (contrast(hex, SURFACE_LIGHT) < LOW_CONTRAST) return 'light';
  return null;
}

/**
 * Index the preset grid moves to from `i` of `n` with `key`: arrows by one
 * and by a row (stopping at the ends), Home and End to the ends; `null` for
 * other keys.
 */
export function gridMove(key: string, i: number, n: number, cols = GRID_COLS): number | null {
  if (key === 'Home') return 0;
  if (key === 'End') return n - 1;
  const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[key];
  return step === undefined ? null : Math.max(0, Math.min(n - 1, i + step));
}

/** Message under the hex field: invalid input, or barely visible in a theme. */
export type HexNote = 'invalid' | 'dark' | 'light' | null;

/**
 * Draft of the editor: the colour shown (swatch, "Apply") and the field's
 * text. Invalid text keeps the last valid colour; the error shows once the
 * field was left or "Apply" was pressed (`touched`).
 */
export class ColorDraft {
  hex = $state<HexColor>('#f5a06e');
  text = $state('');
  touched = $state(false);

  constructor(start: HexColor) {
    this.hex = start;
    this.text = start.toUpperCase();
  }

  /** The field's colour, `null` while the text is no hex code. */
  parsed = $derived(parseHex(this.text));
  valid = $derived(this.parsed !== null);
  note = $derived.by((): HexNote => {
    if (this.touched && !this.valid) return 'invalid';
    return this.parsed ? lowContrast(this.parsed) : null;
  });

  /** A preset from the grid. */
  pick(hex: HexColor): void {
    this.hex = hex;
    this.text = hex.toUpperCase();
    this.touched = false;
  }

  /** Typing in the field (at most `#` and six digits). */
  input(value: string): void {
    this.text = value.slice(0, 7);
    if (this.parsed) this.hex = this.parsed;
  }

  /** Leaving the field: a valid code in its full form (`#RRGGBB`). */
  blur(): void {
    this.touched = true;
    if (this.parsed) this.text = this.parsed.toUpperCase();
  }

  /** "Apply": the colour, or `null` (shows the error) while the text is no hex code. */
  apply(): HexColor | null {
    if (this.parsed) return this.parsed;
    this.touched = true;
    return null;
  }
}

/** Where the desktop popover goes inside its container. */
export interface Placement {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  /** Transform origin of the pop-in: the corner at the swatch. */
  origin: string;
}

const EDGE = 12;
const GAP = 10;
const MAX_W = 340;

/**
 * Popover at the swatch `anchor` (relative to the container `box`), with its
 * right edge at the swatch's (6 px over): above it if there is room, else
 * below, else centred vertically; never outside the container (12 px edge).
 * Without a swatch it sits in the middle. `natural` is the popover's height
 * without a limit.
 */
export function placePopover(
  box: { width: number; height: number },
  anchor: { top: number; bottom: number; right: number } | null,
  natural: number,
): Placement {
  const width = Math.round(Math.max(0, Math.min(MAX_W, box.width - 2 * EDGE)));
  const maxHeight = Math.round(Math.max(0, box.height - 2 * EDGE));
  const height = Math.min(natural, maxHeight);
  const above = !!anchor && anchor.top - EDGE >= height + GAP;
  const below = !!anchor && !above && box.height - anchor.bottom - EDGE >= height + GAP;
  const right = anchor ? anchor.right + 6 : (box.width + width) / 2;
  const left = Math.round(Math.max(EDGE, Math.min(box.width - width - EDGE, right - width)));
  const top = Math.round(
    above ? anchor.top - height - GAP : below ? anchor.bottom + GAP : Math.max(EDGE, (box.height - height) / 2),
  );
  return { left, top, width, maxHeight, origin: anchor ? `${below ? 'top' : 'bottom'} right` : 'center' };
}
