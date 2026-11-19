import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { DONE_MS, SetupFlow, formatToken, type Field, type Focus, type Step } from './setup.svelte.ts';

const TOKEN = 'ABCD-EFGH-JKLM';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function hooks() {
  return {
    fail: vi.fn<(field?: Field) => void>(),
    entered: vi.fn<(step: Step, focus?: Focus) => void>(),
    error: vi.fn<(text: string) => void>(),
    reload: vi.fn(() => Promise.resolve()),
  };
}

/** Flow up to the start of step `step` (without API, fields as after the steps). */
function at(step: 2 | 3 | 4, h = hooks()) {
  const flow = new SetupFlow(h);
  flow.token = TOKEN;
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

describe('Step 1: setup token', () => {
  it('requires twelve characters before asking', async () => {
    const h = hooks();
    const { calls } = mockApi({});
    const flow = new SetupFlow(h);
    flow.editToken('abcd-ef');
    await flow.submitToken();
    expect(flow.tokErr).toBe('short');
    expect(h.fail).toHaveBeenCalledWith('token');
    expect(calls).toHaveLength(0);
  });

  it('reports a wrong token with the remaining attempts', async () => {
    const h = hooks();
    mockApi({ 'POST setup/token': [{ status: 422, body: { error: 'invalid_token', remaining: 3 } }] });
    const flow = new SetupFlow(h);
    flow.editToken(TOKEN);
    await flow.submitToken();
    expect(flow.tokErr).toBe('invalid');
    expect(flow.tokErrText).toBe('Check the token in the container log. 3 attempts left.');
    expect(flow.phase).toBe('error');
    flow.remaining = 1;
    expect(flow.tokErrText).toBe('Check the token in the container log. 1 attempt left.');
    // Typing clears the error.
    flow.editToken('ABCD');
    expect(flow.tokErr).toBeNull();
  });

  it('locks after 429 with a running wait time and releases afterwards', async () => {
    vi.useFakeTimers();
    const h = hooks();
    mockApi({ 'POST setup/token': [{ status: 429, body: { error: 'rate_limited', retry_after: 30 } }] });
    const flow = new SetupFlow(h);
    flow.editToken(TOKEN);
    await flow.submitToken();
    expect(flow.locked).toBe(true);
    expect(flow.token).toBe('');
    expect(flow.phase).toBe('locked');
    expect(flow.tokErrText).toBe('Entry is locked for 30 seconds.');
    vi.advanceTimersByTime(29_000);
    expect(flow.tokErrText).toBe('Entry is locked for 1 second.');
    // While locked the page does not ask.
    flow.token = TOKEN;
    await flow.submitToken();
    vi.advanceTimersByTime(1_000);
    expect(flow.locked).toBe(false);
    expect(flow.tokErr).toBeNull();
    expect(h.entered).toHaveBeenCalledWith(1, 'token');
    flow.dispose();
  });

  it('continues with the right token', async () => {
    const h = hooks();
    const { calls } = mockApi({ 'POST setup/token': [{ body: {} }] });
    const flow = new SetupFlow(h);
    flow.editToken('abcdefghjklm');
    await flow.submitToken();
    expect(calls[0]?.body).toEqual({ token: TOKEN });
    expect(flow.step).toBe(2);
    expect(h.entered).toHaveBeenCalledWith(2, 'name');
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

describe('Steps 2 and 3', () => {
  it('checks name and email', () => {
    const { flow, h } = at(2);
    flow.name = ' ';
    flow.email = '';
    flow.submitAdmin();
    expect(flow.err).toEqual({
      name: 'Please enter your name.',
      email: 'Please enter your email address.',
    });
    expect(h.fail).toHaveBeenCalledWith('name');
    flow.edit('name', 'Anna');
    expect(flow.err.name).toBeUndefined();
    flow.email = 'anna@example';
    flow.submitAdmin();
    expect(flow.err.email).toBe('Please check the email address.');
    flow.email = 'anna@example.com';
    flow.name = 'Anna Baker 2';
    flow.submitAdmin();
    expect(flow.err.name).toBe('The name contains invalid characters.');
    flow.name = 'Anna O’Brien-Müller';
    flow.submitAdmin();
    expect(flow.step).toBe(3);
  });

  it('checks policy, length and repetition of the password', () => {
    const { flow, h } = at(3);
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
    expect(flow.step).toBe(4);
    expect(h.entered).toHaveBeenLastCalledWith(4, 'review');
  });
});

describe('Step 4: completion', () => {
  it('shows the overview and sets up with the default appearance, then reloads the session', async () => {
    vi.useFakeTimers();
    const { flow, h } = at(4);
    // A tab from a copied table cell: checked and sent as a space.
    flow.name = ' Anna\tBaker ';
    const { calls } = mockApi({ 'POST setup/complete': [{ status: 201, body: { user: {} } }] });
    expect(flow.review.map((r) => [r.label, r.value])).toEqual([['Administrator', 'Anna Baker · anna@example.com']]);
    flow.revisit(2);
    expect(h.entered).toHaveBeenLastCalledWith(2, 'name');
    flow.revisit(3);
    expect(h.entered).toHaveBeenLastCalledWith(3, 'pw');
    flow.step = 4;
    await flow.finish();
    expect(calls[0]?.headers['X-Setup-Token']).toBe(TOKEN);
    expect(calls[0]?.body).toEqual({
      name: 'Anna Baker',
      email: 'anna@example.com',
      password: 'Safe-enough1',
      settings: { lang: 'en', mode: 'system', accent: 'apricot' },
    });
    expect(flow.view).toBe('done');
    expect(flow.phase).toBe('success');
    expect(flow.firstName).toBe('Anna');
    expect(flow.pw).toBe('');
    expect(h.reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DONE_MS);
    expect(h.reload).toHaveBeenCalled();
  });

  it('jumps to the first affected step on field errors', async () => {
    const { flow, h } = at(4);
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
      flow.step = 4;
      await flow.finish();
      return [flow.step, flow.err];
    };
    expect(await finish()).toEqual([2, { pw: true, email: 'Please check the email address.' }]);
    expect(h.fail).toHaveBeenLastCalledWith('email');
    expect(await finish()).toEqual([2, { name: 'The name is too long.' }]);
    expect(h.fail).toHaveBeenLastCalledWith('name');
    expect(await finish()).toEqual([2, { name: 'The name contains invalid characters.' }]);
    expect(await finish()).toEqual([3, { pw: 'The password is too long.' }]);
    expect(h.error).not.toHaveBeenCalled();
    // A field without text: error toast, the overview stays.
    expect((await finish())[0]).toBe(4);
    expect(h.error).toHaveBeenCalledWith('That didn’t work. Please try again.');
  });

  it('allows neither going back nor to a step during completion', async () => {
    const { flow } = at(4);
    let answer: (a: { status: number; body: unknown }) => void = () => {};
    mockApi({ 'POST setup/complete': [() => new Promise((resolve) => (answer = resolve))] });
    const pending = flow.finish();
    expect(flow.loading).toBe(true);
    flow.back();
    flow.revisit(2);
    expect(flow.step).toBe(4);
    answer({ status: 201, body: {} });
    await pending;
    expect(flow.view).toBe('done');
    flow.dispose();
  });

  it('reloads on setup_done and reports other errors and network errors as a toast', async () => {
    const { flow, h } = at(4);
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
    // No response any more: `fetch` fails.
    await flow.finish();
    expect(h.error).toHaveBeenLastCalledWith('No connection. Please try again.');
    expect(flow.loading).toBe(false);
  });

  it('returns to step 1 on a wrong or locked token', async () => {
    vi.useFakeTimers();
    const { flow, h } = at(4);
    mockApi({
      'POST setup/complete': [
        { status: 422, body: { error: 'invalid_token', remaining: 2 } },
        { status: 429, body: { error: 'rate_limited', retry_after: 12 } },
      ],
    });
    await flow.finish();
    expect(flow.step).toBe(1);
    expect(flow.tokErr).toBe('invalid');
    expect(h.fail).toHaveBeenLastCalledWith('token');
    flow.step = 4;
    await flow.finish();
    expect(flow.step).toBe(1);
    expect(flow.tokErrText).toBe('Entry is locked for 12 seconds.');
    flow.dispose();
  });
});
