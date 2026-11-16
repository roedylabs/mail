import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { devLog } from '#lib/state/devlog.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { BRAND0, session } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import ErrorView from './ErrorView.svelte';

const nav = vi.hoisted(() => ({
  goto: vi.fn(() => Promise.resolve()),
  page: { url: new URL('http://localhost/error/500') },
}));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));
vi.mock('$app/state', () => ({ page: nav.page }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  nav.goto.mockClear();
  session.config = null;
  ui.navigated = false;
  ui.reset();
});

function withOrgEmail(email: string | null) {
  session.config = {
    name: 'Roedy Mail',
    branding: BRAND0,
    org: { name: null, website: null, help: null, email, imprint: null, privacy: null, terms: null, source: null },
    banner: null,
    maintenance: { on: false, message: null },
    version: '0.1.0',
    update: null,
    setup_required: false,
    client_cache_version: 0,
  };
}

describe('error page', () => {
  it('shows 404 with "Go to overview" and "Back"', async () => {
    const view = render(ErrorView, { code: '404' });
    expect(view.getByText('Error 404')).toBeInTheDocument();
    expect(view.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(view.getByText('The URL is wrong or the page has moved.')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Try again' })).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Go to overview' }));
    expect(nav.goto).toHaveBeenLastCalledWith('/start');
    // Without history in the app "Back" leads to the overview, otherwise back in the history.
    await fireEvent.click(view.getByRole('button', { name: 'Back' }));
    expect(nav.goto).toHaveBeenCalledTimes(2);
    const back = vi.spyOn(history, 'back').mockImplementation(() => {});
    ui.navigated = true;
    await fireEvent.click(view.getByRole('button', { name: 'Back' }));
    expect(back).toHaveBeenCalledOnce();
    // The Navigation API knows exactly: without a previous page of the app you stay in the app.
    vi.stubGlobal('navigation', { canGoBack: false });
    await fireEvent.click(view.getByRole('button', { name: 'Back' }));
    expect(back).toHaveBeenCalledOnce();
    expect(nav.goto).toHaveBeenCalledTimes(3);
  });

  it('retries on 500 and shows "Loading" meanwhile', async () => {
    vi.useFakeTimers();
    const retry = vi.fn(() => Promise.resolve());
    const view = render(ErrorView, { code: '500', retry });
    const button = view.getByRole('button', { name: 'Try again' });
    expect(button).toHaveAttribute('aria-disabled', 'false');
    await fireEvent.click(button);
    expect(view.getByRole('button', { name: 'Loading' })).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.click(view.getByRole('button', { name: 'Loading' }));
    await vi.advanceTimersByTimeAsync(900);
    expect(retry).toHaveBeenCalledOnce();
    expect(view.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Go to overview' })).toBeInTheDocument();
  });

  it('shows "No connection" offline and the previous page without `retry`', async () => {
    vi.useFakeTimers();
    const view = render(ErrorView, { code: 'offline' });
    expect(view.getByRole('heading', { name: 'No connection' })).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Try again' }));
    await vi.advanceTimersByTimeAsync(900);
    expect(nav.goto).toHaveBeenCalledWith('/start');
  });

  it('records every error page in the log, "offline" as a warning', async () => {
    devLog.clear();
    const { rerender, unmount } = render(ErrorView, { code: '404' });
    await tick();
    await rerender({ code: 'offline' });
    await tick();
    expect(devLog.entries.map((e) => [e.level, e.msg])).toEqual([
      ['warning', 'Error page shown: offline'],
      ['error', 'Error page shown: 404'],
    ]);
    unmount();
    devLog.clear();
  });

  it('ends the simulation on "offline" with "Try again"', async () => {
    network.simulated = true;
    const retry = vi.fn();
    const { getByRole } = render(ErrorView, { code: 'offline', retry });
    await fireEvent.click(getByRole('button', { name: 'Try again' }));
    await vi.waitFor(() => expect(retry).toHaveBeenCalled(), { timeout: 2000 });
    expect(network.simulated).toBe(false);
    devLog.clear();
  });

  it('offers support only with an organization address', () => {
    withOrgEmail('support@example.com');
    const view = render(ErrorView, { code: '500' });
    expect(view.getByText('Still having trouble?')).toBeInTheDocument();
    expect(view.getByRole('link', { name: 'Contact support' })).toHaveAttribute(
      'href',
      'mailto:support@example.com?subject=Error%20500%20in%20Roedy%20Mail',
    );
    view.unmount();
    withOrgEmail(null);
    const plain = render(ErrorView, { code: '500' });
    expect(plain.queryByRole('link', { name: 'Contact support' })).toBeNull();
  });

  it('is itself the main landmark without a layout around it', () => {
    const view = render(ErrorView, { code: '404' });
    expect(view.getByRole('main')).toContainElement(view.getByRole('heading', { name: 'Page not found' }));
  });

  it('copies the details with build and environment', async () => {
    const writeText = vi.fn((text: string) => Promise.resolve(void text));
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const view = render(ErrorView, { code: '403' });
    // The name contains the visible text (WCAG 2.5.3).
    const details = view.getByRole('button', { name: /^Copy details\s*Error 403 · Build .+ · \d{2}:\d{2}$/ });
    expect(details.querySelector('.detail-text')).toHaveTextContent(/^Error 403 · Build .+ · \d{2}:\d{2}$/);
    await fireEvent.click(details);
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Details copied'));
    const text = writeText.mock.calls[0]?.[0] ?? '';
    expect(text.split('\n')[0]).toBe('Error 403');
    expect(text).toContain('View: /error/500');
    expect(text).toContain(`${m.dev_env_language()}: EN · United Kingdom`);
  });

  it('stacks the content on mobile', () => {
    vi.stubGlobal('innerWidth', 400);
    window.dispatchEvent(new Event('resize'));
    const view = render(ErrorView, { code: '404' });
    expect(view.container.querySelector('.error')).toHaveClass('mobile');
  });
});
