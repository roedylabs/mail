import { JmapError } from '@roedy/jmap';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkError, api } from '#lib/api.ts';
import { browserDeps } from '#lib/auth/stalwart-login.ts';
import { devLog } from '#lib/state/devlog.svelte.ts';
import { Network, PROBE_MS, appFetch, network, pollVisible } from '#lib/state/network.svelte.ts';

/** Window with `navigator.onLine` that can fire `online`/`offline`. */
function fakeWindow(onLine: boolean | undefined) {
  const target = new EventTarget();
  const state = { navigator: { onLine } };
  return { win: Object.assign(target, state) as unknown as Window, state };
}

afterEach(() => {
  network.simulated = false;
  network.online = true;
  network.reached = new Map();
  devLog.clear();
  vi.unstubAllGlobals();
});

describe('Network', () => {
  it('reads the connection when attaching; without information it counts as there', () => {
    const net = new Network();
    net.attach(fakeWindow(false).win);
    expect(net.online).toBe(false);
    expect(net.offline).toBe(true);
    net.attach(fakeWindow(undefined).win);
    expect(net.online).toBe(true);
    expect(net.offline).toBe(false);
    expect(devLog.entries).toEqual([]);
  });

  it('reports the end of an offline phase once, until the listener unsubscribes', () => {
    const net = new Network();
    const { win, state } = fakeWindow(true);
    net.attach(win);
    const returned = vi.fn();
    const stop = net.onReturn(returned);

    win.dispatchEvent(new Event('online'));
    expect(returned).not.toHaveBeenCalled();
    state.navigator.onLine = false;
    win.dispatchEvent(new Event('offline'));
    expect(returned).not.toHaveBeenCalled();
    state.navigator.onLine = true;
    win.dispatchEvent(new Event('online'));
    expect(returned).toHaveBeenCalledTimes(1);

    net.simulate(true);
    net.simulate(false);
    expect(returned).toHaveBeenCalledTimes(2);

    stop();
    net.simulate(true);
    net.simulate(false);
    expect(returned).toHaveBeenCalledTimes(2);
  });

  it('reports nothing while the other source is still offline', () => {
    const net = new Network();
    const { win, state } = fakeWindow(true);
    net.attach(win);
    const returned = vi.fn();
    net.onReturn(returned);

    state.navigator.onLine = false;
    win.dispatchEvent(new Event('offline'));
    net.simulate(true);
    net.simulate(false);
    expect(returned).not.toHaveBeenCalled();

    net.simulate(true);
    state.navigator.onLine = true;
    win.dispatchEvent(new Event('online'));
    expect(returned).not.toHaveBeenCalled();
    net.simulate(false);
    expect(returned).toHaveBeenCalledTimes(1);
  });

  it('follows the browser and records it in the log until detached', () => {
    const net = new Network();
    const { win, state } = fakeWindow(true);
    const detach = net.attach(win);

    state.navigator.onLine = false;
    win.dispatchEvent(new Event('offline'));
    expect(net.offline).toBe(true);
    state.navigator.onLine = true;
    win.dispatchEvent(new Event('online'));
    expect(net.offline).toBe(false);
    expect(devLog.entries.map((e) => [e.level, e.msg])).toEqual([
      ['info', 'Back online'],
      ['warning', 'Connection lost'],
    ]);

    detach();
    state.navigator.onLine = false;
    win.dispatchEvent(new Event('offline'));
    expect(net.online).toBe(true);
  });

  it('follows the requests instead of the browser: one origin with a response is enough', () => {
    const net = new Network();
    net.attach(fakeWindow(false).win);
    expect(net.offline).toBe(true);
    // Network without a default route: the browser reports offline, the backend answers.
    net.record('https://app.example.test', true);
    expect(net.offline).toBe(false);
    // A mail server without response is not offline as long as another origin answers.
    net.record('https://mail.example.test', false);
    expect(net.offline).toBe(false);
    net.record('https://app.example.test', false);
    expect(net.offline).toBe(true);
    net.record('https://mail.example.test', true);
    expect(net.offline).toBe(false);
  });

  it('counts as offline when all origins stayed without response last, even if the browser reports online', () => {
    const net = new Network();
    net.attach(fakeWindow(true).win);
    net.record('https://app.example.test', false);
    expect(net.offline).toBe(true);
    expect(devLog.entries.map((e) => [e.level, e.msg])).toEqual([['warning', 'Connection lost']]);
  });

  it('also reports the end of an offline phase when a request gets a response again', () => {
    const net = new Network();
    net.attach(fakeWindow(false).win);
    const returned = vi.fn();
    net.onReturn(returned);
    net.record('https://app.example.test', false);
    expect(returned).not.toHaveBeenCalled();
    net.record('https://app.example.test', true);
    expect(returned).toHaveBeenCalledOnce();
    net.record('https://app.example.test', true);
    net.record('https://mail.example.test', true);
    expect(returned).toHaveBeenCalledOnce();
    expect(devLog.entries.map((e) => [e.level, e.msg])).toEqual([['info', 'Back online']]);
  });

  it('stays offline in the simulation even if a response still arrives, and does not log it', () => {
    const net = new Network();
    net.simulate(true);
    devLog.clear();
    net.record('https://app.example.test', true);
    expect(net.offline).toBe(true);
    expect(devLog.entries).toEqual([]);
    net.simulate(false);
    expect(net.offline).toBe(false);
  });

  it('forgets earlier outcomes with the simulation and reports the return when the browser reports online', () => {
    const net = new Network();
    net.attach(fakeWindow(true).win);
    const returned = vi.fn();
    net.onReturn(returned);
    net.record('https://app.example.test', false);
    net.simulate(true);
    expect(net.reached.size).toBe(0);
    net.record('https://app.example.test', false);
    net.simulate(false);
    expect(net.reached.size).toBe(0);
    expect(net.offline).toBe(false);
    expect(returned).toHaveBeenCalledOnce();
  });

  it('logs no return in a network without a default route at start', () => {
    const net = new Network();
    net.attach(fakeWindow(false).win);
    const returned = vi.fn();
    net.onReturn(returned);
    net.record('https://app.example.test', true);
    expect(net.offline).toBe(false);
    expect(returned).toHaveBeenCalledOnce();
    expect(devLog.entries).toEqual([]);
  });

  it('`lost` counts as offline, also only according to the browser, but not in the simulation', () => {
    const net = new Network();
    net.attach(fakeWindow(false).win);
    expect([net.offline, net.lost]).toEqual([true, true]);
    net.record('https://app.example.test', true);
    expect(net.lost).toBe(false);
    net.record('https://app.example.test', false);
    expect(net.lost).toBe(true);
    net.record('https://mail.example.test', true);
    expect(net.lost).toBe(false);
    net.record('https://mail.example.test', false);
    net.simulate(true);
    net.record('https://app.example.test', false);
    expect(net.lost).toBe(false);
  });

  it.each(['online', 'offline'])('forgets the outcomes on the `%s` event, then the browser counts', (event) => {
    const net = new Network();
    const { win, state } = fakeWindow(false);
    net.attach(win);
    net.record('https://app.example.test', true);
    win.dispatchEvent(new Event(event));
    expect(net.reached.size).toBe(0);
    expect(net.offline).toBe(true);

    net.record('https://app.example.test', false);
    state.navigator.onLine = true;
    win.dispatchEvent(new Event('online'));
    expect(net.reached.size).toBe(0);
    expect(net.offline).toBe(false);
  });

  it('logs start and end of the simulation once each', () => {
    const net = new Network();
    net.simulate(true);
    net.simulate(true);
    expect(net.offline).toBe(true);
    net.simulate(false);
    net.simulate(false);
    expect(net.offline).toBe(false);
    expect(devLog.entries.map((e) => [e.level, e.msg])).toEqual([
      ['warning', 'Offline simulation ended'],
      ['warning', 'Offline simulation started'],
    ]);
  });
});

describe('pollVisible', () => {
  afterEach(() => vi.useRealTimers());

  it('probes every `PROBE_MS` while all origins stayed without response', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const stop = pollVisible(window, 60_000, () => true, run);
    vi.advanceTimersByTime(PROBE_MS);
    expect(run).not.toHaveBeenCalled();
    network.record('https://app.example.test', false);
    vi.advanceTimersByTime(PROBE_MS);
    expect(run).toHaveBeenCalledOnce();
    network.record('https://app.example.test', true);
    // The return itself triggers once, afterwards only the interval again.
    expect(run).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(PROBE_MS * 2);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
    network.record('https://app.example.test', false);
    vi.advanceTimersByTime(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('appFetch', () => {
  it('passes through to fetch without simulation', async () => {
    const response = new Response('{}');
    const fetch = vi.fn(() => Promise.resolve(response));
    vi.stubGlobal('fetch', fetch);
    await expect(appFetch('/x', { method: 'POST' })).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledWith('/x', { method: 'POST' });
  });

  it('fails in the simulation as without a network, without sending a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    network.simulated = true;
    await expect(appFetch('/x')).rejects.toBeInstanceOf(TypeError);
    await expect(api('GET', 'auth/me')).rejects.toBeInstanceOf(NetworkError);
    await expect(browserDeps().fetch('https://mail.example.test/.well-known/jmap')).rejects.toBeInstanceOf(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  describe('Outcome of requests', () => {
    const settled = () => new Promise((resolve) => setTimeout(resolve));
    const reached = () => Object.fromEntries(network.reached);

    it('remembers a response per origin, also an error response of the server', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn((input: string) => Promise.resolve(new Response('{}', { status: input.includes('mail') ? 500 : 200 }))),
      );
      network.online = false;
      expect(network.offline).toBe(true);
      await appFetch('https://app.example.test/api/v1/auth/me');
      await appFetch('https://mail.example.test/jmap/');
      await settled();
      expect(reached()).toEqual({ 'https://app.example.test': true, 'https://mail.example.test': true });
      expect(network.offline).toBe(false);
    });

    it('remembers a network error or a timeout and passes the error on', async () => {
      const error = new TypeError('Failed to fetch');
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(error)),
      );
      network.record('https://app.example.test', true);
      await expect(appFetch('https://app.example.test/api/v1/auth/me')).rejects.toBe(error);
      await settled();
      expect(reached()).toEqual({ 'https://app.example.test': false });
      expect(network.offline).toBe(true);

      const timeout = new DOMException('too long', 'TimeoutError');
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(timeout)),
      );
      network.record('https://mail.example.test', true);
      await expect(appFetch(new URL('https://mail.example.test/jmap/'))).rejects.toBe(timeout);
      await settled();
      expect(reached()).toEqual({ 'https://app.example.test': false, 'https://mail.example.test': false });
    });

    it('forgets outcomes of requests that began before a browser or simulation event', async () => {
      let finish: (r: Response) => void = () => {};
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise<Response>((resolve) => (finish = resolve))),
      );
      const run = appFetch('https://app.example.test/x');
      network.simulate(true);
      network.simulate(false);
      finish(new Response('{}'));
      await run;
      await settled();
      expect(reached()).toEqual({});
    });

    it("counts the JMAP client's time limit as without response", async () => {
      const timeout = new JmapError('unreachable', { detail: 'timeout' });
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(timeout)),
      );
      network.record('https://mail.example.test', true);
      await expect(appFetch('https://mail.example.test/jmap/')).rejects.toBe(timeout);
      await settled();
      expect(reached()).toEqual({ 'https://mail.example.test': false });
    });

    it.each([
      ['aborted by itself', new DOMException('aborted', 'AbortError')],
      ['aborted with its own reason', new Error('ping')],
    ])('changes nothing if the request was %s', async (_, error) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.reject(error)),
      );
      network.record('https://app.example.test', true);
      await expect(appFetch('https://app.example.test/x')).rejects.toBe(error);
      await settled();
      expect(reached()).toEqual({ 'https://app.example.test': true });
    });

    it('assigns relative addresses and requests to the right origin', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response('{}'))),
      );
      await appFetch('/api/v1/auth/me');
      await appFetch(new Request('https://mail.example.test/jmap/'));
      await settled();
      expect(reached()).toEqual({ [location.origin]: true, 'https://mail.example.test': true });
    });

    it('changes nothing in the simulation: no request goes out', async () => {
      const fetch = vi.fn();
      vi.stubGlobal('fetch', fetch);
      network.record('https://app.example.test', true);
      network.simulated = true;
      await expect(appFetch('https://app.example.test/x')).rejects.toBeInstanceOf(TypeError);
      await settled();
      expect(reached()).toEqual({ 'https://app.example.test': true });
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
