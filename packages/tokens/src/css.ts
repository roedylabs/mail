import {
  ACCENTS,
  DEFAULT_ACCENT,
  DEFAULT_DENSITY,
  DEFAULT_MODE,
  DENSITY,
  FONT_PX,
  FONT_SANS,
  FONT_MONO,
  FONT_SERIF,
  KEYFRAMES,
  MODES,
  MOTION,
  derivedAccentVars,
  type CssVars,
  type ModeName,
} from './tokens.ts';

const HEADER = `/*
 * Roedy Mail design tokens – generated from packages/tokens/src/tokens.ts.
 * Do not edit by hand: pnpm --filter @roedy/tokens build
 *
 * Controlled by attributes on <html>:
 *   data-mode       light | dark | system   (no attribute: ${DEFAULT_MODE})
 *   data-accent     ${Object.keys(ACCENTS).join(' | ')}   (none: ${DEFAULT_ACCENT})
 *   data-density    ${Object.keys(DENSITY).join(' | ')}   (none: ${DEFAULT_DENSITY})
 *   data-font-size  ${Object.keys(FONT_PX).join(' | ')}   (none: browser default)
 *   data-animations off   (also prefers-reduced-motion: reduce)
 */`;

/** Root and all elements including pseudo-elements (animations off). */
const everything = (root: string) => [root, `${root} *`, `${root} *::before`, `${root} *::after`].join(',\n');
const STILL = '  animation: none !important;\n  transition: none !important;';
/** Rule one level deeper, e.g. inside a media query. */
const nested = (css: string) => css.replace(/^/gm, '  ');

const declarations = (vars: CssVars, indent = '  ') =>
  Object.entries(vars)
    .map(([name, value]) => `${indent}${name}: ${value};`)
    .join('\n');

const rule = (selector: string, body: string) => `${selector} {\n${body}\n}`;

const modeBody = (mode: ModeName) =>
  [declarations(MODES[mode]), declarations(derivedAccentVars(mode)), `  color-scheme: ${mode};`].join('\n');

/** Renders the content of `tokens.css`. */
export function renderTokensCss(): string {
  const otherMode: ModeName = DEFAULT_MODE === 'dark' ? 'light' : 'dark';
  const blocks = [
    HEADER,
    rule(
      ':root',
      declarations({
        '--font-sans': FONT_SANS,
        '--font-serif': FONT_SERIF,
        '--font-mono': FONT_MONO,
        '--rowh': `${DENSITY[DEFAULT_DENSITY]}px`,
        ...MOTION.on,
      }),
    ),
    rule(`:root,\n:root[data-mode='${DEFAULT_MODE}']`, modeBody(DEFAULT_MODE)),
    rule(`:root[data-mode='${otherMode}']`, modeBody(otherMode)),
    `@media (prefers-color-scheme: ${otherMode}) {\n${rule(`  :root[data-mode='system']`, modeBody(otherMode).replace(/^/gm, '  ')).replace(/\n}$/, '\n  }')}\n}`,
    ...Object.entries(ACCENTS).map(([name, accent]) =>
      rule(
        name === DEFAULT_ACCENT ? `:root,\n:root[data-accent='${name}']` : `:root[data-accent='${name}']`,
        declarations({ '--acc': accent.base, '--accink': accent.ink }),
      ),
    ),
    ...Object.entries(DENSITY)
      .filter(([name]) => name !== DEFAULT_DENSITY)
      .map(([name, px]) => rule(`:root[data-density='${name}']`, declarations({ '--rowh': `${px}px` }))),
    ...Object.entries(FONT_PX).map(([name, px]) => rule(`:root[data-font-size='${name}']`, `  font-size: ${px};`)),
    rule(`:root[data-animations='off']`, declarations(MOTION.off)),
    // Without animations this applies to all keyframes and transitions, not only those controlled via --dur/--shim/--spin.
    rule(everything(":root[data-animations='off']"), STILL),
    // The system setting "reduce motion" acts like "animations off", even before the settings load.
    `@media (prefers-reduced-motion: reduce) {\n${nested(rule(':root', declarations(MOTION.off)))}\n\n${nested(rule(everything(':root'), STILL))}\n}`,
    ...Object.entries(KEYFRAMES).map(([name, frames]) => `@keyframes ${name} {\n  ${frames}\n}`),
  ];
  return `${blocks.join('\n\n')}\n`;
}
