/**
 * Values of the settings with a fixed choice, as stored and sent over
 * `/api/v1`: English identifiers, countries as ISO 3166-1 alpha-2. The
 * single source for the `Settings` types, the options of the pages and
 * `knownSettings`; without imports of app modules, so that `prefs`,
 * `devlog` and the pages can all read it without an import cycle.
 */
import type { DensityName, FontSizeName } from '@roedy/tokens';

export const MODES = ['light', 'dark', 'system'] as const;
export const FONT_SIZES = ['small', 'medium', 'large'] as const satisfies readonly FontSizeName[];
export const DENSITIES = ['compact', 'normal', 'comfortable'] as const satisfies readonly DensityName[];
export const PF_DESIGNS = ['soft', 'compact'] as const;
export const REGIONS = ['DE', 'AT', 'CH', 'FR', 'IT', 'NL', 'ES', 'GB', 'US'] as const;
export const TIME_FMTS = ['24h', '12h'] as const;
export const WEEK_STARTS = ['monday', 'sunday'] as const;
export const START_OPTS = ['inbox', 'last'] as const;
/** In the order of the segment. */
export const EXT_MODES = ['ask', 'always', 'never'] as const;
export const DIGEST_OPTS = ['instant', 'daily', 'weekly'] as const;
/** Most to least important; the chosen level shows itself and all before it. */
export const LOG_LEVELS = ['error', 'warning', 'info', 'debug'] as const;
