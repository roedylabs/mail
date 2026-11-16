import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs } from './prefs.svelte.ts';
import { Loading, SKELETON_DELAY, SPLASH_FADE, Ui } from './ui.svelte.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ui', () => {
  it('opens and closes menus', () => {
    const ui = new Ui();
    ui.toggleMenu('nav');
    expect(ui.menu).toBe('nav');
    ui.toggleMenu('bell');
    expect(ui.menu).toBe('bell');
    ui.toggleMenu('bell');
    expect(ui.menu).toBeNull();
  });

  it('detects desktop and toggles the sidebar', () => {
    const ui = new Ui();
    expect(ui.isMobile).toBe(false);
    const before = ui.collapsed;
    ui.toggleSidebar();
    expect(ui.collapsed).toBe(!before);
  });

  it('fades out the splash screen: on → out → gone', () => {
    const ui = new Ui();
    ui.hideSplash();
    expect(ui.splash).toBe('out');
    vi.advanceTimersByTime(SPLASH_FADE);
    expect(ui.splash).toBeNull();
    const still = new Ui();
    still.hideSplash(false);
    expect(still.splash).toBeNull();
  });
});

describe('ui: palette, confirmation and toasts', () => {
  afterEach(() => {
    prefs.reset();
  });

  it('opens the palette with the typed character and closes menus', () => {
    const ui = new Ui();
    ui.menu = 'account';
    ui.openPalette('e');
    expect(ui).toMatchObject({ palette: true, palQ: 'e', palIdx: 0, menu: null });
    ui.closePalette();
    expect(ui).toMatchObject({ palette: false, palQ: '' });
  });

  it('asks and runs only after "Confirm"', () => {
    const ui = new Ui();
    const run = vi.fn();
    ui.ask({ title: 'Sign out device?', text: '', run });
    expect(ui.confirm).not.toBeNull();
    ui.confirmCancel();
    expect(ui.confirm).toBeNull();
    ui.ask({ title: 'Delete account?', text: '', word: 'DELETE', run });
    ui.confirmOk();
    expect(run).not.toHaveBeenCalled();
    ui.confirmIn = ' delete ';
    expect(ui.confirmReady).toBe(true);
    ui.confirmOk();
    expect(run).toHaveBeenCalledOnce();
    expect(ui.confirm).toBeNull();
  });

  it('compares the word case-insensitively', () => {
    const ui = new Ui();
    ui.ask({ title: 'Delete folder?', text: '', word: 'Stra\u00dfe', run: () => {} });
    ui.confirmIn = 'STRASSE';
    expect(ui.confirmReady).toBe(true);
  });

  it('discards palette, dialogs, toast and closed banners on sign-out', () => {
    const ui = new Ui();
    ui.openPalette('x');
    ui.help = true;
    ui.ask({ title: 'T', text: '', run: () => {} });
    ui.confirmIn = 'abc';
    ui.systemMailHidden = true;
    ui.toasts.show('Notice');
    ui.reset();
    expect(ui).toMatchObject({
      palette: false,
      palQ: '',
      help: false,
      confirm: null,
      confirmIn: '',
      systemMailHidden: false,
      toast: null,
    });
  });

  it('cannot be closed without cancelling', () => {
    const ui = new Ui();
    ui.ask({ title: 'Session expired', text: '', noCancel: true, run: () => {} });
    ui.confirmCancel();
    expect(ui.confirm).not.toBeNull();
  });

  it('runs immediately without "Ask before deleting", except with `force`', () => {
    const ui = new Ui();
    prefs.set({ gConfirm: false });
    const run = vi.fn();
    ui.ask({ title: 'Delete folder?', text: '', run });
    expect(run).toHaveBeenCalledOnce();
    expect(ui.confirm).toBeNull();
    ui.ask({ title: 'Delete account?', text: '', force: true, run });
    expect(ui.confirm).not.toBeNull();
  });

  it('shows toasts as long as `gUndo` says', () => {
    const ui = new Ui();
    prefs.set({ gUndo: '3 s' });
    ui.toasts.defer({ text: 'Device signed out', revert: () => {} });
    expect(ui.toast).toMatchObject({ text: 'Device signed out', undo: true });
    vi.advanceTimersByTime(3000);
    expect(ui.toast).toBeNull();
  });
});

describe('Loading', () => {
  it('shows the skeleton only after 150 ms', async () => {
    const loading = new Loading();
    let done!: (v: string) => void;
    const result = loading.run(new Promise<string>((resolve) => (done = resolve)));
    vi.advanceTimersByTime(SKELETON_DELAY - 1);
    expect(loading.slow).toBe(false);
    vi.advanceTimersByTime(1);
    expect(loading.slow).toBe(true);
    done('ok');
    await expect(result).resolves.toBe('ok');
    expect(loading.slow).toBe(false);
  });

  it('shows no skeleton for fast responses', async () => {
    const loading = new Loading();
    await loading.run(Promise.resolve(1));
    vi.advanceTimersByTime(SKELETON_DELAY);
    expect(loading.slow).toBe(false);
  });
});
