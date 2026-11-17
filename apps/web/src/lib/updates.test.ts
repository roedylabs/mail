import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { icons } from '#lib/icons.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { session, type PublicConfig } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  UP_SAVE_DELAY,
  UpdatesPage,
  updatesValues,
  whenText,
  type UpdatesContext,
  type UpdatesInput,
  type UpdatesView,
} from '#lib/updates.svelte.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const TIME = { now: NOW, tz: 'Europe/Berlin', timeFmt: '24h' } as const;
const PAT = { prefix: 'ghp_', tail: 'a1F3', saved_at: '2026-10-27T12:00:00Z' };

function view(over: Partial<UpdatesView> = {}): UpdatesView {
  return {
    update: { available: false, latest: '0.6.0' },
    version: '0.6.0',
    latest: '0.6.0',
    available: false,
    status: 'ok',
    reason: null,
    checked_at: '2026-11-05T11:48:00Z',
    next_at: '2026-11-06T02:00:00Z',
    auto: true,
    every: 'daily',
    time: '03:00',
    weekday: 'monday',
    show: true,
    pat: PAT,
    ...over,
  };
}

const NEW = { latest: '0.7.0', available: true, update: { available: true, latest: '0.7.0' } };

/** Checks run without a token as well. */
const NO_PAT = view({ pat: null });

const CTX: UpdatesContext = {
  scrollTo: vi.fn(),
  copy: vi.fn(() => Promise.resolve(true)),
  notify: vi.fn(),
};
const INPUT: UpdatesInput = { ...TIME, build: '7f3c2a1', isMobile: false };

const values = (p: UpdatesPage, input: Partial<UpdatesInput> = {}) => updatesValues(p, { ...INPUT, ...input }, CTX);

async function loaded(over: Partial<UpdatesView> = {}, routes: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({ 'GET admin/updates': [{ body: view(over) }], ...routes });
  const p = new UpdatesPage();
  await p.load();
  return { p, api };
}

/** Response that only comes on `release()`. */
function later(answer: { status?: number; body?: unknown }) {
  let release = () => {};
  const reply = () =>
    new Promise<{ status?: number; body?: unknown }>((resolve) => {
      release = () => resolve(answer);
    });
  return { reply, release: () => release() };
}

/** `fetch` without a connection. */
const OFFLINE = () => Promise.reject(new TypeError('offline'));

/** Field errors like `FieldErrors` in the backend. */
const fieldError = (code: string) => ({ status: 422, body: { code: 'invalid', fields: { pat: { code } } } });

beforeEach(() => {
  session.config = { update: null } as PublicConfig;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  ui.toasts.dismiss();
  ui.confirm = null;
  session.config = null;
  session.user = null;
});

describe('whenText', () => {
  it('names today, tomorrow or the date in the time zone', () => {
    expect(whenText(Date.parse('2026-11-05T14:30:00Z'), TIME)).toBe('today, 15:30');
    expect(whenText(Date.parse('2026-11-06T02:00:00Z'), TIME)).toBe('tomorrow, 03:00');
    expect(whenText(Date.parse('2026-11-09T02:00:00Z'), TIME)).toBe('Mon 9 Nov, 03:00');
    // Already the next day in Berlin, still the same in UTC.
    expect(whenText(Date.parse('2026-11-05T23:30:00Z'), TIME)).toBe('tomorrow, 00:30');
  });

  it('says "soon" for a due date', () => {
    expect(whenText(NOW, TIME)).toBe('soon');
  });

  it('follows the time format', () => {
    expect(whenText(Date.parse('2026-11-05T14:30:00Z'), { ...TIME, timeFmt: '12h' })).toBe('today, 3:30 PM');
  });
});

describe('updatesValues: status', () => {
  const status = (v: ReturnType<typeof values>) => [v.upTitle, v.upSub, v.upIcon, v.upBad];

  it('without a token the status and the schedule work as usual', async () => {
    const { p } = await loaded(NO_PAT);
    const v = values(p);
    expect(status(v)).toEqual(['Up to date', 'Version 0.6.0 is the latest version.', 'ti-circle-check', false]);
    expect(v.upNext).toBe('tomorrow, 03:00');
    expect(v.pat).toMatchObject({ set: false, edit: true, canCancel: false, masked: '', since: '' });
  });

  it('up to date', async () => {
    const { p } = await loaded();
    const v = values(p);
    expect(status(v)).toEqual(['Up to date', 'Version 0.6.0 is the latest version.', 'ti-circle-check', false]);
    expect(v.upRows).toEqual([
      { k: 'Installed version', v: '0.6.0 · Build 7f3c2a1', sep: false },
      { k: 'Latest version', v: '0.6.0', sep: true },
      { k: 'Last checked', v: '12 min ago', sep: true },
    ]);
    expect(v.upHasWarn).toBe(false);
  });

  it('update available', async () => {
    const { p } = await loaded(NEW);
    const v = values(p);
    expect(status(v)).toEqual([
      'Update available',
      'Version 0.7.0 is out. Pull the new image and restart the container.',
      'ti-cloud-download',
      false,
    ]);
    expect(v.upRows[1]?.v).toBe('0.7.0');
  });

  it.each([
    ['token', 'ti-key-off', 'The access token is invalid or expired. Replace it under “Source”.'],
    [
      'no_access',
      'ti-lock',
      'GitHub denied access to github.com/roedylabs/mail. If you set an access token, replace it under “Source”.',
    ],
    ['rate_limited', 'ti-hourglass', 'GitHub is rate-limiting requests right now. Try again later.'],
    ['unreachable', 'ti-cloud-off', 'GitHub can’t be reached right now. Try again later.'],
  ] as const)('failed: %s', async (reason, icon, text) => {
    const { p } = await loaded({ status: 'err', reason });
    const v = values(p);
    expect(status(v)).toEqual(['Check failed', text, icon, true]);
    expect(v.upHasWarn).toBe(false);
  });

  it('a found version takes precedence over a failed check, the reason sits below', async () => {
    const { p } = await loaded({ ...NEW, status: 'err', reason: 'unreachable' });
    const v = values(p);
    expect(status(v)).toEqual([
      'Update available',
      'Version 0.7.0 is out. Pull the new image and restart the container.',
      'ti-cloud-download',
      false,
    ]);
    expect(v.upHasWarn).toBe(true);
    expect(v.upWarn).toBe('The last check failed. GitHub can’t be reached right now. Try again later.');
  });

  it('no release yet', async () => {
    const { p } = await loaded({ latest: null });
    const v = values(p);
    expect(status(v)).toEqual([
      'No version released yet',
      'The repository has no releases yet.',
      'ti-package-off',
      false,
    ]);
    expect(v.upRows[1]?.v).toBe('Not known yet');
  });

  it('a failed first check names no release state', async () => {
    const { p } = await loaded({ latest: null, status: 'err', reason: 'unreachable', checked_at: null });
    const v = values(p);
    expect(v.upTitle).toBe('Check failed');
    expect(v.upRows[2]?.v).toBe('Not checked yet');
  });

  it('all icons are in the registry', async () => {
    const shown = await Promise.all(
      [
        NO_PAT,
        view(),
        view(NEW),
        view({ latest: null }),
        view({ status: 'err', reason: 'token' }),
        view({ status: 'err', reason: 'no_access' }),
        view({ status: 'err', reason: 'rate_limited' }),
        view({ status: 'err', reason: 'unreachable' }),
      ].map(async (u) => values((await loaded(u)).p)),
    );
    for (const v of shown) {
      expect(icons[v.upIcon]).toBeDefined();
      for (const row of v.upSrcRows) expect(icons[row.icon]).toBeDefined();
    }
  });
});

describe('updatesValues: other values', () => {
  it('masks the token with prefix and names its age', async () => {
    const { p } = await loaded({ pat: { ...PAT, prefix: 'github_pat_' } });
    expect(values(p).pat).toMatchObject({
      set: true,
      edit: false,
      masked: 'github_pat_••••••••••••a1F3',
      since: 'Saved 9 days ago',
    });
  });

  it('names the source with version and copies with a toast', async () => {
    const { p } = await loaded();
    const [repo, image] = values(p).upSrcRows;
    expect(repo).toMatchObject({
      v: 'github.com/roedylabs/mail',
      href: 'https://github.com/roedylabs/mail',
    });
    expect(image).toMatchObject({ v: 'ghcr.io/roedylabs/mail:0.6.0', sep: true });
    await repo?.copy();
    expect(CTX.copy).toHaveBeenCalledWith('https://github.com/roedylabs/mail');
    expect(CTX.notify).toHaveBeenCalledWith('Repository URL copied');
    await image?.copy();
    expect(CTX.copy).toHaveBeenLastCalledWith('ghcr.io/roedylabs/mail:0.6.0');
    expect(CTX.notify).toHaveBeenLastCalledWith('Image copied');
  });

  it('shows time and weekday depending on the interval', async () => {
    vi.useFakeTimers();
    const { p } = await loaded();
    expect(values(p)).toMatchObject({ upHasTime: true, upHasDay: false });
    p.set({ every: 'hourly' });
    expect(values(p)).toMatchObject({ upHasTime: false, upHasDay: false });
    p.set({ every: 'weekly' });
    expect(values(p)).toMatchObject({ upHasTime: true, upHasDay: true });
    expect(values(p).upEveryOpts.map((o) => [o.label, o.on])).toEqual([
      ['Hourly', false],
      ['Daily', false],
      ['Weekly', true],
    ]);
    expect(values(p).upDayOpts.map((o) => o.label)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  it('schedule off: "Deaktiviert", selection disabled', async () => {
    const { p } = await loaded({ auto: false, next_at: null });
    const v = values(p);
    expect(v).toMatchObject({ upNext: 'Disabled', upEvOff: true });
    expect(v.upTimeSel.disabled).toBe(true);
    expect(v.tgUpAuto.on).toBe(false);
  });

  it('the toggle "Check automatically" affects "Next check" before the response', async () => {
    vi.useFakeTimers();
    const { p } = await loaded();
    expect(values(p).upNext).toBe('tomorrow, 03:00');
    values(p).tgUpAuto.onClick();
    expect(values(p).upNext).toBe('Disabled');
  });

  it('tabs jump to the section', async () => {
    const { p } = await loaded();
    const tabs = values(p).upTabs;
    expect(tabs.map((t) => t.label)).toEqual(['Status', 'Source', 'Schedule', 'Display']);
    tabs[2]?.onClick();
    expect(CTX.scrollTo).toHaveBeenCalledWith('schedule');
  });

  it('time picker: always 24-hour, also with the 12-hour time format', async () => {
    const { p } = await loaded();
    for (const isMobile of [false, true]) {
      const t = values(p, { timeFmt: '12h', isMobile }).upTimeSel;
      expect(t.h24).toBe(true);
      expect(t.label).toBe('03:00');
      expect(t.inputVal).toBe('03:00');
      expect(t.hours.map((h) => h.label)).toEqual(Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')));
    }
  });

  it('time picker: opening and closing discards the text', async () => {
    const { p } = await loaded();
    const t = values(p).upTimeSel;
    t.toggle();
    expect(p.timeOpen).toBe(true);
    expect(values(p).upTimeSel.open).toBe(true);
    expect(values(p, { isMobile: true }).upTimeSel.open).toBe(false);
    p.timeEdit = '07';
    values(p).upTimeSel.close();
    expect(p.timeOpen).toBe(false);
    expect(p.timeEdit).toBeNull();
  });
});

describe('UpdatesPage: loading', () => {
  it('skeleton only after 150 ms, until the first response', async () => {
    vi.useFakeTimers();
    const answer = later({ body: view() });
    mockApi({ 'GET admin/updates': [answer.reply] });
    const p = new UpdatesPage();
    const done = p.load();
    expect(values(p)).toMatchObject({ skSet: false, upLoad: { ok: false, fail: false } });
    await vi.advanceTimersByTimeAsync(150);
    expect(values(p).skSet).toBe(true);
    answer.release();
    await done;
    expect(values(p)).toMatchObject({ skSet: false, upLoad: { ok: true, fail: false } });
  });

  it('copies the state into `public/config`', async () => {
    await loaded(NEW);
    expect(session.config?.update).toEqual({ available: true, latest: '0.7.0' });
  });

  it.each([
    ['server error', { status: 500, body: { code: 'internal' } }, 'That didn’t work. Please try again.'],
    [
      '429',
      { status: 429, body: { code: 'rate_limited', retry_after: 30 } },
      'Too many requests. Try again in 30 seconds.',
    ],
  ])('shows the card after a failed first load: %s', async (_, reply, text) => {
    mockApi({ 'GET admin/updates': [reply, { body: view() }] });
    const p = new UpdatesPage();
    await p.load();
    expect(values(p).upLoad).toMatchObject({ ok: false, fail: true, text });
    expect(ui.toast).toBeNull();
    values(p).upLoad.onRetry();
    expect(values(p).upLoad).toMatchObject({ ok: false, fail: false });
    await vi.waitFor(() => expect(values(p).upLoad.ok).toBe(true));
  });

  it('without a connection the card says so', async () => {
    vi.stubGlobal('fetch', vi.fn(OFFLINE));
    const p = new UpdatesPage();
    await p.load();
    expect(values(p).upLoad.text).toBe('No connection. Please try again.');
  });

  it('a later load keeps the data with an error toast', async () => {
    const { p } = await loaded({}, {});
    mockApi({ 'GET admin/updates': [{ status: 500, body: { code: 'internal' } }] });
    await p.load();
    expect(values(p).upLoad).toMatchObject({ ok: true, fail: false });
    expect(ui.toast).toMatchObject({ error: true });
  });

  it('rechecks the account after 403', async () => {
    const refresh = vi.spyOn(session, 'refreshUser').mockResolvedValue();
    mockApi({ 'GET admin/updates': [{ status: 403, body: { code: 'forbidden' } }] });
    await new UpdatesPage().load();
    expect(refresh).toHaveBeenCalled();
  });

  it('ignores the response after leaving', async () => {
    const answer = later({ body: view() });
    mockApi({ 'GET admin/updates': [answer.reply] });
    const p = new UpdatesPage();
    const done = p.load();
    p.dispose();
    answer.release();
    await done;
    expect(p.view).toBeNull();
  });
});

describe('UpdatesPage: check now', () => {
  const check = (body: UpdatesView) => ({ 'POST admin/updates/check': [{ body }] });

  it('nothing new: toast "Keine neuen Updates"', async () => {
    const { p } = await loaded({}, check(view()));
    await p.check();
    expect(ui.toast?.text).toBe('No new updates');
    expect(p.busy).toBe(false);
    expect(p.rot).toBe(720);
  });

  it('new version: toast and About follow', async () => {
    const { p } = await loaded({}, check(view(NEW)));
    await p.check();
    expect(ui.toast?.text).toBe('Version 0.7.0 is out');
    expect(session.config?.update).toEqual({ available: true, latest: '0.7.0' });
  });

  it('failed: no toast, the card names the reason', async () => {
    const { p } = await loaded({}, check(view({ status: 'err', reason: 'unreachable', update: null })));
    await p.check();
    expect(ui.toast).toBeNull();
    expect(values(p).upTitle).toBe('Check failed');
    expect(session.config?.update).toBeNull();
  });

  it('shows "Checking" while it runs and starts only once', async () => {
    const answer = later({ body: view() });
    const { p, api } = await loaded({}, { 'POST admin/updates/check': [answer.reply] });
    const done = p.check();
    expect(values(p)).toMatchObject({
      upBusy: true,
      upBtn: 'Checking',
      upTitle: 'Checking …',
      upIcon: 'ti-search',
    });
    expect(values(p).upSub).toBe('Looking for new versions');
    void p.check();
    answer.release();
    await done;
    expect(api.calls.filter((c) => c.path === 'admin/updates/check')).toHaveLength(1);
    expect(values(p).upBtn).toBe('Check now');
  });

  it('checks without a token as well', async () => {
    const { p, api } = await loaded(NO_PAT, { 'POST admin/updates/check': [{ body: view({ ...NEW, pat: null }) }] });
    await p.check();
    expect(api.calls.map((c) => c.path)).toEqual(['admin/updates', 'admin/updates/check']);
    expect(p.rot).toBe(720);
    expect(ui.toast?.text).toBe('Version 0.7.0 is out');
  });

  it('429: error toast, the state stays', async () => {
    const { p } = await loaded(NEW, {
      'POST admin/updates/check': [{ status: 429, body: { code: 'rate_limited', retry_after: 90 } }],
    });
    await p.check();
    expect(ui.toast).toMatchObject({ error: true, text: 'Too many requests. Try again in 2 minutes.' });
    expect(values(p).upTitle).toBe('Update available');
  });

  it('server error: error toast', async () => {
    const { p } = await loaded({}, { 'POST admin/updates/check': [{ status: 500, body: { code: 'internal' } }] });
    await p.check();
    expect(ui.toast).toMatchObject({ error: true, text: 'That didn’t work. Please try again.' });
  });

  it('without a connection: the error toast says so', async () => {
    const { p } = await loaded();
    vi.stubGlobal('fetch', vi.fn(OFFLINE));
    await p.check();
    expect(ui.toast).toMatchObject({ error: true, text: 'No connection. Please try again.' });
    expect(p.busy).toBe(false);
  });

  it.each([
    ['replaced', 'PUT admin/updates', (p: UpdatesPage) => void p.saveToken()],
    ['removed', 'POST admin/updates/remove-pat', (p: UpdatesPage) => (p.removeToken(), ui.confirmOk())],
  ])('if the token is %s during the check, its result expires without a toast', async (_, route, act) => {
    const answer = later({ body: view(NEW) });
    const after = view({ pat: { ...PAT, tail: 'b2G4' } });
    const { p } = await loaded(
      {},
      {
        'POST admin/updates/check': [answer.reply],
        [route]: [{ body: after }],
      },
    );
    const done = p.check();
    p.setInput('ghp_abcdefghijklmnopqrstuvwxyz');
    act(p);
    await vi.waitFor(() => expect(p.view).toEqual(after));
    expect(p.busy).toBe(false);
    ui.toasts.dismiss();
    answer.release();
    await done;
    expect(ui.toast).toBeNull();
    expect(p.view).toEqual(after);
    expect(values(p).upBusy).toBe(false);
  });
});

describe('UpdatesPage: access token', () => {
  const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz';

  it('saves, closes the input and reports it', async () => {
    const { p, api } = await loaded(NO_PAT, { 'PUT admin/updates': [{ body: view(NEW) }] });
    values(p).pat.onChange(`  ${TOKEN} `);
    p.showToken = true;
    expect(values(p).pat).toMatchObject({ saveOn: true, saveDis: false, type: 'text', eyeIcon: 'ti-eye-off' });
    values(p).pat.save();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Access token saved'));
    expect(api.calls.at(-1)).toMatchObject({ method: 'PUT', body: { pat: TOKEN } });
    expect(values(p).pat).toMatchObject({ set: true, edit: false, value: '', type: 'password', hasErr: false });
    expect(session.config?.update).toEqual({ available: true, latest: '0.7.0' });
  });

  it('Enter saves, empty input does not', async () => {
    const { p, api } = await loaded(NO_PAT, { 'PUT admin/updates': [{ body: view() }] });
    values(p).pat.onKey({ key: 'Enter' });
    expect(api.calls).toHaveLength(1);
    expect(values(p).pat).toMatchObject({ saveOn: false, saveDis: true });
    p.setInput(TOKEN);
    values(p).pat.onKey({ key: 'a' });
    expect(api.calls).toHaveLength(1);
    values(p).pat.onKey({ key: 'Enter' });
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Access token saved'));
  });

  it('shows "Verifying …" while saving', async () => {
    const answer = later({ body: view() });
    const { p } = await loaded(NO_PAT, { 'PUT admin/updates': [answer.reply] });
    p.setInput(TOKEN);
    const done = p.saveToken();
    expect(values(p).pat).toMatchObject({
      saveLbl: 'Verifying …',
      saveIcon: 'ti-loader-2',
      saveOn: true,
      saveBusy: true,
      saveDis: true,
    });
    answer.release();
    await done;
    expect(values(p).pat).toMatchObject({ saveLbl: 'Verify and save', saveIcon: 'ti-check', saveBusy: false });
  });

  it('invalid: at the field with a red border, input clears the message', async () => {
    const { p } = await loaded(NO_PAT, { 'PUT admin/updates': [fieldError('invalid')] });
    p.setInput(TOKEN);
    await p.saveToken();
    expect(values(p).pat).toMatchObject({
      hasErr: true,
      invalid: true,
      value: TOKEN,
      err: 'Invalid token or no access to github.com/roedylabs/mail.',
    });
    expect(ui.toast).toBeNull();
    p.setInput('x');
    expect(values(p).pat).toMatchObject({ hasErr: false, invalid: false, err: '' });
  });

  it('unavailable: at the field without a red border', async () => {
    const { p } = await loaded(NO_PAT, { 'PUT admin/updates': [fieldError('unavailable')] });
    p.setInput(TOKEN);
    await p.saveToken();
    expect(values(p).pat).toMatchObject({
      hasErr: true,
      invalid: false,
      err: 'GitHub isn’t responding right now. The token wasn’t saved. Try again later.',
    });
  });

  it('429: at the field without a red border', async () => {
    const { p } = await loaded(NO_PAT, {
      'PUT admin/updates': [{ status: 429, body: { code: 'rate_limited', retry_after: 30 } }],
    });
    p.setInput(TOKEN);
    await p.saveToken();
    expect(values(p).pat).toMatchObject({
      hasErr: true,
      invalid: false,
      err: 'Too many requests. Try again in 30 seconds.',
    });
  });

  it('server error: error toast, the field keeps its content', async () => {
    const { p } = await loaded(NO_PAT, { 'PUT admin/updates': [{ status: 500, body: { code: 'internal' } }] });
    p.setInput(TOKEN);
    await p.saveToken();
    expect(values(p).pat).toMatchObject({ hasErr: false, value: TOKEN });
    expect(ui.toast).toMatchObject({ error: true });
  });

  it('without a connection: the error toast says so, the field keeps its content', async () => {
    const { p } = await loaded(NO_PAT);
    vi.stubGlobal('fetch', vi.fn(OFFLINE));
    p.setInput(TOKEN);
    await p.saveToken();
    expect(ui.toast).toMatchObject({ error: true, text: 'No connection. Please try again.' });
    expect(values(p).pat).toMatchObject({ hasErr: false, value: TOKEN });
  });

  it('replace and cancel clear the input', async () => {
    const { p } = await loaded();
    values(p).pat.replace();
    expect(values(p).pat).toMatchObject({ set: false, edit: true, canCancel: true });
    p.setInput(TOKEN);
    p.tokenErr = 'x';
    p.showToken = true;
    values(p).pat.cancel();
    expect(values(p).pat).toMatchObject({ set: true, edit: false, value: '', hasErr: false, type: 'password' });
  });

  it('remove asks first and offers no undo', async () => {
    const { p, api } = await loaded({}, { 'POST admin/updates/remove-pat': [{ body: NO_PAT }] });
    session.config = { ...(session.config as PublicConfig), name: 'Roedy Mail' };
    values(p).pat.remove();
    expect(ui.confirm).toMatchObject({
      title: 'Remove access token?',
      text: 'Without a token, Roedy Mail checks for new versions anonymously, and GitHub limits that more strictly. You can add a token again at any time.',
      icon: 'ti-key-off',
      ok: 'Remove',
      danger: true,
    });
    expect(api.calls).toHaveLength(1);
    ui.confirmOk();
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Access token removed'));
    expect(ui.toast).not.toMatchObject({ undo: true });
    expect(values(p).pat).toMatchObject({ set: false, edit: true });
    expect(session.config?.update).toEqual({ available: false, latest: '0.6.0' });
  });

  it('remove failed: error toast, the token stays', async () => {
    const { p } = await loaded({}, { 'POST admin/updates/remove-pat': [{ status: 500, body: { code: 'internal' } }] });
    p.removeToken();
    ui.confirmOk();
    await vi.waitFor(() => expect(ui.toast).toMatchObject({ error: true }));
    expect(values(p).pat).toMatchObject({ set: true, edit: false });
  });
});

describe('UpdatesPage: schedule and display', () => {
  it('combines changes after the pause into one `PUT`, only the changed fields', async () => {
    vi.useFakeTimers();
    const { p, api } = await loaded(
      {},
      { 'PUT admin/updates': [{ body: view({ every: 'weekly', weekday: 'tuesday' }) }] },
    );
    values(p).upEveryOpts[2]?.onClick();
    await vi.advanceTimersByTimeAsync(UP_SAVE_DELAY - 1);
    values(p).upDayOpts[1]?.onClick();
    expect(api.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(UP_SAVE_DELAY);
    expect(api.calls.slice(1).map((c) => c.body)).toEqual([{ every: 'weekly', weekday: 'tuesday' }]);
    expect(p.edits).toEqual({});
    expect(p.schedule).toMatchObject({ every: 'weekly', weekday: 'tuesday' });
  });

  it('a typed time goes out only after the pause', async () => {
    vi.useFakeTimers();
    const { p, api } = await loaded({}, { 'PUT admin/updates': [{ body: view({ time: '04:30' }) }] });
    values(p).upTimeSel.onInput('0');
    values(p).upTimeSel.onInput('04:30');
    expect(p.schedule.time).toBe('04:30');
    await vi.advanceTimersByTimeAsync(UP_SAVE_DELAY);
    expect(api.calls.at(-1)).toMatchObject({ method: 'PUT', body: { time: '04:30' } });
  });

  it('sends only one `PUT` at a time; a later response does not overwrite newer input', async () => {
    vi.useFakeTimers();
    const first = later({ body: view({ auto: false, next_at: null }) });
    const { p, api } = await loaded(
      {},
      { 'PUT admin/updates': [first.reply, { body: view({ auto: false, next_at: null, show: false }) }] },
    );
    values(p).tgUpAuto.onClick();
    await vi.advanceTimersByTimeAsync(UP_SAVE_DELAY);
    values(p).tgUpShow.onClick();
    await vi.advanceTimersByTimeAsync(UP_SAVE_DELAY * 2);
    expect(api.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    first.release();
    await vi.advanceTimersByTimeAsync(0);
    // The response does not know `show: false` yet, the input stays.
    expect(p.view?.show).toBe(true);
    expect(p.schedule).toMatchObject({ auto: false, show: false });
    await vi.advanceTimersByTimeAsync(UP_SAVE_DELAY);
    expect(api.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ auto: false }, { show: false }]);
    expect(p.edits).toEqual({});
  });

  it('failed: error toast and back to the stored state', async () => {
    vi.useFakeTimers();
    const { p } = await loaded({}, { 'PUT admin/updates': [{ status: 500, body: { code: 'internal' } }] });
    values(p).tgUpShow.onClick();
    expect(values(p).tgUpShow.on).toBe(false);
    await vi.advanceTimersByTimeAsync(UP_SAVE_DELAY);
    expect(values(p).tgUpShow.on).toBe(true);
    expect(ui.toast).toMatchObject({ error: true });
  });

  it('the display follows in About after the response', async () => {
    vi.useFakeTimers();
    const { p } = await loaded({}, { 'PUT admin/updates': [{ body: view({ show: false, update: null }) }] });
    expect(session.config?.update).toEqual({ available: false, latest: '0.6.0' });
    values(p).tgUpShow.onClick();
    await vi.advanceTimersByTimeAsync(UP_SAVE_DELAY);
    expect(session.config?.update).toBeNull();
  });

  it('a waiting change goes out immediately when leaving', async () => {
    vi.useFakeTimers();
    const { p, api } = await loaded({}, { 'PUT admin/updates': [{ body: view({ auto: false }) }] });
    values(p).tgUpAuto.onClick();
    p.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.calls.at(-1)).toMatchObject({ method: 'PUT', body: { auto: false } });
  });

  it('after leaving, a change that waited for a running `PUT` also goes out', async () => {
    vi.useFakeTimers();
    const first = later({ body: view({ auto: false }) });
    const { p, api } = await loaded(
      {},
      { 'PUT admin/updates': [first.reply, { body: view({ auto: false, show: false }) }] },
    );
    values(p).tgUpAuto.onClick();
    await vi.advanceTimersByTimeAsync(UP_SAVE_DELAY);
    values(p).tgUpShow.onClick();
    p.dispose();
    first.release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ auto: false }, { show: false }]);
  });
});
