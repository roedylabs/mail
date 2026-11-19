import { describe, expect, it } from 'vitest';
import { RESET0, type Settings } from '#lib/state/prefs.svelte.ts';
import { BRAND0 } from '#lib/state/session.svelte.ts';
import { accentOf, applyTheme, themeOf } from './theme.ts';

const values = (patch: Partial<Settings> = {}): Settings => ({ ...structuredClone(RESET0), ...patch });

describe('Theme', () => {
  it('uses "Dark" and the brand colour without a choice', () => {
    expect(themeOf(values(), BRAND0)).toEqual({
      mode: 'dark',
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
      applyTheme(root, themeOf(values({ mode, accent: '#f5a06e' }), BRAND0));
      expect(root.dataset.accent).toBe('custom');
      expect(root.style.getPropertyValue('--acc')).toBe('#f5a06e');
      expect(root.style.getPropertyValue('--accink')).toBe('#341c0e');
    }
    applyTheme(root, themeOf(values({ accent: '#1e3a8a' }), BRAND0));
    expect(root.style.getPropertyValue('--accink')).toBe('#fffaf3');

    applyTheme(root, themeOf(values({ accent: 'sky' }), BRAND0));
    expect(root.dataset.accent).toBe('sky');
    expect(root.style.getPropertyValue('--acc')).toBe('');
    expect(root.style.getPropertyValue('--accink')).toBe('');
  });

  it('sets attributes and logo plate on <html>', () => {
    const root = document.createElement('html');
    applyTheme(
      root,
      themeOf(values({ mode: 'system', density: 'compact', fontSize: 'large', animations: false }), {
        ...BRAND0,
        plate: 'dark',
        tilt: false,
      }),
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

    applyTheme(root, themeOf(values({ mode: 'light' }), BRAND0));
    expect(root.dataset.mode).toBe('light');
    expect(root.dataset.animations).toBeUndefined();
    expect(root.style.getPropertyValue('--logo-bg')).toBe('');
    expect(root.style.getPropertyValue('--logo-tilt')).toBe('1');
  });
});
