import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import {
  DONE_MS,
  SetupFlow,
  choicesOf,
  clearSession,
  customHexOf,
  formatToken,
  readSession,
  resumeStep,
  storeChoice,
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
    // A named accent again: the custom colour stays for the swatch "Custom".
    storeChoice({ accent: 'rose' });
    expect(choicesOf().accent).toBe('rose');
    expect(customHexOf()).toBe('#4a7bd0');
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
    flow.pw = 'tooshort';
    flow.submitPw();
    expect(flow.err.pw).toBe(true);
    expect(h.fail).toHaveBeenCalledWith('pw');
    flow.pw = `A1${'a'.repeat(1023)}`;
    flow.submitPw();
    expect(flow.err.pw).toBe('The password is too long.');
    flow.edit('pw', 'Safe-enough1');
    flow.pw2 = '';
    flow.submitPw();
    expect(flow.err.pw2).toBe('Please confirm the password.');
    flow.pw2 = 'Safe-enough2';
    flow.submitPw();
    expect(flow.err.pw2).toBe('The passwords don’t match.');
    flow.pw2 = 'Safe-enough1';
    flow.submitPw();
    expect(flow.step).toBe(5);
    expect(h.entered).toHaveBeenLastCalledWith(5, 'heading');
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
  it('shows the overview and sets up with the stored appearance, then reloads the session', async () => {
    vi.useFakeTimers();
    storeChoice({ lang: 'de', mode: 'dark', accent: '#4a7bd0' });
    const { flow, h } = at(5);
    // A tab from a copied table cell: checked and sent as a space.
    flow.name = ' Anna\tBaker ';
    const { calls } = mockApi({ 'POST setup/complete': [{ status: 201, body: { user: {} } }] });
    expect(flow.review.map((r) => [r.label, r.value])).toEqual([['Administrator', 'Anna Baker · anna@example.com']]);
    flow.revisit(3);
    expect(h.entered).toHaveBeenLastCalledWith(3, 'name');
    flow.revisit(4);
    expect(h.entered).toHaveBeenLastCalledWith(4, 'pw');
    flow.step = 5;
    await flow.finish();
    expect(calls[0]?.headers['X-Setup-Token']).toBe(TOKEN);
    expect(calls[0]?.body).toEqual({
      name: 'Anna Baker',
      email: 'anna@example.com',
      password: 'Safe-enough1',
      settings: { lang: 'de', mode: 'dark', accent: '#4a7bd0' },
    });
    expect(flow.view).toBe('done');
    expect(flow.firstName).toBe('Anna');
    expect(flow.pw).toBe('');
    expect(h.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DONE_MS);
    expect(h.reload).toHaveBeenCalled();
  });

  it('jumps to the first affected step on field errors', async () => {
    const { flow, h } = at(5);
    const invalid = (fields: Record<string, unknown>) => ({ status: 422, body: { error: 'invalid', fields } });
    mockApi({
      'POST setup/complete': [
        invalid({ password: { code: 'policy', rules: ['num'] }, email: { code: 'invalid' } }),
        invalid({ name: { code: 'too_long' } }),
        invalid({ name: { code: 'invalid' } }),
        invalid({ password: { code: 'too_long' } }),
        invalid({ 'settings.lang': { code: 'invalid' } }),
      ],
    });
    const finish = async (): Promise<[number, unknown]> => {
      flow.step = 5;
      await flow.finish();
      return [flow.step, flow.err];
    };
    expect(await finish()).toEqual([3, { pw: true, email: 'Please check the email address.' }]);
    expect(h.fail).toHaveBeenLastCalledWith('email');
    // The focus follows from `fail`, not from entering the step.
    expect(h.entered).toHaveBeenLastCalledWith(3, null);
    expect(await finish()).toEqual([3, { name: 'The name is too long.' }]);
    expect(h.fail).toHaveBeenLastCalledWith('name');
    expect(await finish()).toEqual([3, { name: 'Use letters, spaces, hyphens and apostrophes only.' }]);
    expect(await finish()).toEqual([4, { pw: 'The password is too long.' }]);
    expect(h.error).not.toHaveBeenCalled();
    // A field without text: error toast, the overview stays.
    expect((await finish())[0]).toBe(5);
    expect(h.error).toHaveBeenCalledWith('That didn’t work. Please try again.');
  });

  it('allows neither going back nor to a step during completion', async () => {
    const { flow } = at(5);
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    mockApi({ 'POST setup/complete': [() => new Promise((resolve) => (answer = resolve))] });
    const pending = flow.finish();
    expect(flow.loading).toBe(true);
    flow.back();
    flow.revisit(3);
    expect(flow.step).toBe(5);
    answer({ status: 201, body: {} });
    await pending;
    expect(flow.view).toBe('done');
    flow.dispose();
  });

  it('reloads on setup_done and reports other errors and network errors as a toast', async () => {
    const { flow, h } = at(5);
    mockApi({
      'POST setup/complete': [
        { status: 409, body: { error: 'setup_done' } },
        { status: 500, body: {} },
      ],
    });
    await flow.finish();
    expect(h.reload).toHaveBeenCalled();
    await flow.finish();
    expect(h.error).toHaveBeenCalledWith('That didn’t work. Please try again.');
    expect(flow.loading).toBe(false);
    // No response any more: `fetch` fails; without the "No connection" message a toast.
    await flow.finish();
    expect(h.error).toHaveBeenLastCalledWith('No connection. Please try again.');
    expect(flow.loading).toBe(false);
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
