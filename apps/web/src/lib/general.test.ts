import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs, RESET0, type Settings } from '#lib/state/prefs.svelte.ts';
import { BRAND0, session, type Me } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { LAST_PAGE_KEY } from '#lib/last-page.ts';
import { mailPush, MAIL_PUSH_KEY } from '#lib/mail-push.svelte.ts';
import {
  DELETE_CONFIRM,
  General,
  clearDeviceData,
  deviceBytes,
  exportFile,
  generalValues,
  localSummary,
  type GeneralContext,
  type GeneralInput,
} from './general.svelte.ts';

interface Exported {
  app: string;
  version: string;
  account: unknown;
  settings: Record<string, unknown>;
  notifications: { channels: unknown; quietHours: unknown };
}

const ME: Me = {
  id: 'u0',
  username: 'max',
  email: 'max@example.net',
  display_name: 'Max Example',
  role: 'admin',
  mfa_enabled: false,
  password_changed_at: '2026-10-25T10:00:00Z',
  email_change: null,
  sole_admin: false,
};

function input(over: Partial<GeneralInput> = {}): GeneralInput {
  return {
    values: { ...RESET0 },
    open: null,
    hi: null,
    isMobile: false,
    soleAdmin: false,
    localBytes: 184 * 1024 * 1024,
    clearing: false,
    deleting: false,
    ...over,
  };
}

function context() {
  return {
    set: vi.fn<GeneralContext['set']>(),
    scrollTo: vi.fn<GeneralContext['scrollTo']>(),
    show: vi.fn<GeneralContext['show']>(),
    mark: vi.fn<GeneralContext['mark']>(),
  } satisfies GeneralContext;
}

describe('generalValues', () => {
  it('returns tabs, select lists and switches with their values', () => {
    const ctx = context();
    const v = generalValues(input(), ctx);
    expect(v.genTabs.map((t) => t.label)).toEqual([
      'Startup',
      'Behavior',
      'Gestures',
      'External content',
      'Data',
      'Delete account',
    ]);
    v.genTabs[4]!.onClick();
    expect(ctx.scrollTo).toHaveBeenCalledWith('data');

    expect(v.selStart.title).toBe('Open on startup');
    expect(v.selStart.label).toBe('Inbox');
    expect(v.selStart.opts.map((o) => o.label)).toEqual(['Inbox', 'Last opened page']);
    v.selStart.opts[1]!.onClick();
    expect(ctx.set).toHaveBeenCalledWith({ gStart: 'last' });

    expect(v.selSwL.label).toBe('Move to folder');
    expect(v.selSwR.label).toBe('Delete');
    expect(v.selSwL.opts.map((o) => o.label)).toEqual([
      'No action',
      'Delete',
      'Read / unread',
      'Flag',
      'Report spam',
      'Move to folder',
    ]);
    v.selSwR.opts[0]!.onClick();
    expect(ctx.set).toHaveBeenCalledWith({ swR: 'none' });

    expect(v.tgConfirm.on).toBe(true);
    v.tgConfirm.onClick();
    expect(ctx.set).toHaveBeenCalledWith({ gConfirm: false });
    v.tgKeys.onClick();
    expect(ctx.set).toHaveBeenCalledWith({ gKeys: false });
    expect(v.undoOpts.map((o) => [o.label, o.on])).toEqual([
      ['3 s', false],
      ['5 s', true],
      ['10 s', false],
    ]);
    v.undoOpts[2]!.onClick();
    expect(ctx.set).toHaveBeenCalledWith({ gUndo: '10 s' });
  });

  it('opens only the chosen select list, on mobile never as a popover', () => {
    expect(generalValues(input({ open: 'swL' }), context()).selSwL.open).toBe(true);
    expect(generalValues(input({ open: 'swL' }), context()).selSwR.open).toBe(false);
    expect(generalValues(input({ open: 'swL', isMobile: true }), context()).selSwL.open).toBe(false);
  });

  it('shows the storage on the device and dims without local data', () => {
    let v = generalValues(input(), context());
    expect(v.localSum).toBe('184 MB on this device');
    expect(v.localDim).toBe(false);
    expect(v.localB).toEqual({ icon: 'ti-eraser', label: 'Clear', busy: false });
    v = generalValues(input({ localBytes: 0 }), context());
    expect(v.localSum).toBe('No local data on this device');
    expect(v.localDim).toBe(true);
    v = generalValues(input({ localBytes: 0, clearing: true }), context());
    expect(v.localDim).toBe(false);
    expect(v.localB).toEqual({ icon: 'ti-loader-2', label: 'Clearing', busy: true });
  });

  it('locks “Delete account” for the only administrator with a notice and a tooltip only on desktop', () => {
    let v = generalValues(input(), context());
    expect(v.soleAdm).toBe(false);
    expect(v.delSub).toBe('This can’t be undone.');
    expect(v.delTip).toBeUndefined();
    expect(v.delB).toEqual({ label: 'Delete account', dis: false, busy: false });

    v = generalValues(input({ soleAdmin: true }), context());
    expect(v.soleAdm).toBe(true);
    expect(v.delSub).toMatch(/^You’re the only administrator\./);
    expect(v.delTip).toBe('Only possible once there’s another administrator');
    expect(v.delB.dis).toBe(true);
    expect(generalValues(input({ soleAdmin: true, isMobile: true }), context()).delTip).toBeUndefined();

    v = generalValues(input({ deleting: true }), context());
    expect(v.delB).toEqual({ label: 'Deleting …', dis: true, busy: true });
  });
});

describe('localSummary', () => {
  it('rounds below 10 MB to one decimal, at least 0.1', () => {
    expect(localSummary(null)).toBe('No local data on this device');
    expect(localSummary(120)).toBe('0.1 MB on this device');
    expect(localSummary(2.46 * 1024 * 1024)).toBe('2.5 MB on this device');
    expect(localSummary(12.6 * 1024 * 1024)).toBe('13 MB on this device');
  });
});

describe('exportFile', () => {
  it('builds name and content of the export', () => {
    const values: Settings = {
      ...structuredClone(RESET0),
      mode: 'light',
      accent: 'sage',
      nQuiet: true,
      tzAuto: false,
    };
    const file = exportFile({
      appName: 'Roedy Mail',
      version: '0.6.0',
      now: new Date(2026, 10, 4, 9, 30),
      user: ME,
      values,
      brand: BRAND0,
    });
    expect(file.name).toBe('roedy-mail-export-2026-11-04.json');
    const data = JSON.parse(file.json) as Exported;
    expect(data.app).toBe('Roedy Mail');
    expect(data.version).toBe('0.6.0');
    expect(data.account).toEqual({ name: 'Max Example', email: 'max@example.net' });
    expect(data.settings).toMatchObject({
      mode: 'light',
      accent: 'sage',
      timeZone: 'Europe/Berlin',
      startPage: 'inbox',
      confirm: true,
      undo: '5 s',
    });
    expect(data.notifications.quietHours).toEqual({ from: '22:00', to: '07:00' });
    expect(data.notifications.channels).toEqual(RESET0.nCh);
    // Without an own choice: dark and brand colour; accent only if the branding allows it.
    const plain = JSON.parse(
      exportFile({
        appName: '***',
        version: '1',
        now: new Date(),
        user: ME,
        values: { ...values, mode: null, tzAuto: true },
        brand: { ...BRAND0, userAccent: false },
      }).json,
    ) as Exported;
    expect(plain.settings.mode).toBe('dark');
    expect(plain.settings.accent).toBe(BRAND0.color);
    expect(plain.settings.timeZone).toBe('auto');
    expect(
      exportFile({ appName: '***', version: '1', now: new Date(2026, 0, 2), user: ME, values, brand: BRAND0 }).name,
    ).toBe('app-export-2026-01-02.json');
  });
});

describe('device data', () => {
  beforeEach(() => localStorage.clear());

  it('counts localStorage without the last opened page and deletes both', async () => {
    expect(await deviceBytes()).toBe(0);
    localStorage.setItem(LAST_PAGE_KEY, 'x'.repeat(10));
    expect(await deviceBytes()).toBe(0);
    localStorage.setItem('cache', 'x'.repeat(10));
    expect(await deviceBytes()).toBe(('cache'.length + 10) * 2);
    await clearDeviceData();
    expect(localStorage.length).toBe(0);
  });
});

describe('General', () => {
  let general: General;

  beforeEach(() => {
    general = new General();
    session.user = { ...ME };
    prefs.reset();
    ui.reset();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    session.user = null;
  });

  it('deletes local data after confirmation and reports it to the server', async () => {
    localStorage.setItem('cache', '{}');
    await general.measure();
    expect(general.localBytes).toBeGreaterThan(0);
    const { calls } = mockApi({ 'POST settings/local-reset': [{ status: 204 }] });
    general.clearLocal();
    expect(ui.confirm?.title).toBe('Clear local data?');
    ui.confirmOk();
    expect(general.clearing).toBe(true);
    await vi.waitFor(() => expect(general.clearing).toBe(false));
    expect(localStorage.length).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST settings/local-reset']);
    expect(ui.toast).toMatchObject({ text: 'Local data cleared', error: false });
    expect(general.localBytes).toBe(0);
  });

  it('unsubscribes JMAP push on the mail servers first and then cleans up the device', async () => {
    localStorage.setItem('cache', '{}');
    await general.measure();
    const stored: (string | null)[] = [];
    const seen = () => {
      stored.push(localStorage.getItem('cache'));
      return Promise.resolve();
    };
    const withdraw = vi.spyOn(mailPush, 'withdraw').mockImplementation(seen);
    const clearDevice = vi.spyOn(mailPush, 'clearDevice').mockImplementation(seen);
    mockApi({ 'POST settings/local-reset': [{ status: 204 }] });
    general.clearLocal();
    ui.confirmOk();
    await vi.waitFor(() => expect(general.clearing).toBe(false));
    expect(stored).toEqual(['{}', null]);
    withdraw.mockRestore();
    clearDevice.mockRestore();
  });

  it('does not count the JMAP push note as local data', async () => {
    localStorage.setItem(MAIL_PUSH_KEY, '{"m1":"p1"}');
    await general.measure();
    expect(general.localBytes).toBe(0);
  });

  it('reports “deleted” even if the audit log entry fails', async () => {
    localStorage.setItem('cache', '{}');
    await general.measure();
    mockApi({ 'POST settings/local-reset': [{ status: 429, body: { error: 'rate_limited' } }] });
    general.clearLocal();
    ui.confirmOk();
    await vi.waitFor(() => expect(general.clearing).toBe(false));
    expect(ui.toast).toMatchObject({ text: 'Local data cleared', error: false });
  });

  it('does nothing without local data', async () => {
    await general.measure();
    general.clearLocal();
    expect(ui.confirm).toBeNull();
  });

  it('deletes the account with the confirmation word and then discards the state', async () => {
    localStorage.setItem(LAST_PAGE_KEY, '{}');
    const { calls } = mockApi({ 'DELETE auth/me': [{ status: 204 }] });
    general.deleteAccount();
    expect(ui.confirm).toMatchObject({
      title: 'Permanently delete account?',
      word: 'DELETE',
      force: true,
      danger: true,
      text: 'Your account max@example.net and all its data will be deleted. This can’t be undone.',
    });
    ui.confirmOk();
    expect(ui.confirm).not.toBeNull();
    ui.confirmIn = 'delete';
    ui.confirmOk();
    expect(general.deleting).toBe(true);
    await vi.waitFor(() => expect(session.user).toBeNull());
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: 'auth/me', body: { confirm: DELETE_CONFIRM } });
    expect(general.deleting).toBe(false);
    expect(localStorage.getItem(LAST_PAGE_KEY)).toBeNull();
  });

  it('asks even without “Ask before deleting”', () => {
    prefs.set({ gConfirm: false });
    general.deleteAccount();
    expect(ui.confirm?.word).toBe('DELETE');
  });

  it('on 409 last_admin: error toast, stay signed in, then the notice', async () => {
    mockApi({ 'DELETE auth/me': [{ status: 409, body: { error: 'last_admin' } }] });
    general.deleteAccount();
    ui.confirmIn = 'DELETE';
    ui.confirmOk();
    await vi.waitFor(() => expect(general.deleting).toBe(false));
    expect(ui.confirm).toBeNull();
    expect(ui.toast).toMatchObject({
      text: 'Account not deleted. You’re now the only administrator.',
      error: true,
    });
    expect(session.user?.sole_admin).toBe(true);
    // Afterwards the button is locked.
    general.deleteAccount();
    expect(ui.confirm).toBeNull();
  });

  it('on other errors: error toast, no sign-out', async () => {
    mockApi({ 'DELETE auth/me': [{ status: 500, body: { error: 'internal' } }] });
    general.deleteAccount();
    ui.confirmIn = 'DELETE';
    ui.confirmOk();
    await vi.waitFor(() => expect(general.deleting).toBe(false));
    expect(ui.toast).toMatchObject({ text: 'That didn’t work. Please try again.', error: true });
    expect(session.user?.sole_admin).toBe(false);
    expect(session.user).not.toBeNull();
  });

  it('does not let the only administrator ask', () => {
    session.user = { ...ME, sole_admin: true };
    general.deleteAccount();
    expect(ui.confirm).toBeNull();
  });

  it('exports as a file and reports it', () => {
    // Own subclass instead of changing the global `URL`: `unstubAllGlobals` restores the original.
    const create = vi.fn(() => 'blob:x');
    vi.stubGlobal(
      'URL',
      class extends URL {
        static override createObjectURL = create;
        static override revokeObjectURL = vi.fn();
      },
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    general.doExport();
    expect(create).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(ui.toast).toMatchObject({ text: 'Export downloaded', error: false });
    click.mockRestore();
  });

  it('reloads auth/me when opening: sole_admin follows a new administrator', async () => {
    session.user = { ...ME, sole_admin: true };
    mockApi({ 'GET auth/me': [{ body: { ...ME, sole_admin: false } }] });
    await general.open();
    expect(session.user?.sole_admin).toBe(false);
    expect(general.localBytes).toBe(0);
  });

  it('takes only the last measurement', async () => {
    let first: (value: StorageEstimate) => void = () => {};
    const estimate = vi
      .fn<() => Promise<StorageEstimate>>()
      .mockReturnValueOnce(new Promise((resolve) => (first = resolve)))
      .mockResolvedValueOnce({ usage: 0 });
    vi.stubGlobal('navigator', { storage: { estimate } });
    const slow = general.measure();
    await general.measure();
    first({ usage: 184 * 1024 * 1024 });
    await slow;
    expect(general.localBytes).toBe(0);
  });

  it('syncs the session on 401', async () => {
    mockApi({
      'DELETE auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
      'GET auth/me': [{ status: 401, body: { error: 'unauthorized' } }],
    });
    general.deleteAccount();
    ui.confirmIn = 'DELETE';
    ui.confirmOk();
    await vi.waitFor(() => expect(session.user).toBeNull());
    expect(ui.toast?.error).toBe(true);
  });
});
