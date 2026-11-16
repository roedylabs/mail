import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { push, type PushStatus, type PushSubscriptionEntry } from '#lib/push.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import PushDialog from './PushDialog.svelte';

const CURRENT: PushSubscriptionEntry = {
  id: 'p1',
  endpoint: 'https://push.example.test/abc',
  device: 'Firefox on Linux',
  created_at: '2026-11-04T10:00:00Z',
  expires_at: null,
  current: true,
};

/** Sets the state of `push` (and `nCh.push`) so that `push.status` has the value. */
function setStatus(status: PushStatus) {
  push.support = status === 'none' || status === 'ios' ? status : 'yes';
  push.permission = status === 'denied' ? 'denied' : status === 'active' ? 'granted' : 'default';
  push.busy = status === 'busy';
  push.current = status === 'active' ? CURRENT : null;
  prefs.values.nCh.push = status === 'active';
  expect(push.status).toBe(status);
}

function open(status: PushStatus, mobile = false) {
  setStatus(status);
  const onclose = vi.fn();
  const view = render(PushDialog, { mobile, onclose });
  return { view, onclose };
}

/** Labels of all buttons in DOM order (close icon via `aria-label`). */
function buttons() {
  return screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
}

afterEach(() => {
  vi.restoreAllMocks();
  push.reset();
  push.support = 'none';
  push.permission = 'default';
  prefs.reset();
});

describe('PushDialog', () => {
  it('ask on desktop: dialog with focus, iOS hint, "Later" and "Grant permission"', async () => {
    const request = vi.spyOn(push, 'request').mockResolvedValue();
    const { view, onclose } = open('ask');
    const dialog = view.getByRole('dialog', { name: 'Turn on push notifications' });
    expect(document.activeElement).toBe(dialog);
    expect(
      view.getByText(/^Get alerts about new messages and security events even when Roedy Mail isn’t open\./),
    ).toBeInTheDocument();
    expect(view.getByText(m.push_ios_note({ app: 'Roedy Mail' }))).toBeInTheDocument();
    expect(view.queryByRole('list')).not.toBeInTheDocument();
    expect(buttons()).toEqual(['Close', 'Later', 'Grant permission']);

    const grant = view.getByRole('button', { name: 'Grant permission' });
    expect(grant).toHaveAttribute('aria-busy', 'false');
    await fireEvent.click(grant);
    expect(request).toHaveBeenCalledOnce();
    expect(onclose).not.toHaveBeenCalled();

    await fireEvent.click(view.getByRole('button', { name: 'Later' }));
    await fireEvent.click(view.getByRole('button', { name: 'Close' }));
    expect(onclose).toHaveBeenCalledTimes(2);
  });

  it('busy follows the state: "Waiting …" with a spinning icon', async () => {
    const { view } = open('ask');
    push.busy = true;
    await tick();
    expect(view.getByRole('dialog', { name: 'Waiting for the browser' })).toBeInTheDocument();
    expect(view.getByText(/^Confirm your browser’s request\./)).toBeInTheDocument();
    const wait = view.getByRole('button', { name: 'Waiting …' });
    expect(wait).toHaveAttribute('aria-busy', 'true');
    expect(wait).toHaveAttribute('aria-disabled', 'true');
    expect(wait.querySelector('.spin')).not.toBeNull();
    expect(buttons()).toEqual(['Close', 'Later', 'Waiting …']);
    expect(view.queryByText(/^On iPhone or iPad/)).not.toBeInTheDocument();
  });

  it('denied: address, three steps and "Check again"', async () => {
    const retry = vi.spyOn(push, 'retry').mockReturnValue();
    const { view, onclose } = open('denied');
    expect(view.getByRole('dialog', { name: 'Blocked by the browser' })).toBeInTheDocument();
    expect(view.getByText(m.push_denied_text({ host: location.host }))).toBeInTheDocument();
    expect(view.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      `1${m.push_denied_step1()}`,
      `2${m.push_denied_step2()}`,
      `3${m.push_denied_step3()}`,
    ]);
    expect(view.queryByText(/^On iPhone or iPad/)).not.toBeInTheDocument();
    expect(buttons()).toEqual(['Close', 'Close', 'Check again']);

    await fireEvent.click(view.getByRole('button', { name: 'Check again' }));
    expect(retry).toHaveBeenCalledOnce();
    await fireEvent.click(view.getAllByRole('button', { name: 'Close' })[1]!);
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('none: not supported, iOS hint and "Got it"', async () => {
    const { view, onclose } = open('none');
    expect(view.getByRole('dialog', { name: 'Not supported' })).toBeInTheDocument();
    expect(view.getByText(/^This browser can’t receive push notifications\./)).toBeInTheDocument();
    expect(view.getByText(/^On iPhone or iPad, first add Roedy Mail/)).toBeInTheDocument();
    expect(buttons()).toEqual(['Close', 'Got it']);
    await fireEvent.click(view.getByRole('button', { name: 'Got it' }));
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('ios: steps to the home screen and "Got it"', async () => {
    const { view, onclose } = open('ios');
    expect(view.getByRole('dialog', { name: 'Add to Home Screen first' })).toBeInTheDocument();
    expect(view.getByText(/^On iPhone and iPad, push notifications only work when Roedy Mail/)).toBeInTheDocument();
    expect(view.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      `1${m.push_ios_step1()}`,
      `2${m.push_ios_step2()}`,
      `3${m.push_ios_step3({ app: 'Roedy Mail' })}`,
    ]);
    expect(view.queryByText(/^On iPhone or iPad/)).not.toBeInTheDocument();
    expect(buttons()).toEqual(['Close', 'Got it']);
    await fireEvent.click(view.getByRole('button', { name: 'Got it' }));
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('active: device name, "Send test" and turn off, which closes afterwards', async () => {
    const test = vi.spyOn(push, 'test').mockResolvedValue();
    let done = () => {};
    const off = vi.spyOn(push, 'off').mockReturnValue(new Promise<void>((resolve) => (done = resolve)));
    const { view, onclose } = open('active');
    expect(view.getByRole('dialog', { name: m.push_active_title() })).toBeInTheDocument();
    expect(view.getByText(/^Firefox on Linux receives push notifications\./)).toBeInTheDocument();
    expect(buttons()).toEqual(['Close', 'Turn off on this device', 'Send test']);

    await fireEvent.click(view.getByRole('button', { name: 'Send test' }));
    expect(test).toHaveBeenCalledOnce();
    expect(onclose).not.toHaveBeenCalled();

    await fireEvent.click(view.getByRole('button', { name: 'Turn off on this device' }));
    expect(off).toHaveBeenCalledOnce();
    expect(onclose).not.toHaveBeenCalled();
    done();
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
  });

  it('a click on the backdrop closes, a click in the dialog does not; focus goes back', async () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const { view, onclose } = open('ask');
    const dialog = view.getByRole('dialog');
    await fireEvent.mouseDown(dialog);
    expect(onclose).not.toHaveBeenCalled();
    await fireEvent.mouseDown(dialog.parentElement!);
    expect(onclose).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('mobile: only the content, main action on top', async () => {
    const request = vi.spyOn(push, 'request').mockResolvedValue();
    const { view, onclose } = open('ask', true);
    expect(view.queryByRole('dialog')).not.toBeInTheDocument();
    expect(view.getByText('Turn on push notifications')).toBeInTheDocument();
    expect(view.getByText(/^On iPhone or iPad, first add Roedy Mail/)).toBeInTheDocument();
    expect(buttons()).toEqual(['Close', 'Grant permission', 'Later']);
    await fireEvent.click(view.getByRole('button', { name: 'Grant permission' }));
    expect(request).toHaveBeenCalledOnce();
    await fireEvent.click(view.getByRole('button', { name: 'Close' }));
    expect(onclose).toHaveBeenCalledOnce();

    setStatus('denied');
    await tick();
    expect(view.getAllByRole('listitem')).toHaveLength(3);
    expect(buttons()).toEqual(['Close', 'Check again', 'Close']);

    setStatus('active');
    await tick();
    expect(view.getByText(m.push_active_title())).toBeInTheDocument();
    expect(buttons()).toEqual(['Close', 'Send test', 'Turn off on this device']);
  });
});
