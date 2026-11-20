import { derivedAccentVars } from '@roedy/tokens';
import { describe, expect, it } from 'vitest';
import { accentText } from '#lib/color.ts';
import { RESET0, type Settings } from '#lib/state/prefs.svelte.ts';
import { BRAND0 } from '#lib/state/session.svelte.ts';
import { accentOf, accentVars, applyTheme, themeOf } from './theme.ts';

const values = (patch: Partial<Settings> = {}): Settings => ({ ...structuredClone(RESET0), ...patch });

describe('Theme', () => {
  it('uses "Dark" and the brand colour without a choice', () => {
    expect(themeOf(values(), BRAND0, false)).toEqual({
      mode: 'dark',
      dark: true,
      accent: 'apricot',
      density: 'normal',
      fontSize: 'medium',
      animations: true,
      logo: null,
      logoTilt: true,
    });
  });

  it('uses the own accent only if the branding allows it', () => {
    expect(accentOf({ accent: 'rose' }, { userAccent: true, color: 'sage' })).toBe('rose');
    expect(accentOf({ accent: 'rose' }, { userAccent: false, color: 'sage' })).toBe('sage');
    expect(accentOf({ accent: null }, { userAccent: true, color: 'sky' })).toBe('sky');
    expect(accentOf({ accent: '#336699' }, { userAccent: true, color: 'sage' })).toBe('#336699');
    expect(accentOf({ accent: '#336699' }, { userAccent: false, color: 'sage' })).toBe('sage');
  });

  it('sets a custom accent and its ink on <html> and removes them for a named one', () => {
    const root = document.createElement('html');
    for (const mode of ['light', 'dark'] as const) {
      applyTheme(root, themeOf(values({ mode, accent: '#f5a06e' }), BRAND0, false));
      expect(root.dataset.accent).toBe('custom');
      expect(root.style.getPropertyValue('--acc')).toBe('#f5a06e');
      expect(root.style.getPropertyValue('--accink')).toBe('#341c0e');
    }
    applyTheme(root, themeOf(values({ accent: '#1e3a8a' }), BRAND0, false));
    expect(root.style.getPropertyValue('--accink')).toBe('#fffaf3');
    // Mid tone: the dark shade darker than 13 % (#164).
    applyTheme(root, themeOf(values({ accent: '#808080' }), BRAND0, false));
    expect(root.style.getPropertyValue('--accink')).toBe('#231313');

    applyTheme(root, themeOf(values({ accent: 'sky' }), BRAND0, false));
    expect(root.dataset.accent).toBe('sky');
    for (const name of ['--acc', '--accink', '--accsoft', '--deep', '--toastacc']) {
      expect(root.style.getPropertyValue(name), name).toBe('');
    }
  });

  it('computes `--accsoft`, `--deep` and `--toastacc` of a custom accent for the active mode, also for "System"', () => {
    const root = document.createElement('html');
    for (const [mode, systemDark, active] of [
      ['light', true, 'light'],
      ['dark', false, 'dark'],
      ['system', false, 'light'],
      ['system', true, 'dark'],
    ] as const) {
      applyTheme(root, themeOf(values({ mode, accent: '#808080' }), BRAND0, systemDark));
      for (const [name, value] of Object.entries(accentText('#808080', active))) {
        expect(root.style.getPropertyValue(name), `${mode} ${systemDark} ${name}`).toBe(value);
      }
    }
    // The two modes differ: the light one needs a lighter "Undo" on the dark pill.
    expect(accentText('#808080', 'light')).not.toEqual(accentText('#808080', 'dark'));
  });

  it('accentVars keeps the CSS mixes of named accents and computes custom ones', () => {
    for (const mode of ['light', 'dark'] as const) {
      expect(accentVars('sage', mode)).toEqual(derivedAccentVars(mode));
      expect(accentVars('#808080', mode)).toEqual(accentText('#808080', mode));
      expect(accentVars('#808080', mode)['--accsoft']).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('sets attributes and logo plate on <html>', () => {
    const root = document.createElement('html');
    applyTheme(
      root,
      themeOf(
        values({ mode: 'system', density: 'compact', fontSize: 'large', animations: false }),
        { ...BRAND0, plate: 'dark', tilt: false },
        false,
      ),
    );
    expect(root.dataset).toMatchObject({
      mode: 'system',
      accent: 'apricot',
      density: 'compact',
      fontSize: 'large',
      animations: 'off',
    });
    expect(root.style.getPropertyValue('--logo-bg')).toBe('#2b221c');
    expect(root.style.getPropertyValue('--logo-ink')).toBe('#fffaf3');
    expect(root.style.getPropertyValue('--logo-tilt')).toBe('0');

    applyTheme(root, themeOf(values({ mode: 'light' }), BRAND0, false));
    expect(root.dataset.mode).toBe('light');
    expect(root.dataset.animations).toBeUndefined();
    expect(root.style.getPropertyValue('--logo-bg')).toBe('');
    expect(root.style.getPropertyValue('--logo-tilt')).toBe('1');
  });
});
