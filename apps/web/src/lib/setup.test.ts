import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { ACCENTS } from '@roedy/tokens';
import { PRESETS } from '#lib/color-editor.svelte.ts';
import {
  DONE_MS,
  MASKED_PW,
  RECENT_MAX,
  SetupFlow,
  accentOfHex,
  choicesOf,
  choicesSummary,
  clearSession,
  closedCount,
  colorOrder,
  customHexOf,
  formatToken,
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearSession();
  sessionStorage.clear();
});

function hooks() {
  return {
    fail: vi.fn<(field?: Field) => void>(),
    focus: vi.fn<(field: Field) => void>(),
    entered: vi.fn<(step: Step, focus: Focus | null) => void>(),
    error: vi.fn<(text: string) => void>(),
    reload: vi.fn(() => Promise.resolve()),
    signedIn: vi.fn(() => Promise.resolve()),
  };
}

/** Flow up to the start of step `step` (without API, fields as after the steps). */
function at(step: 3 | 4 | 5, h = hooks()) {
  const flow = new SetupFlow(h);
  flow.token = TOKEN;
  flow.tokOk = true;
  flow.name = 'Anna Baker';
  flow.email = 'anna@example.com';
  flow.pw = 'Safe-enough1';
  flow.pw2 = 'Safe-enough1';
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

  it('puts an own current colour first when it is not among the recently used ones', () => {
    expect(colorOrder([], '#123456')[0]).toEqual({ hex: '#123456' });
    expect(
      colorOrder(['#abcdef', '#123456'], '#123456')
        .map((t) => t.hex)
        .slice(0, 2),
    ).toEqual(['#abcdef', '#123456']);
    expect(colorOrder([], '#78c895')).toEqual(colorOrder([]));
    expect(colorOrder([], 'sky')).toEqual(colorOrder([]));
  });

  it('shows one closed row, two or more only where fewer than five columns fit', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 9].map((c) => closedCount(c))).toEqual([5, 6, 6, 8, 5, 6, 7, 9]);
    expect(closedCount(0)).toBe(5);
    expect(closedCount(30, 23)).toBe(23);
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

  it('returns to step 2 after a reload on steps 3–5 with name and email, never token or password', async () => {
    mockApi({ 'POST setup/token': [{ body: {} }] });
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
    const stored = Object.keys(sessionStorage).filter((k) => k.startsWith('roedy-setup-'));
    expect(stored.sort()).toEqual(['roedy-setup-email', 'roedy-setup-name', 'roedy-setup-step']);
    expect(Object.values(sessionStorage)).not.toContain('Safe-enough1');
    expect(Object.values(sessionStorage)).not.toContain(TOKEN);

    // Reload: a new flow.
    const again = new SetupFlow(hooks());
    expect(again.step).toBe(2);
    expect(again.name).toBe('Anna Baker');
    expect(again.email).toBe('anna@example.com');
    expect(again.token).toBe('');
    expect(again.pw).toBe('');
  });

  it('stays on the first step after a reload there', () => {
    expect(resumeStep()).toBe(1);
    writeSession('step', '1');
    expect(resumeStep()).toBe(1);
    writeSession('step', '4');
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
    const { flow } = at(5);
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

describe('Step 5: completion', () => {
  it('summarises the steps, never the password', () => {
    storeChoice({ lang: 'en', mode: 'dark', accent: 'apricot' });
    const { flow } = at(5);
    const rows = flow.review.map((r) => [r.step, r.icon, r.ini, r.label, r.value, r.sub, r.masked]);
    expect(rows).toEqual([
      [1, 'ti-palette', '', 'Language and appearance', 'English · Dark · Apricot', '', false],
      [3, 'ti-user-shield', 'AB', 'Administrator', 'Anna Baker', 'anna@example.com', false],
      [4, 'ti-lock', '', 'Password', MASKED_PW, 'Set', true],
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
    const { flow } = at(5);
    expect(flow.review[0]?.value).toBe('English · Dark · Apricot');
    flow.revisit(1);
    storeChoice({ mode: 'light', accent: 'sky' });
    expect(flow.review[0]?.value).toBe('English · Light · Sky');
  });

  it('walks forward from "Change" keeping the accepted token and the passwords', async () => {
    const { calls } = mockApi({});
    const { flow, h } = at(5);
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
    expect(flow.step).toBe(5);
    expect(calls).toHaveLength(0);
    flow.revisit(3);
    expect(h.entered).toHaveBeenLastCalledWith(3, 'name');
    flow.revisit(4);
    expect(h.entered).toHaveBeenLastCalledWith(4, 'pw');
  });

  it('sets up with the stored appearance, shows the done screen, then signs in', async () => {
    vi.useFakeTimers();
    storeChoice({ lang: 'de', mode: 'dark', accent: '#4a7bd0' });
    const signedIn = vi.fn(() => Promise.resolve());
    const { flow, h } = at(5, { ...hooks(), signedIn });
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
    expect(h.entered).toHaveBeenLastCalledWith(5, 'heading');
    expect(flow.firstName).toBe('Anna');
    expect([flow.pw, flow.pw2, flow.token]).toEqual(['', '', '']);
    vi.advanceTimersByTime(DONE_MS - 1);
    expect(signedIn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(signedIn).toHaveBeenCalledOnce();
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('shows any other answer in place, with the shake, until the next "Finish setup"', async () => {
    const { flow, h } = at(5);
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    mockApi({
      'POST setup/complete': [
        { status: 500, body: {} },
        { status: 422, body: { error: 'invalid', fields: { name: { code: 'invalid' } } } },
        () => new Promise((resolve) => (answer = resolve)),
      ],
    });
    await flow.finish();
    expect([flow.step, flow.finishErr, flow.loading]).toEqual([5, true, false]);
    expect(h.fail).toHaveBeenCalledOnce();
    expect(h.error).not.toHaveBeenCalled();
    // Steps 3 and 4 already checked the fields with the server's rules: a field error is just another answer.
    await flow.finish();
    expect([flow.step, flow.finishErr, flow.err]).toEqual([5, true, {}]);
    const pending = flow.finish();
    expect([flow.finishErr, flow.loading]).toEqual([false, true]);
    answer({ status: 201, body: {} });
    await pending;
    expect(flow.view).toBe('done');
    flow.dispose();
  });

  it('allows neither going back nor to a step during completion', async () => {
    const { flow } = at(5);
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    mockApi({ 'POST setup/complete': [() => new Promise((resolve) => (answer = resolve))] });
    const pending = flow.finish();
    expect(flow.loading).toBe(true);
    // Back stays (locked, not hidden).
    expect(flow.canBack).toBe(true);
    flow.back();
    flow.revisit(3);
    expect(flow.step).toBe(5);
    answer({ status: 201, body: {} });
    await pending;
    expect(flow.view).toBe('done');
    flow.dispose();
  });

  it('reloads on setup_done (the layout then shows the sign-in)', async () => {
    const { flow, h } = at(5);
    mockApi({ 'POST setup/complete': [{ status: 409, body: { error: 'setup_done' } }] });
    await flow.finish();
    expect(h.reload).toHaveBeenCalledOnce();
    expect([flow.view, flow.finishErr, flow.loading]).toEqual(['form', false, false]);
  });

  it('shows "No connection" when a request gets no answer, everything entered stays', async () => {
    const offline = vi.fn();
    const { flow, h } = at(5, { ...hooks(), offline } as ReturnType<typeof hooks>);
    mockApi({});
    await flow.finish();
    expect(offline).toHaveBeenCalledOnce();
    expect(h.error).not.toHaveBeenCalled();
    expect([flow.step, flow.loading, flow.pw]).toEqual([5, false, 'Safe-enough1']);
  });

  it('returns to the token step on a wrong or locked token', async () => {
    vi.useFakeTimers();
    const { flow, h } = at(5);
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
    flow.step = 5;
    await flow.finish();
    expect(flow.step).toBe(2);
    expect([flow.tokErr, flow.tokLeft, flow.tokOk]).toEqual(['locked', 12, false]);
    flow.dispose();
  });
});
