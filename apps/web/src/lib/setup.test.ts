import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { ACCENTS } from '@roedy/tokens';
import { PRESETS } from '#lib/color-editor.svelte.ts';
import {
  CODE_LOCK_S,
  DONE_MS,
  MASKED_PW,
  RECENT_MAX,
  SetupFlow,
  accentOfHex,
  choicesOf,
  choicesSummary,
  clearSession,
  closedCount,
  closedTiles,
  colorOrder,
  customHexOf,
  formatToken,
  openTiles,
  readSession,
  recentOf,
  rememberColor,
  resumeStep,
  storeChoice,
  trackCount,
  withRecent,
  writeSession,
  type Field,
  type Focus,
  type Step,
} from './setup.svelte.ts';

const TOKEN = 'ABCD-EFGH-JKLM';
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/Roedy%20Mail:anna%40example.com?secret=${SECRET}&issuer=Roedy%20Mail`;
const CODES = Array.from({ length: 10 }, (_, i) => `ABCD-${String(1000 + i)}`);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearSession();
  sessionStorage.clear();
});

function hooks() {
  return {
    fail: vi.fn<(field?: Field | 'otp' | 'saved') => void>(),
    focus: vi.fn<(field: Field) => void>(),
    entered: vi.fn<(step: Step, focus: Focus | null) => void>(),
    refocus: vi.fn<(focus: Focus) => void>(),
    error: vi.fn<(text: string) => void>(),
    reload: vi.fn(() => Promise.resolve()),
    signedIn: vi.fn(() => Promise.resolve()),
  };
}

/**
 * Flow up to the start of step `step` (without API, fields as after the steps; from step 5 with the key for the
 * email, from step 6 with the recovery codes, on the review with the box ticked).
 */
function at(step: 3 | 4 | 5 | 6 | 7, h = hooks()) {
  const flow = new SetupFlow(h);
  flow.token = TOKEN;
  flow.tokOk = true;
  flow.name = 'Anna Baker';
  flow.email = 'anna@example.com';
  flow.pw = 'Safe-enough1';
  flow.pw2 = 'Safe-enough1';
  if (step >= 5) flow.key = { email: 'anna@example.com', secret: SECRET, uri: URI };
  if (step >= 6) flow.codes = [...CODES];
  if (step === 7) flow.saved = true;
  flow.step = step;
  return { flow, h };
}

describe('Helpers', () => {
  it('formats the token input', () => {
    expect(formatToken('abcd')).toBe('ABCD');
    expect(formatToken('abcdefghjklmn')).toBe('ABCD-EFGH-JKLM');
    expect(formatToken('[setup] Setup-Token: abcd-efgh-jklm (valid until …)')).toBe('ABCD-EFGH-JKLM');
    expect(formatToken('ab cd–ef')).toBe('ABCD-EF');
  });
});

describe('Accent colours', () => {
  const accents = Object.values(ACCENTS).map((a) => a.base);
  const presets = PRESETS.map(([, hex]) => hex);

  it('orders the colours: recently used, then the five accents, then the presets, each once', () => {
    const plain = colorOrder([]);
    expect(plain.map((t) => t.hex)).toEqual([...accents, ...presets]);
    expect(plain.slice(0, 5).map((t) => t.accent)).toEqual(['apricot', 'sage', 'lavender', 'sky', 'rose']);
    expect(plain.slice(5).every((t) => t.accent === undefined)).toBe(true);

    const order = colorOrder(['#123456', '#78c895', ACCENTS.sky.base]);
    expect(order.map((t) => t.hex)).toEqual([
      '#123456',
      '#78c895',
      ACCENTS.sky.base,
      ACCENTS.apricot.base,
      ACCENTS.sage.base,
      ACCENTS.lavender.base,
      ACCENTS.rose.base,
      ...presets.filter((x) => x !== '#78c895'),
    ]);
    expect(order[2]).toEqual({ hex: ACCENTS.sky.base, accent: 'sky' });
    expect(new Set(order.map((t) => t.hex)).size).toBe(order.length);
    expect(accentOfHex('#123456')).toBeUndefined();
  });

  it('puts an own current colour right after the recently used ones when it is not among them', () => {
    expect(colorOrder([], '#123456')[0]).toEqual({ hex: '#123456' });
    expect(
      colorOrder(['#abcdef', '#123456'], '#123456')
        .map((t) => t.hex)
        .slice(0, 2),
    ).toEqual(['#abcdef', '#123456']);
    // Picks in "More colors" still lead.
    expect(
      colorOrder(['#78c895'], '#123456')
        .map((t) => t.hex)
        .slice(0, 3),
    ).toEqual(['#78c895', '#123456', ACCENTS.apricot.base]);
    expect(colorOrder([], '#78c895')).toEqual(colorOrder([]));
    expect(colorOrder([], 'sky')).toEqual(colorOrder([]));
  });

  it('shows one closed row, two or more only where fewer than five columns fit', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 9].map((c) => closedCount(c))).toEqual([5, 6, 6, 8, 5, 6, 7, 9]);
    expect(closedCount(0)).toBe(5);
    expect(closedCount(30, 23)).toBe(23);
  });

  it('keeps the selected colour in the closed row when the grid loses columns', () => {
    const order = colorOrder([]);
    const hexes = (tiles: { hex: string }[]) => tiles.map((t) => t.hex);
    // Coral, the sixth tile, picked with six columns: still there with five, in the row's last place.
    expect(hexes(closedTiles(order, 6, '#f08a7e'))).toEqual([...accents, '#f08a7e']);
    expect(hexes(closedTiles(order, 5, '#f08a7e'))).toEqual([...accents.slice(0, 4), '#f08a7e']);
    // A selected tile in the row: the plain first tiles.
    expect(hexes(closedTiles(order, 5, ACCENTS.sky.base))).toEqual(accents);
    expect(closedTiles(order, 4, '#f08a7e')).toHaveLength(8);
    // An unknown colour changes nothing.
    expect(hexes(closedTiles(order, 5, '#000000'))).toEqual(accents);
  });

  it('opens the grid with the closed row in place, then the rest of the order', () => {
    const order = colorOrder([]);
    const hexes = (tiles: { hex: string }[]) => tiles.map((t) => t.hex);
    // The selected Coral took the row's last place: it stays there, Rose follows the row.
    const row = closedTiles(order, 5, '#f08a7e');
    const open = openTiles(row, order);
    expect(hexes(open.slice(0, 5))).toEqual(hexes(row));
    expect(hexes(open.slice(5, 7))).toEqual([ACCENTS.rose.base, '#ecb655']);
    expect(open).toHaveLength(order.length);
    expect(new Set(hexes(open)).size).toBe(order.length);
  });

  it('counts the laid-out columns of a grid', () => {
    expect(trackCount('66px 66px 66.5px')).toBe(3);
    expect(trackCount('repeat(auto-fill, minmax(66px, 1fr))')).toBe(0);
    expect(trackCount('')).toBe(0);
  });

  it('keeps the recently used colours: most recent first, no duplicates, at most twelve', () => {
    expect(withRecent(['#111111', '#222222'], '#333333')).toEqual(['#333333', '#111111', '#222222']);
    expect(withRecent(['#111111', '#222222', '#333333'], '#222222')).toEqual(['#222222', '#111111', '#333333']);
    const full = Array.from({ length: RECENT_MAX }, (_, i): `#${string}` => `#0000${String(i).padStart(2, '0')}`);
    const next = withRecent(full, '#ffffff');
    expect(next).toHaveLength(RECENT_MAX);
    expect(next[0]).toBe('#ffffff');
    expect(next).not.toContain(full[RECENT_MAX - 1]);
  });

  it('stores the recently used colours in the session and clears them with it', () => {
    expect(recentOf()).toEqual([]);
    rememberColor('#78c895');
    rememberColor('#123456');
    expect(rememberColor('#78c895')).toEqual(['#78c895', '#123456']);
    expect(JSON.parse(sessionStorage.getItem('roedy-setup-accRecent') ?? '')).toEqual(['#78c895', '#123456']);
    expect(recentOf()).toEqual(['#78c895', '#123456']);
    clearSession();
    expect(recentOf()).toEqual([]);
    // Normalised and without anything invalid.
    writeSession('accRecent', JSON.stringify(['#ABC', 'nope', 7, '#aabbcc', '#123456']));
    expect(recentOf()).toEqual(['#aabbcc', '#123456']);
    writeSession('accRecent', '{broken');
    expect(recentOf()).toEqual([]);
    writeSession('accRecent', '{"a":1}');
    expect(recentOf()).toEqual([]);
  });
});

describe('Session of the tab', () => {
  it('starts a tab without setup data with System, System, Apricot at the first step', () => {
    expect(choicesOf()).toEqual({ lang: 'system', mode: 'system', accent: 'apricot' });
    const flow = new SetupFlow(hooks());
    expect(flow.step).toBe(1);
    expect(flow.name).toBe('');
    expect(readSession('step')).toBe('1');
  });

  it('keeps the choices, a custom accent as its hex value', () => {
    storeChoice({ lang: 'de', mode: 'dark', accent: 'sage' });
    expect(sessionStorage.getItem('roedy-setup-lang')).toBe('de');
    expect(sessionStorage.getItem('roedy-setup-dark')).toBe('1');
    expect(choicesOf()).toEqual({ lang: 'de', mode: 'dark', accent: 'sage' });
    storeChoice({ mode: 'light', accent: '#4a7bd0' });
    expect(sessionStorage.getItem('roedy-setup-accent')).toBe('custom');
    expect(sessionStorage.getItem('roedy-setup-accentHex')).toBe('#4a7bd0');
    expect(choicesOf()).toEqual({ lang: 'de', mode: 'light', accent: '#4a7bd0' });
    // A named accent again: the custom colour is dropped.
    storeChoice({ accent: 'rose' });
    expect(choicesOf().accent).toBe('rose');
    expect(customHexOf()).toBeNull();
    expect(sessionStorage.getItem('roedy-setup-accentHex')).toBeNull();
    storeChoice({ mode: 'system' });
    expect(choicesOf().mode).toBe('system');
    // Unknown values: the defaults.
    writeSession('lang', 'xx');
    writeSession('accentHex', 'nope');
    writeSession('accent', 'custom');
    expect(choicesOf()).toEqual({ lang: 'system', mode: 'system', accent: 'apricot' });
    expect(customHexOf()).toBeNull();
  });

  it('returns to step 2 after a reload on steps 3–7 with name and email, never token, password or key', async () => {
    mockApi({ 'POST setup/token': [{ body: {} }], 'POST setup/totp': [{ body: { secret: SECRET, uri: URI } }] });
    const flow = new SetupFlow(hooks());
    flow.editToken(TOKEN);
    await flow.submitToken();
    flow.edit('name', 'Anna Baker');
    flow.edit('email', 'anna@example.com');
    flow.submitAdmin();
    flow.edit('pw', 'Safe-enough1');
    flow.edit('pw2', 'Safe-enough1');
    flow.submitPw();
    expect(flow.step).toBe(5);
    expect(readSession('step')).toBe('5');
    await vi.waitFor(() => expect(flow.keyStatus).toBe('ready'));
    const stored = Object.keys(sessionStorage).filter((k) => k.startsWith('roedy-setup-'));
    expect(stored.sort()).toEqual(['roedy-setup-email', 'roedy-setup-name', 'roedy-setup-step']);
    expect(Object.values(sessionStorage)).not.toContain('Safe-enough1');
    expect(Object.values(sessionStorage)).not.toContain(TOKEN);
    expect(JSON.stringify(sessionStorage)).not.toContain(SECRET);

    // Reload: a new flow.
    const again = new SetupFlow(hooks());
    expect(again.step).toBe(2);
    expect(again.name).toBe('Anna Baker');
    expect(again.email).toBe('anna@example.com');
    expect(again.token).toBe('');
    expect(again.pw).toBe('');
    expect(again.key).toBeNull();
  });

  it('stays on the first step after a reload there', () => {
    expect(resumeStep()).toBe(1);
    writeSession('step', '1');
    expect(resumeStep()).toBe(1);
    writeSession('step', '4');
    expect(resumeStep()).toBe(2);
    writeSession('step', '7');
    expect(resumeStep()).toBe(2);
  });

  it('keeps the choices in memory when the storage refuses them, and sends them on completion', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    storeChoice({ lang: 'de', mode: 'dark', accent: '#4a7bd0' });
    expect(sessionStorage.length).toBe(0);
    expect(choicesOf()).toEqual({ lang: 'de', mode: 'dark', accent: '#4a7bd0' });
    expect(customHexOf()).toBe('#4a7bd0');
    const { flow } = at(7);
    const { calls } = mockApi({ 'POST setup/complete': [{ status: 201, body: { user: {} } }] });
    await flow.finish();
    expect(calls[0]?.body).toMatchObject({ settings: { lang: 'de', mode: 'dark', accent: '#4a7bd0' } });
    flow.dispose();
    clearSession();
    expect(choicesOf()).toEqual({ lang: 'system', mode: 'system', accent: 'apricot' });
  });

  it('removes all setup keys and nothing else', () => {
    storeChoice({ lang: 'en', accent: '#123456' });
    writeSession('name', 'Anna');
    sessionStorage.setItem('other', 'x');
    clearSession();
    expect(Object.keys(sessionStorage)).toEqual(['other']);
  });

  it('enters the current step with its first field', () => {
    const h = hooks();
    new SetupFlow(h).enter();
    expect(h.entered).toHaveBeenCalledWith(1, 'lang');
  });

  it('starts with the token step on "Get started", sending nothing', () => {
    const { calls } = mockApi({});
    const h = hooks();
    const flow = new SetupFlow(h);
    expect(flow.canBack).toBe(false);
    flow.start();
    expect(flow.step).toBe(2);
    expect(readSession('step')).toBe('2');
    expect(h.entered).toHaveBeenLastCalledWith(2, 'token');
    expect(flow.canBack).toBe(true);
    // Only from step 1.
    flow.start();
    expect(flow.step).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe('Step 2: setup token', () => {
  it('does nothing until all twelve characters are there, without an error', async () => {
    const h = hooks();
    const { calls } = mockApi({});
    const flow = new SetupFlow(h);
    flow.editToken('abcd-ef');
    expect(flow.tokFull).toBe(false);
    await flow.submitToken();
    expect(flow.tokErr).toBeNull();
    expect(h.fail).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    flow.editToken('abcd-efgh-jklm');
    expect(flow.tokFull).toBe(true);
  });

  it('takes pasted tokens with or without dashes, in any case, and Backspace', () => {
    const flow = new SetupFlow(hooks());
    flow.editToken('abcdefghjklm');
    expect(flow.token).toBe(TOKEN);
    flow.editToken('Setup-Token: abcd-EFGH-jklm');
    expect(flow.token).toBe(TOKEN);
    flow.editToken('ABCD-EFGH-JKL');
    expect(flow.token).toBe('ABCD-EFGH-JKL');
    flow.editToken('ABCD-');
    expect(flow.token).toBe('ABCD');
  });

  it('reports a wrong token with the remaining attempts; typing clears it', async () => {
    const h = hooks();
    mockApi({
      'POST setup/token': [
        { status: 422, body: { error: 'invalid_token', remaining: 4 } },
        { status: 422, body: { error: 'invalid_token', remaining: 1 } },
      ],
    });
    const flow = new SetupFlow(h);
    flow.editToken(TOKEN);
    await flow.submitToken();
    expect([flow.tokErr, flow.remaining, flow.token, flow.loading]).toEqual(['invalid', 4, TOKEN, false]);
    expect(h.fail).toHaveBeenLastCalledWith('token');
    await flow.submitToken();
    expect(flow.remaining).toBe(1);
    flow.editToken('ABCD');
    expect(flow.tokErr).toBeNull();
  });

  it('locks after 429 with retry_after, empties the boxes and releases afterwards', async () => {
    vi.useFakeTimers();
    const h = hooks();
    const { calls } = mockApi({
      'POST setup/token': [
        { status: 422, body: { error: 'invalid_token', remaining: 1 } },
        { status: 429, body: { error: 'rate_limited', retry_after: 30 } },
      ],
    });
    const flow = new SetupFlow(h);
    flow.editToken(TOKEN);
    await flow.submitToken();
    await flow.submitToken();
    expect([flow.locked, flow.tokErr, flow.token, flow.remaining]).toEqual([true, 'locked', '', null]);
    expect(flow.tokLeft).toBe(30);
    expect(h.fail).toHaveBeenLastCalledWith();
    vi.advanceTimersByTime(29_000);
    expect(flow.tokLeft).toBe(1);
    // While locked the page does not ask, and typing keeps the lock.
    flow.token = TOKEN;
    flow.editToken(TOKEN);
    expect(flow.tokErr).toBe('locked');
    await flow.submitToken();
    expect(calls).toHaveLength(2);
    vi.advanceTimersByTime(1_000);
    expect(flow.locked).toBe(false);
    expect(flow.tokErr).toBeNull();
    expect(h.entered).toHaveBeenCalledWith(2, 'token');
    flow.dispose();
  });

  it('starts the lock from retry_after after a reload (part of the 30 s)', async () => {
    vi.useFakeTimers();
    mockApi({ 'POST setup/token': [{ status: 429, body: { error: 'rate_limited', retry_after: 12 } }] });
    const flow = new SetupFlow(hooks());
    flow.editToken(TOKEN);
    await flow.submitToken();
    expect([flow.locked, flow.tokLeft]).toEqual([true, 12]);
    flow.dispose();
  });

  it('shows a server error in place; no attempt is used up and Continue checks again', async () => {
    const h = hooks();
    const { calls } = mockApi({
      'POST setup/token': [
        { status: 422, body: { error: 'invalid_token', remaining: 3 } },
        { status: 500, body: { error: 'internal' } },
        { body: {} },
      ],
    });
    const flow = new SetupFlow(h);
    flow.editToken(TOKEN);
    await flow.submitToken();
    await flow.submitToken();
    expect([flow.tokErr, flow.remaining, flow.token, flow.step]).toEqual(['server', 3, TOKEN, 2]);
    expect(h.error).not.toHaveBeenCalled();
    expect(h.fail).toHaveBeenLastCalledWith();
    await flow.submitToken();
    expect(calls).toHaveLength(3);
    expect(flow.step).toBe(3);
  });

  it('keeps an accepted token accepted when coming back, until it is edited', async () => {
    const { calls } = mockApi({ 'POST setup/token': [{ body: {} }, { body: {} }] });
    const flow = new SetupFlow(hooks());
    flow.editToken(TOKEN);
    await flow.submitToken();
    expect([flow.step, flow.tokOk]).toEqual([3, true]);
    flow.back();
    expect([flow.step, flow.token, flow.tokOk]).toEqual([2, TOKEN, true]);
    // Continue goes on without a new check.
    await flow.submitToken();
    expect(flow.step).toBe(3);
    expect(calls).toHaveLength(1);
    flow.back();
    // The same value again keeps it; any change makes it unaccepted.
    flow.editToken(TOKEN);
    expect(flow.tokOk).toBe(true);
    flow.editToken('ABCD-EFGH-JKL');
    expect(flow.tokOk).toBe(false);
    flow.editToken(TOKEN);
    expect(flow.tokOk).toBe(false);
    await flow.submitToken();
    expect(calls).toHaveLength(2);
    expect(flow.step).toBe(3);
  });

  it('continues with the right token', async () => {
    const h = hooks();
    const { calls } = mockApi({ 'POST setup/token': [{ body: {} }] });
    const flow = new SetupFlow(h);
    flow.editToken('abcdefghjklm');
    await flow.submitToken();
    expect(calls[0]?.body).toEqual({ token: TOKEN });
    expect(flow.step).toBe(3);
    expect(h.entered).toHaveBeenCalledWith(3, 'name');
  });

  it('keeps the token while it is being checked', async () => {
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    const { calls } = mockApi({ 'POST setup/token': [() => new Promise((resolve) => (answer = resolve))] });
    const flow = new SetupFlow(hooks());
    flow.editToken(TOKEN);
    const pending = flow.submitToken();
    flow.editToken('ZZZZ-ZZZZ-ZZZZ');
    expect(flow.token).toBe(TOKEN);
    answer({ status: 200, body: {} });
    await pending;
    expect(flow.step).toBe(3);
    expect(calls[0]?.body).toEqual({ token: TOKEN });
  });

  it('reloads if the setup is already complete', async () => {
    const h = hooks();
    mockApi({ 'POST setup/token': [{ status: 409, body: { error: 'setup_done' } }] });
    const flow = new SetupFlow(h);
    flow.editToken(TOKEN);
    await flow.submitToken();
    expect(h.reload).toHaveBeenCalled();
  });
});

describe('Steps 3 and 4', () => {
  it('checks the name while typing and cuts it at 100 characters', () => {
    const { flow } = at(3);
    flow.edit('name', 'Anna Baker (Admin 1)');
    expect(flow.err.name).toBe('Use letters, spaces, hyphens and apostrophes only.');
    expect(flow.adminReady).toBe(false);
    flow.edit('name', 'Anna O’Brien-Müller');
    expect(flow.err.name).toBeUndefined();
    expect(flow.adminReady).toBe(true);
    // Pasting is cut off too; no error at the limit.
    flow.edit('name', 'Anna Baker '.repeat(12));
    expect(flow.name).toHaveLength(100);
    expect(flow.err.name).toBeUndefined();
    expect(readSession('name')).toBe(flow.name);
  });

  it('is ready only with a valid name and a valid address', () => {
    const { flow } = at(3);
    expect(flow.adminReady).toBe(true);
    flow.edit('email', 'anna@example');
    expect(flow.adminReady).toBe(false);
    flow.edit('email', ' anna@example.com ');
    flow.edit('name', '   ');
    expect(flow.adminReady).toBe(false);
  });

  it('moves to the first empty or invalid field, with a message for the name only', () => {
    const { flow, h } = at(3);
    flow.edit('name', ' ');
    flow.edit('email', '');
    flow.submitAdmin();
    expect(h.focus).toHaveBeenLastCalledWith('name');
    flow.edit('name', 'Anna Baker 2');
    flow.submitAdmin();
    expect(h.focus).toHaveBeenLastCalledWith('email');
    flow.edit('email', 'anna@example');
    flow.submitAdmin();
    // Invalid name: its message and the shake (`fail`), before the address.
    expect(flow.err).toEqual({ name: 'Use letters, spaces, hyphens and apostrophes only.' });
    expect(h.fail).toHaveBeenLastCalledWith('name');
    flow.edit('name', 'Anna O’Brien-Müller ');
    flow.submitAdmin();
    expect(h.focus).toHaveBeenLastCalledWith('email');
    expect(flow.err).toEqual({});
    expect(h.fail).toHaveBeenCalledTimes(1);
    expect(flow.step).toBe(3);
    flow.edit('email', ' anna@example.com');
    flow.submitAdmin();
    expect(flow.step).toBe(4);
    expect([readSession('name'), readSession('email')]).toEqual(['Anna O’Brien-Müller', 'anna@example.com']);
  });

  it('checks policy, length and repetition of the password', () => {
    const { flow, h } = at(4);
    flow.edit('pw', '');
    flow.edit('pw2', '');
    expect(flow.pwReady).toBe(false);
    // Incomplete: no message, the focus moves to the field that is missing something.
    flow.edit('pw', 'tooshort');
    flow.submitPw();
    expect(h.focus).toHaveBeenLastCalledWith('pw');
    expect(flow.err).toEqual({});
    // Too long shows while typing and goes again as soon as it fits.
    flow.edit('pw', `A1${'a'.repeat(1023)}`);
    expect(flow.err.pw).toBe('The password is too long (1024 bytes at most).');
    flow.submitPw();
    expect(h.focus).toHaveBeenLastCalledWith('pw');
    flow.edit('pw', 'Safe-enough1');
    expect(flow.err.pw).toBeUndefined();
    flow.submitPw();
    expect(h.focus).toHaveBeenLastCalledWith('pw2');
    expect(h.fail).not.toHaveBeenCalled();
    // A filled confirmation that differs: its message with the shake; a new password clears it.
    flow.edit('pw2', 'Safe-enough2');
    expect(flow.pwReady).toBe(false);
    flow.submitPw();
    expect(flow.err.pw2).toBe('The passwords don’t match.');
    expect(h.fail).toHaveBeenCalledWith('pw2');
    flow.edit('pw', 'Safe-enough2');
    expect(flow.err.pw2).toBeUndefined();
    expect(flow.pwReady).toBe(true);
    flow.submitPw();
    expect(flow.step).toBe(5);
    expect(h.entered).toHaveBeenLastCalledWith(5, 'heading');
    // Kept in memory for the way back.
    flow.back();
    expect([flow.step, flow.pw, flow.pw2, flow.pwReady]).toEqual([4, 'Safe-enough2', 'Safe-enough2', true]);
    expect(Object.keys(sessionStorage).filter((k) => /pw|password/.test(k))).toEqual([]);
  });

  it('goes back keeping everything entered, not from the first step', () => {
    const { flow, h } = at(4);
    flow.back();
    expect(flow.step).toBe(3);
    expect(h.entered).toHaveBeenLastCalledWith(3, 'name');
    expect([flow.name, flow.email, flow.pw]).toEqual(['Anna Baker', 'anna@example.com', 'Safe-enough1']);
    flow.back();
    expect(flow.step).toBe(2);
    expect(flow.token).toBe(TOKEN);
    flow.back();
    expect(flow.step).toBe(1);
    expect(h.entered).toHaveBeenLastCalledWith(1, 'lang');
    expect(flow.canBack).toBe(false);
    flow.back();
    expect(flow.step).toBe(1);
    expect(flow.token).toBe(TOKEN);
  });
});

describe('Step 5: authenticator app', () => {
  /** From step 4 into step 5 (Continue sends nothing itself; entering the step asks for the key). */
  function intoMfa(h = hooks()) {
    const ctx = at(4, h);
    ctx.flow.submitPw();
    return ctx;
  }

  it('asks for the key once per email on entering, keeps it in memory only and shows it again', async () => {
    const { calls } = mockApi({ 'POST setup/totp': [{ body: { secret: SECRET, uri: URI } }] });
    const { flow, h } = intoMfa();
    expect(flow.step).toBe(5);
    // Placeholders meanwhile: the code field is locked, the heading has the focus.
    expect([flow.keyStatus, flow.otpOff]).toEqual(['loading', true]);
    expect(h.entered).toHaveBeenLastCalledWith(5, 'heading');
    await vi.waitFor(() => expect(flow.keyStatus).toBe('ready'));
    // The key is there: the code field, unless the focus moved on meanwhile (the page decides).
    expect(h.refocus).toHaveBeenLastCalledWith('otp');
    expect(calls[0]?.body).toEqual({ email: 'anna@example.com' });
    expect(calls[0]?.headers['X-Setup-Token']).toBe(TOKEN);
    expect(flow.secretLabel).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(flow.qr?.size).toBeGreaterThan(20);
    expect(flow.otpOff).toBe(false);
    expect(JSON.stringify(sessionStorage)).not.toContain(SECRET);

    // Back and Continue again: the same key, no new request; the typed code is cleared.
    flow.otp = '12';
    flow.back();
    expect(flow.step).toBe(4);
    flow.submitPw();
    expect([flow.step, flow.keyStatus, flow.otp]).toEqual([5, 'ready', '']);
    expect(h.entered).toHaveBeenLastCalledWith(5, 'otp');
    expect(calls).toHaveLength(1);
  });

  it('asks for a new key when the email changed on step 3, dropping the code and the recovery codes', async () => {
    const other = `otpauth://totp/Roedy%20Mail:ben%40example.com?secret=${'A'.repeat(32)}`;
    const { calls } = mockApi({ 'POST setup/totp': [{ body: { secret: 'A'.repeat(32), uri: other } }] });
    const { flow } = at(7);
    flow.revisit(3);
    flow.edit('email', 'ben@example.com');
    flow.submitAdmin();
    flow.submitPw();
    expect([flow.step, flow.keyStatus, flow.codes, flow.saved]).toEqual([5, 'loading', [], false]);
    await vi.waitFor(() => expect(flow.keyStatus).toBe('ready'));
    expect(calls.map((c) => c.body)).toEqual([{ email: 'ben@example.com' }]);
    expect(flow.keyNow?.secret).toBe('A'.repeat(32));
  });

  it('sends one key request at a time, keeps one per email and only the answer of the last one', async () => {
    let first: (a: { body: unknown }) => void = () => {};
    let second: (a: { body: unknown }) => void = () => {};
    const { calls } = mockApi({
      'POST setup/totp': [
        () => new Promise((resolve) => (first = resolve)),
        () => new Promise((resolve) => (second = resolve)),
      ],
    });
    const { flow } = intoMfa();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // Back while the key is being created (Back stays usable), forward again: no second request.
    flow.back();
    flow.submitPw();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    // Another email meanwhile: a new request, sent only once the first one has its answer (the server keeps the key
    // of the request it stores last); that answer no longer counts.
    flow.revisit(3);
    flow.edit('email', 'ben@example.com');
    flow.submitAdmin();
    flow.submitPw();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
    expect(flow.keyStatus).toBe('loading');
    first({ body: { secret: SECRET, uri: URI } });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.body).toEqual({ email: 'ben@example.com' });
    // Anna's answer came and was dropped: no key until Ben's.
    await Promise.resolve();
    expect([flow.key, flow.keyState]).toEqual([null, 'loading']);
    second({ body: { secret: 'B'.repeat(32), uri: URI } });
    await vi.waitFor(() => expect(flow.keyStatus).toBe('ready'));
    expect(flow.keyNow?.secret).toBe('B'.repeat(32));
    expect(flow.key?.email).toBe('ben@example.com');
  });

  it('does not send a waiting key request once a newer one waits behind it', async () => {
    let first: (a: { body: unknown }) => void = () => {};
    const { calls } = mockApi({
      'POST setup/totp': [
        () => new Promise((resolve) => (first = resolve)),
        { body: { secret: 'C'.repeat(32), uri: URI } },
      ],
    });
    const { flow } = intoMfa();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    for (const email of ['ben@example.com', 'cleo@example.com']) {
      flow.revisit(3);
      flow.edit('email', email);
      flow.submitAdmin();
      flow.submitPw();
    }
    first({ body: { secret: SECRET, uri: URI } });
    await vi.waitFor(() => expect(flow.keyStatus).toBe('ready'));
    // Anna's request and Cleo's; Ben's was never sent.
    expect(calls.map((c) => c.body)).toEqual([{ email: 'anna@example.com' }, { email: 'cleo@example.com' }]);
    expect(flow.keyNow?.secret).toBe('C'.repeat(32));
  });

  it('shows the failed key with "Try again", which asks again', async () => {
    const { calls } = mockApi({
      'POST setup/totp': [{ status: 500, body: {} }, { body: { secret: SECRET, uri: URI } }],
    });
    const { flow, h } = intoMfa();
    await vi.waitFor(() => expect(flow.keyStatus).toBe('failed'));
    expect(h.refocus).toHaveBeenLastCalledWith('retry');
    expect(flow.otpOff).toBe(true);
    expect(h.error).not.toHaveBeenCalled();
    flow.retryKey();
    expect(flow.keyStatus).toBe('loading');
    await vi.waitFor(() => expect(flow.keyStatus).toBe('ready'));
    expect(h.refocus).toHaveBeenLastCalledWith('otp');
    expect(calls).toHaveLength(2);
  });

  it('asks again by itself once the server answers after the key got no answer', async () => {
    const offline = vi.fn();
    const { calls } = mockApi({ 'POST setup/totp': [] });
    const { flow } = intoMfa({ ...hooks(), offline } as ReturnType<typeof hooks>);
    await vi.waitFor(() => expect(offline).toHaveBeenCalledOnce());
    // Placeholders stay until the next attempt.
    expect(flow.keyStatus).toBe('loading');
    mockApi({ 'POST setup/totp': [{ body: { secret: SECRET, uri: URI } }] });
    flow.online();
    await vi.waitFor(() => expect(flow.keyStatus).toBe('ready'));
    expect(calls).toHaveLength(1);
    // Only on step 5, and only for a key that got no answer.
    flow.online();
    expect(flow.keyStatus).toBe('ready');
  });

  it('returns to the token step when the key request has a wrong token', async () => {
    mockApi({ 'POST setup/totp': [{ status: 422, body: { error: 'invalid_token', remaining: 3 } }] });
    const { flow, h } = intoMfa();
    await vi.waitFor(() => expect(flow.step).toBe(2));
    expect([flow.tokErr, flow.remaining, flow.tokOk]).toEqual(['invalid', 3, false]);
    expect(h.fail).toHaveBeenLastCalledWith('token');
  });

  it('keeps digits only and confirms by itself with the sixth one', async () => {
    const { calls } = mockApi({ 'POST setup/totp/verify': [{ body: { recovery_codes: CODES } }] });
    const { flow, h } = at(5);
    flow.editOtp('12a3');
    expect(flow.otp).toBe('123');
    expect(calls).toHaveLength(0);
    // Pasted with a space.
    flow.editOtp('123 456');
    expect(flow.otp).toBe('123456');
    expect(flow.loading).toBe(true);
    // Locked while it is being checked: no edit, no second check, no Back.
    flow.editOtp('1');
    flow.back();
    await flow.submitOtp();
    expect([flow.otp, flow.step]).toEqual(['123456', 5]);
    await vi.waitFor(() => expect(flow.step).toBe(6));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ code: '123456' });
    expect(calls[0]?.headers['X-Setup-Token']).toBe(TOKEN);
    expect(flow.codes).toEqual(CODES);
    // The recovery codes: reading them comes first, so the heading.
    expect(h.entered).toHaveBeenLastCalledWith(6, 'heading');
    // Back on the codes returns to step 5: the same key, an empty code field.
    flow.back();
    expect([flow.step, flow.keyStatus, flow.otp, flow.codes]).toEqual([5, 'ready', '', CODES]);
    expect(JSON.stringify(sessionStorage)).not.toContain(CODES[0]);
  });

  it('asks for all six digits on Confirm, with the shake; any edit clears it', async () => {
    const { calls } = mockApi({});
    const { flow, h } = at(5);
    await flow.submitOtp();
    expect(flow.otpErr).toBe('short');
    expect(h.fail).toHaveBeenLastCalledWith('otp');
    flow.editOtp('12');
    expect(flow.otpErr).toBeNull();
    await flow.submitOtp();
    expect(flow.otpErr).toBe('short');
    expect(calls).toHaveLength(0);
  });

  it('clears a wrong or used code and shows "Invalid code."; the next digit clears the message', async () => {
    mockApi({
      'POST setup/totp/verify': [
        { status: 422, body: { error: 'invalid_code' } },
        { status: 422, body: { error: 'code_used' } },
      ],
    });
    const { flow, h } = at(5);
    flow.editOtp('111111');
    await vi.waitFor(() => expect(flow.otpErr).toBe('invalid'));
    expect([flow.otp, flow.loading, flow.step]).toEqual(['', false, 5]);
    expect(h.fail).toHaveBeenLastCalledWith('otp');
    flow.editOtp('2');
    expect(flow.otpErr).toBeNull();
    flow.editOtp('222222');
    await vi.waitFor(() => expect(flow.otpErr).toBe('invalid'));
    expect(flow.otp).toBe('');
  });

  it('locks the field after 429 with a countdown from retry_after and releases it afterwards', async () => {
    vi.useFakeTimers();
    const { calls } = mockApi({
      'POST setup/totp/verify': [{ status: 429, body: { error: 'rate_limited', retry_after: 90 } }],
    });
    const { flow, h } = at(5);
    flow.editOtp('333333');
    await vi.waitFor(() => expect(flow.codeLocked).toBe(true));
    expect([flow.otp, flow.otpErr, flow.otpOff, flow.codeLeft, flow.step]).toEqual(['', null, true, 90, 5]);
    // The shake, no field to focus (it is disabled).
    expect(h.fail).toHaveBeenLastCalledWith();
    // Nothing goes in while locked.
    flow.editOtp('4');
    await flow.submitOtp();
    expect([flow.otp, flow.otpErr]).toEqual(['', null]);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(flow.codeLeft).toBe(60);
    await vi.advanceTimersByTimeAsync(60_000);
    expect([flow.codeLocked, flow.otpOff]).toEqual([false, false]);
    expect(h.refocus).toHaveBeenLastCalledWith('otp');
    flow.dispose();
  });

  it('enters with the heading while the field is still locked', async () => {
    vi.useFakeTimers();
    mockApi({ 'POST setup/totp/verify': [{ status: 429, body: { error: 'rate_limited', retry_after: 60 } }] });
    const { flow, h } = at(5);
    flow.editOtp('333333');
    await vi.waitFor(() => expect(flow.codeLocked).toBe(true));
    // Back during the lock (allowed) and Continue again: the key is there, the field still locked.
    flow.back();
    flow.submitPw();
    expect([flow.step, flow.keyStatus, flow.otpOff]).toEqual([5, 'ready', true]);
    expect(h.entered).toHaveBeenLastCalledWith(5, 'heading');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.refocus).toHaveBeenLastCalledWith('otp');
    flow.dispose();
  });

  it('runs the lock bar against the 15 minutes of the server', () => {
    expect(CODE_LOCK_S).toBe(900);
  });

  it('keeps the code on a server error, which does not count; Confirm checks again', async () => {
    const { calls } = mockApi({
      'POST setup/totp/verify': [{ status: 500, body: {} }, { body: { recovery_codes: CODES } }],
    });
    const { flow, h } = at(5);
    flow.editOtp('555555');
    await vi.waitFor(() => expect(flow.otpErr).toBe('server'));
    expect([flow.otp, flow.loading, flow.codeLocked]).toEqual(['555555', false, false]);
    expect(h.fail).toHaveBeenLastCalledWith('otp');
    expect(h.error).not.toHaveBeenCalled();
    await flow.submitOtp();
    expect(flow.step).toBe(6);
    expect(calls).toHaveLength(2);
  });

  it('asks for a new key when the server no longer has one', async () => {
    const { calls } = mockApi({
      'POST setup/totp/verify': [{ status: 422, body: { error: 'totp_required' } }],
      'POST setup/totp': [{ body: { secret: 'C'.repeat(32), uri: URI } }],
    });
    const { flow } = at(5);
    flow.codes = [...CODES];
    flow.saved = true;
    flow.editOtp('666666');
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect([flow.otp, flow.codes, flow.saved]).toEqual(['', [], false]);
    await vi.waitFor(() => expect(flow.keyNow?.secret).toBe('C'.repeat(32)));
  });

  it('returns to the token step when the check has a wrong token', async () => {
    mockApi({ 'POST setup/totp/verify': [{ status: 422, body: { error: 'invalid_token', remaining: 4 } }] });
    const { flow } = at(5);
    flow.editOtp('777777');
    await vi.waitFor(() => expect(flow.step).toBe(2));
    expect(flow.tokErr).toBe('invalid');
    // The key stays for this email: back on step 5 it shows again without a new request.
    expect(flow.keyStatus).toBe('ready');
  });
});

describe('Step 6: recovery codes', () => {
  it('enters with the heading and sends nothing; Continue needs the ticked box', async () => {
    const { calls } = mockApi({ 'POST setup/totp/verify': [{ body: { recovery_codes: CODES } }] });
    const { flow, h } = at(5);
    flow.editOtp('123456');
    await vi.waitFor(() => expect(flow.step).toBe(6));
    expect(h.entered).toHaveBeenLastCalledWith(6, 'heading');
    expect([flow.codes, flow.saved, flow.savedErr]).toEqual([CODES, false, false]);
    // Unticked: the error, the shake and the focus on the checkbox; Continue is never greyed out.
    flow.submitCodes();
    expect([flow.step, flow.savedErr]).toEqual([6, true]);
    expect(h.fail).toHaveBeenLastCalledWith('saved');
    // Ticking clears the error; ticked, Continue opens the review.
    flow.toggleSaved();
    expect([flow.saved, flow.savedErr]).toEqual([true, false]);
    flow.submitCodes();
    expect(flow.step).toBe(7);
    expect(h.entered).toHaveBeenLastCalledWith(7, 'heading');
    expect(h.fail).toHaveBeenCalledOnce();
    expect(calls.map((c) => c.path)).toEqual(['setup/totp/verify']);
  });

  it('clears the error with any click on the box and only toggles on step 6', () => {
    const { flow } = at(6);
    flow.submitCodes();
    flow.toggleSaved();
    flow.toggleSaved();
    expect([flow.saved, flow.savedErr]).toEqual([false, false]);
    flow.submitCodes();
    expect(flow.savedErr).toBe(true);
    // Leaving the step drops the error, not the box.
    flow.toggleSaved();
    flow.back();
    expect([flow.step, flow.saved, flow.savedErr]).toEqual([5, true, false]);
    flow.toggleSaved();
    flow.submitCodes();
    expect([flow.step, flow.saved]).toEqual([5, true]);
  });

  it('keeps the codes and the ticked box after Back and "Change", in memory only', async () => {
    mockApi({ 'POST setup/totp/verify': [{ body: { recovery_codes: CODES } }, { body: { recovery_codes: CODES } }] });
    const { flow, h } = at(7);
    flow.back();
    expect([flow.step, flow.codes, flow.saved, flow.savedErr]).toEqual([6, CODES, true, false]);
    expect(h.entered).toHaveBeenLastCalledWith(6, 'heading');
    flow.back();
    expect([flow.step, flow.keyStatus]).toEqual([5, 'ready']);
    // The same key brings the same codes again: the box stays ticked.
    flow.editOtp('123456');
    await vi.waitFor(() => expect(flow.step).toBe(6));
    expect([flow.codes, flow.saved]).toEqual([CODES, true]);
    flow.submitCodes();
    expect(flow.step).toBe(7);
    // "Change" on the review and forward again through the steps.
    flow.revisit(3);
    flow.submitAdmin();
    flow.submitPw();
    expect(flow.step).toBe(5);
    flow.editOtp('654321');
    await vi.waitFor(() => expect(flow.step).toBe(6));
    expect([flow.codes, flow.saved]).toEqual([CODES, true]);
    const stored = JSON.stringify(sessionStorage);
    expect(stored).not.toContain(CODES[0]);
    expect(stored).not.toContain('saved');
  });

  it('unticks the box for new codes', async () => {
    const others = CODES.map((c) => c.replace('ABCD', 'WXYZ'));
    mockApi({ 'POST setup/totp/verify': [{ body: { recovery_codes: others } }] });
    const { flow } = at(7);
    flow.back();
    flow.back();
    flow.editOtp('123456');
    await vi.waitFor(() => expect(flow.step).toBe(6));
    expect([flow.codes, flow.saved]).toEqual([others, false]);
  });

  it('forgets the codes and the box on a reload', () => {
    const { flow } = at(7);
    flow.go(7);
    expect([readSession('step'), flow.saved]).toEqual(['7', true]);
    const again = new SetupFlow(hooks());
    expect([again.step, again.codes, again.saved]).toEqual([2, [], false]);
  });

  it('never finishes the setup without passing step 6', async () => {
    const { calls } = mockApi({});
    // On the review without the ticked box: back to step 6 with its error.
    const { flow, h } = at(7);
    flow.saved = false;
    await flow.finish();
    expect([flow.step, flow.savedErr, flow.loading]).toEqual([6, true, false]);
    expect(h.entered).toHaveBeenLastCalledWith(6, null);
    expect(h.fail).toHaveBeenLastCalledWith('saved');
    // Without recovery codes: back to step 5 for the code.
    flow.step = 7;
    flow.saved = true;
    flow.codes = [];
    await flow.finish();
    expect(flow.step).toBe(5);
    expect(h.entered).toHaveBeenLastCalledWith(5, 'otp');
    expect(calls).toHaveLength(0);
  });
});

describe('Step 7: completion', () => {
  it('summarises the steps, never the password', () => {
    storeChoice({ lang: 'en', mode: 'dark', accent: 'apricot' });
    const { flow } = at(7);
    const rows = flow.review.map((r) => [r.step, r.icon, r.ini, r.label, r.value, r.sub, r.masked]);
    expect(rows).toEqual([
      [1, 'ti-palette', '', 'Language and appearance', 'English · Dark · Apricot', '', false],
      [3, 'ti-user-shield', 'AB', 'Administrator', 'Anna Baker', 'anna@example.com', false],
      [4, 'ti-lock', '', 'Password', MASKED_PW, 'Set', true],
      [
        5,
        'ti-shield-check',
        '',
        'Multi-factor authentication',
        'Authenticator app',
        'Set up, 10 recovery codes',
        false,
      ],
    ]);
    expect(JSON.stringify(flow.review)).not.toContain(flow.pw);
  });

  it('names the language by its own name, the theme and the accent', () => {
    expect(choicesSummary({ lang: 'system', mode: 'system', accent: 'sage' })).toBe('System · System · Sage');
    expect(choicesSummary({ lang: 'de', mode: 'light', accent: 'rose' })).toBe('Deutsch · Light · Rose');
    // A custom colour: its preset name or "Custom #RRGGBB".
    expect(choicesSummary({ lang: 'en', mode: 'dark', accent: '#4a7bd0' })).toBe('English · Dark · Custom #4A7BD0');
    expect(choicesSummary({ lang: 'en', mode: 'dark', accent: '#f08a7e' })).toBe('English · Dark · Coral');
  });

  it('reads the choices fresh after "Change" on step 1', () => {
    storeChoice({ lang: 'en', mode: 'dark', accent: 'apricot' });
    const { flow } = at(7);
    expect(flow.review[0]?.value).toBe('English · Dark · Apricot');
    flow.revisit(1);
    storeChoice({ mode: 'light', accent: 'sky' });
    expect(flow.review[0]?.value).toBe('English · Light · Sky');
  });

  it('walks forward from "Change" keeping the accepted token and the passwords', async () => {
    const { calls } = mockApi({});
    const { flow, h } = at(7);
    flow.revisit(1);
    expect(h.entered).toHaveBeenLastCalledWith(1, 'lang');
    flow.start();
    // The accepted token goes on without a new check.
    await flow.submitToken();
    expect(flow.step).toBe(3);
    flow.submitAdmin();
    expect(flow.step).toBe(4);
    expect([flow.pw, flow.pw2]).toEqual(['Safe-enough1', 'Safe-enough1']);
    flow.submitPw();
    // The key for the email is still there: no new request, and no skipping the code.
    expect(flow.step).toBe(5);
    expect(flow.keyStatus).toBe('ready');
    expect(calls).toHaveLength(0);
    flow.revisit(3);
    expect(h.entered).toHaveBeenLastCalledWith(3, 'name');
    flow.revisit(4);
    expect(h.entered).toHaveBeenLastCalledWith(4, 'pw');
  });

  it('leads "Change" on multi-factor authentication to step 5 with the same key, then forward through step 6', async () => {
    const { calls } = mockApi({ 'POST setup/totp/verify': [{ body: { recovery_codes: CODES } }] });
    const { flow, h } = at(7);
    flow.otp = '123456';
    flow.revisit(5);
    // Same QR code and key, an empty code field; no new key requested.
    expect([flow.step, flow.keyStatus, flow.keyNow?.secret, flow.otp]).toEqual([5, 'ready', SECRET, '']);
    expect(h.entered).toHaveBeenLastCalledWith(5, 'otp');
    flow.editOtp('654321');
    await vi.waitFor(() => expect(flow.step).toBe(6));
    // Same codes, the box as left.
    expect([flow.codes, flow.saved]).toEqual([CODES, true]);
    flow.submitCodes();
    expect(flow.step).toBe(7);
    expect(calls.map((c) => c.path)).toEqual(['setup/totp/verify']);
  });

  it('sets up with the stored appearance, shows the done screen, then signs in', async () => {
    vi.useFakeTimers();
    storeChoice({ lang: 'de', mode: 'dark', accent: '#4a7bd0' });
    const signedIn = vi.fn(() => Promise.resolve());
    const { flow, h } = at(7, { ...hooks(), signedIn });
    // A tab from a copied table cell: checked and sent as a space.
    flow.name = ' Anna\tBaker ';
    const { calls } = mockApi({ 'POST setup/complete': [{ status: 201, body: { user: {} } }] });
    await flow.finish();
    expect(calls[0]?.headers['X-Setup-Token']).toBe(TOKEN);
    expect(calls[0]?.body).toEqual({
      name: 'Anna Baker',
      email: 'anna@example.com',
      password: 'Safe-enough1',
      settings: { lang: 'de', mode: 'dark', accent: '#4a7bd0' },
    });
    expect(flow.view).toBe('done');
    expect(h.entered).toHaveBeenLastCalledWith(7, 'heading');
    expect(flow.firstName).toBe('Anna');
    expect([flow.pw, flow.pw2, flow.token]).toEqual(['', '', '']);
    expect([flow.key, flow.codes, flow.saved]).toEqual([null, [], false]);
    vi.advanceTimersByTime(DONE_MS - 1);
    expect(signedIn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(signedIn).toHaveBeenCalledOnce();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('shows any other answer in place, with the shake, until the next "Finish setup"', async () => {
    const { flow, h } = at(7);
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    mockApi({
      'POST setup/complete': [
        { status: 500, body: {} },
        { status: 422, body: { error: 'invalid', fields: { name: { code: 'invalid' } } } },
        () => new Promise((resolve) => (answer = resolve)),
      ],
    });
    await flow.finish();
    expect([flow.step, flow.finishErr, flow.loading]).toEqual([7, true, false]);
    expect(h.fail).toHaveBeenCalledOnce();
    expect(h.error).not.toHaveBeenCalled();
    // Steps 3 and 4 already checked the fields with the server's rules: a field error is just another answer.
    await flow.finish();
    expect([flow.step, flow.finishErr, flow.err]).toEqual([7, true, {}]);
    const pending = flow.finish();
    expect([flow.finishErr, flow.loading]).toEqual([false, true]);
    answer({ status: 201, body: {} });
    await pending;
    expect(flow.view).toBe('done');
    flow.dispose();
  });

  it('allows neither going back nor to a step during completion', async () => {
    const { flow } = at(7);
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    mockApi({ 'POST setup/complete': [() => new Promise((resolve) => (answer = resolve))] });
    const pending = flow.finish();
    expect(flow.loading).toBe(true);
    // Back stays (locked, not hidden).
    expect(flow.canBack).toBe(true);
    flow.back();
    flow.revisit(3);
    expect(flow.step).toBe(7);
    answer({ status: 201, body: {} });
    await pending;
    expect(flow.view).toBe('done');
    flow.dispose();
  });

  it('reloads on setup_done (the layout then shows the sign-in)', async () => {
    const { flow, h } = at(7);
    mockApi({ 'POST setup/complete': [{ status: 409, body: { error: 'setup_done' } }] });
    await flow.finish();
    expect(h.reload).toHaveBeenCalledOnce();
    expect([flow.view, flow.finishErr, flow.loading]).toEqual(['form', false, false]);
  });

  it('shows "No connection" when a request gets no answer, everything entered stays', async () => {
    const offline = vi.fn();
    const { flow, h } = at(7, { ...hooks(), offline } as ReturnType<typeof hooks>);
    mockApi({});
    await flow.finish();
    expect(offline).toHaveBeenCalledOnce();
    expect(h.error).not.toHaveBeenCalled();
    expect([flow.step, flow.loading, flow.pw]).toEqual([7, false, 'Safe-enough1']);
  });

  it('goes back to step 5 with a new key when the confirmed one is gone', async () => {
    const { calls } = mockApi({
      'POST setup/complete': [{ status: 422, body: { error: 'totp_required' } }],
      'POST setup/totp': [{ body: { secret: 'D'.repeat(32), uri: URI } }],
    });
    const { flow, h } = at(7);
    await flow.finish();
    expect([flow.step, flow.finishErr, flow.codes, flow.keyStatus]).toEqual([5, false, [], 'loading']);
    // The new key brings new codes: the box is unticked again.
    expect(flow.saved).toBe(false);
    expect(h.fail).not.toHaveBeenCalled();
    expect(h.entered).toHaveBeenLastCalledWith(5, 'heading');
    await vi.waitFor(() => expect(flow.keyNow?.secret).toBe('D'.repeat(32)));
    expect(calls.map((c) => c.path)).toEqual(['setup/complete', 'setup/totp']);
  });

  it('returns to the token step on a wrong or locked token', async () => {
    vi.useFakeTimers();
    const { flow, h } = at(7);
    mockApi({
      'POST setup/complete': [
        { status: 422, body: { error: 'invalid_token', remaining: 2 } },
        { status: 429, body: { error: 'rate_limited', retry_after: 12 } },
      ],
    });
    await flow.finish();
    expect(flow.step).toBe(2);
    expect([flow.tokErr, flow.tokOk]).toEqual(['invalid', false]);
    expect(h.fail).toHaveBeenLastCalledWith('token');
    flow.step = 7;
    await flow.finish();
    expect(flow.step).toBe(2);
    expect([flow.tokErr, flow.tokLeft, flow.tokOk]).toEqual(['locked', 12, false]);
    flow.dispose();
  });
});
