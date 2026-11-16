import { describe, expect, it, vi } from 'vitest';
import { appearanceValues, type AppearanceContext, type AppearanceInput } from './appearance.ts';
import { RESET0 } from './state/prefs.svelte.ts';

function setup(patch: Partial<AppearanceInput> = {}) {
  const ctx: AppearanceContext = { set: vi.fn(), setCollapsed: vi.fn(), scrollTo: vi.fn() };
  const input: AppearanceInput = {
    values: { ...RESET0 },
    brand: { userAccent: true, color: 'apricot' },
    collapsed: false,
    ...patch,
  };
  return { ctx, v: appearanceValues(input, ctx) };
}

describe('Appearance', () => {
  it('shows the defaults like RESET0: dark, brand colour, medium, normal, soft, animations on', () => {
    const { v } = setup();
    expect(v.modeCards.map((c) => [c.label, c.on])).toEqual([
      ['Light', false],
      ['Dark', true],
      ['System', false],
    ]);
    expect(v.accentOpts.find((a) => a.on)?.name).toBe('apricot');
    expect(v.fontOpts.find((o) => o.on)?.label).toBe('Medium');
    expect(v.densityOpts.find((o) => o.on)?.label).toBe('Normal');
    expect(v.pfDesignOpts.find((o) => o.on)?.label).toBe('Soft');
    expect(v.sidebarOpts.find((o) => o.on)?.label).toBe('Expanded');
    expect(v.tgAnim.on).toBe(true);
    expect(v.accLocked).toBe(false);
  });

  it('returns preview and icon per mode from MODE_PREV', () => {
    const { v } = setup();
    expect(v.modeCards[0]).toMatchObject({ icon: 'ti-sun', panel: '#fffdfa', inkc: '#2b221c' });
    expect(v.modeCards[2]).toMatchObject({ icon: 'ti-device-desktop', line: 'rgba(150,130,110,.45)' });
  });

  it('saves every choice via prefs', () => {
    const { v, ctx } = setup();
    v.modeCards[2]!.onClick();
    v.accentOpts.find((a) => a.name === 'sky')!.onClick();
    v.fontOpts[2]!.onClick();
    v.densityOpts[0]!.onClick();
    v.pfDesignOpts[1]!.onClick();
    v.tgAnim.onClick();
    expect(vi.mocked(ctx.set).mock.calls).toEqual([
      [{ mode: 'system' }],
      [{ accent: 'sky' }],
      [{ fontSize: 'large' }],
      [{ density: 'compact' }],
      [{ pfDesign: 'compact' }],
      [{ animations: false }],
    ]);
  });

  it('collapses the sidebar via ui instead of prefs', () => {
    const { v, ctx } = setup({ collapsed: true });
    expect(v.sidebarOpts.map((o) => o.on)).toEqual([true, false]);
    v.sidebarOpts[1]!.onClick();
    expect(ctx.setCollapsed).toHaveBeenCalledWith(false);
    expect(ctx.set).not.toHaveBeenCalled();
  });

  it('locks the accent colour without userAccent: brand colour active, click without effect', () => {
    const { v, ctx } = setup({
      values: { ...RESET0, accent: 'rose' },
      brand: { userAccent: false, color: 'sage' },
    });
    expect(v.accLocked).toBe(true);
    expect(v.accentOpts.find((a) => a.on)?.name).toBe('sage');
    v.accentOpts[0]!.onClick();
    expect(ctx.set).not.toHaveBeenCalled();
  });

  it('takes the own choice before the brand colour with userAccent', () => {
    const { v } = setup({ values: { ...RESET0, accent: 'rose' }, brand: { userAccent: true, color: 'sage' } });
    expect(v.accentOpts.filter((a) => a.on).map((a) => a.name)).toEqual(['rose']);
  });

  it('scrolls to the sections via the tabs', () => {
    const { v, ctx } = setup();
    expect(v.tabs.map((t) => t.label)).toEqual(['Color scheme', 'Accent color', 'Text & animation', 'Layout']);
    v.tabs.forEach((t) => t.onClick());
    expect(vi.mocked(ctx.scrollTo).mock.calls.flat()).toEqual(['mode', 'accent', 'text', 'layout']);
  });
});
