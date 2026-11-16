import { describe, expect, it, vi } from 'vitest';
import { pushDialogValues, type PushDialogContext, type PushDialogInput } from './push-dialog.ts';

function ctx(): PushDialogContext {
  return { request: vi.fn(), retry: vi.fn(), test: vi.fn(), off: vi.fn(), close: vi.fn() };
}

function values(over: Partial<PushDialogInput> = {}, c: PushDialogContext = ctx()) {
  return pushDialogValues({ status: 'ask', device: null, appName: 'Roedy Mail', host: 'mail.example.com', ...over }, c);
}

/** The keys of the visibility conditions that are true. */
function flags(v: ReturnType<typeof values>) {
  const keys = ['isAsk', 'isBusy', 'isDenied', 'isNone', 'isIos', 'isActive', 'canAsk', 'hasSteps', 'iosNote'] as const;
  return keys.filter((k) => v[k]);
}

describe('pushDialogValues', () => {
  it('ask: turn on with app name and iOS notice', () => {
    const v = values({ appName: 'Example Mail' });
    expect(v).toMatchObject({
      st: 'ask',
      icon: 'ti-bell-ringing',
      title: 'Turn on push notifications',
      text:
        'Get alerts about new messages and security events even when Example Mail isn’t open. ' +
        'Your browser will ask for your permission once.',
      steps: [],
      tileTone: 'soft',
      btn: 'Grant permission',
      btnIcon: 'ti-bell-ringing',
      iosText: 'On iPhone or iPad, first add Example Mail via “Share” › “Add to Home Screen”.',
    });
    expect(flags(v)).toEqual(['isAsk', 'canAsk', 'iosNote']);
  });

  it('busy: waiting for the browser, button spins', () => {
    const v = values({ status: 'busy' });
    expect(v).toMatchObject({
      icon: 'ti-hourglass',
      title: 'Waiting for the browser',
      text: 'Confirm your browser’s request. It usually appears at the top left, next to the address bar.',
      tileTone: 'soft',
      btn: 'Waiting …',
      btnIcon: 'ti-loader-2',
    });
    expect(flags(v)).toEqual(['isBusy', 'canAsk']);
  });

  it('denied: app address and three steps', () => {
    const v = values({ status: 'denied' });
    expect(v).toMatchObject({
      icon: 'ti-bell-off',
      title: 'Blocked by the browser',
      text: 'Your browser is blocking notifications for mail.example.com. To unblock them:',
      tileTone: 'danger',
      steps: [
        { n: '1', x: 'Click the lock or settings icon in the address bar.' },
        { n: '2', x: 'Set “Notifications” to “Allow”.' },
        { n: '3', x: 'Reload the page and try again.' },
      ],
    });
    expect(flags(v)).toEqual(['isDenied', 'hasSteps']);
  });

  it('none: not supported, with iOS notice', () => {
    const v = values({ status: 'none' });
    expect(v).toMatchObject({
      icon: 'ti-device-desktop-off',
      title: 'Not supported',
      text:
        'This browser can’t receive push notifications. Use a current version of ' +
        'Firefox, Chrome, Edge, or Safari.',
      tileTone: 'danger',
      steps: [],
    });
    expect(flags(v)).toEqual(['isNone', 'iosNote']);
  });

  it('ios: home screen with app name in text and steps', () => {
    const v = values({ status: 'ios', appName: 'Example Mail' });
    expect(v).toMatchObject({
      icon: 'ti-device-mobile-share',
      title: 'Add to Home Screen first',
      text: 'On iPhone and iPad, push notifications only work when Example Mail is on your Home Screen as an app.',
      tileTone: 'soft',
      steps: [
        { n: '1', x: 'In Safari, tap “Share”.' },
        { n: '2', x: 'Choose “Add to Home Screen”.' },
        { n: '3', x: 'Open Example Mail from the new icon and turn on push there.' },
      ],
    });
    expect(flags(v)).toEqual(['isIos', 'hasSteps']);
  });

  it('active: device name of the subscription, without a name "This device"', () => {
    const v = values({ status: 'active', device: 'Firefox on Linux' });
    expect(v).toMatchObject({
      icon: 'ti-bell-check',
      title: 'Active on this device',
      text: 'Firefox on Linux receives push notifications. Choose which topics are sent under Topics, and new emails for each account under New emails.',
      tileTone: 'accent',
      steps: [],
    });
    expect(flags(v)).toEqual(['isActive']);
    expect(values({ status: 'active', device: null }).text).toMatch(/^This device receives push notifications\./);
  });

  it('passes the actions through; the backdrop only closes on a click beside it', () => {
    const c = ctx();
    const v = values({}, c);
    v.request();
    v.retry();
    v.test();
    v.off();
    expect([c.request, c.retry, c.test, c.off].map((f) => vi.mocked(f).mock.calls.length)).toEqual([1, 1, 1, 1]);
    expect(c.close).not.toHaveBeenCalled();

    const scrim = {};
    const preventDefault = vi.fn();
    v.overlay({ target: {} as EventTarget, currentTarget: scrim as EventTarget, preventDefault });
    expect(c.close).not.toHaveBeenCalled();
    v.overlay({ target: scrim as EventTarget, currentTarget: scrim as EventTarget, preventDefault });
    expect(c.close).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalledOnce();
    v.close();
    expect(c.close).toHaveBeenCalledTimes(2);
  });
});
