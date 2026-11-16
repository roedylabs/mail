import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCENTS, DEFAULT_ACCENT, DEFAULT_MODE, MODES, renderTokensCss } from './index.ts';

describe('tokens.css', () => {
  it('matches the TypeScript constants (otherwise: pnpm --filter @roedy/tokens build)', () => {
    const onDisk = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');
    expect(onDisk).toBe(renderTokensCss());
  });

  it('contains every mode token with its value', () => {
    const css = renderTokensCss();
    for (const mode of Object.values(MODES)) {
      for (const [name, value] of Object.entries(mode)) {
        expect(css).toContain(`${name}: ${value};`);
      }
    }
  });

  it('applies the defaults without an attribute on <html>', () => {
    const css = renderTokensCss();
    expect(css).toContain(`:root,\n:root[data-mode='${DEFAULT_MODE}'] {\n  --cnv: ${MODES[DEFAULT_MODE]['--cnv']};`);
    expect(css).toContain(
      `:root,\n:root[data-accent='${DEFAULT_ACCENT}'] {\n  --acc: ${ACCENTS[DEFAULT_ACCENT].base};`,
    );
  });

  it('switches via prefers-color-scheme in system mode', () => {
    expect(renderTokensCss()).toMatch(
      /@media \(prefers-color-scheme: light\) \{\n {2}:root\[data-mode='system'\] \{\n {4}--cnv: #f3eee7;/,
    );
  });
});

describe('animations off', () => {
  it('turns off all animations and transitions', () => {
    expect(renderTokensCss()).toContain(
      ":root[data-animations='off'] *::after {\n  animation: none !important;\n  transition: none !important;\n}",
    );
  });

  it('also applies with the system setting "reduce motion"', () => {
    const css = renderTokensCss();
    expect(css).toContain('@media (prefers-reduced-motion: reduce) {\n  :root {\n    --dur: 0ms;');
    expect(css).toContain(
      '  :root *::after {\n    animation: none !important;\n    transition: none !important;\n  }\n}',
    );
  });
});

describe('constants', () => {
  it('have the same token names in both modes', () => {
    expect(Object.keys(MODES.dark)).toEqual(Object.keys(MODES.light));
  });
});
