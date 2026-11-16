import { describe, expect, it, vi } from 'vitest';
import { RESET0 } from '#lib/state/prefs.svelte.ts';
import { inQuiet } from '#lib/quiet-hours.ts';
import {
  notifValues,
  pushText,
  type MailPushAccount,
  type NotifContext,
  type NotifInput,
  type NotifValues,
} from './notification-settings.ts';

const QUIET_ON =
  'No emails or push notifications daily from 22:00 to 07:00. Security alerts still arrive right away, new emails without sound.';
const NOTE =
  'Emails and push notifications from this period arrive when it ends. The bell in the app shows everything right away.';
const DELIV = 'When emails and push notifications arrive and whether the app plays a sound.';
const LOCKED = 'Security alerts always arrive in the app and by email';
// Winter time in New York (GMT-5).
const WINTER = Date.UTC(2026, 0, 15, 12);
// Push channel active on this device.
const ACTIVE: NotifInput['push'] = {
  support: 'yes',
  permission: 'granted',
  status: 'active',
  subscribed: true,
  appName: 'Roedy Mail',
};
const ACCOUNT: MailPushAccount = {
  id: 'a1',
  email: 'account1@s1.test',
  host: 'mail.s1.test',
  auth: false,
  blocked: false,
  status: 'off',
};

function input(over: Partial<NotifInput> = {}, values: Partial<NotifInput['values']> = {}): NotifInput {
  return {
    values: { ...structuredClone(RESET0), ...values },
    email: 'jane@example.net',
    isAdmin: true,
    push: { support: 'yes', permission: 'default', status: 'ask', subscribed: false, appName: 'Roedy Mail' },
    mailAccounts: null,
    offline: false,
    zone: 'Europe/Berlin',
    device: 'Europe/Berlin',
    now: WINTER,
    time: null,
    edit: null,
    isMobile: false,
    ...over,
  };
}

function context() {
  return {
    set: vi.fn<NotifContext['set']>(),
    scrollTo: vi.fn<NotifContext['scrollTo']>(),
    pushOn: vi.fn<NotifContext['pushOn']>(),
    pushDialog: vi.fn<NotifContext['pushDialog']>(),
    mailPushOn: vi.fn<NotifContext['mailPushOn']>().mockResolvedValue('on'),
    mailPushOff: vi.fn<NotifContext['mailPushOff']>().mockResolvedValue(undefined),
    mailPushPause: vi.fn<NotifContext['mailPushPause']>(),
    goConnection: vi.fn<NotifContext['goConnection']>(),
    toastError: vi.fn<NotifContext['toastError']>(),
    showTime: vi.fn<NotifContext['showTime']>(),
    editTime: vi.fn<NotifContext['editTime']>(),
  } satisfies NotifContext;
}

function values(over: Partial<NotifInput> = {}, v: Partial<NotifInput['values']> = {}): NotifValues {
  return notifValues(input(over, v), context());
}

function row(v: NotifValues, label: string) {
  const r = v.nTopicRows.find((t) => t.label === label);
  if (!r) throw new Error(`topic ${label} missing`);
  return r;
}

function chip(v: NotifValues, topic: string, label: string) {
  const c = row(v, topic).chips.find((x) => x.label === label);
  if (!c) throw new Error(`chip ${label} missing`);
  return c;
}

describe('notifications: channels', () => {
  it('shows the three channels with description', () => {
    const v = values();
    expect(v.nChRows.map((r) => [r.label, r.icon, r.sep, r.tg.on])).toEqual([
      ['In the app', 'ti-bell', false, true],
      ['Email', 'ti-mail', true, true],
      ['Push notifications', 'ti-device-mobile', true, false],
    ]);
    expect(v.nChRows.map((r) => r.desc)).toEqual([
      'Shown on the bell at the top right',
      'To jane@example.net',
      'Not yet allowed in the browser',
    ]);
    expect(v.nChRows.every((r) => !r.askHere)).toBe(true);
  });

  it('app and email channels switched off above', () => {
    const v = values({}, { nCh: { app: false, mail: false, push: false } });
    expect(v.nChRows[1]?.desc).toBe('To jane@example.net. Security alerts are still sent by email.');
    expect(row(v, 'Security').desc).toBe('New sign-ins and changes to your password and multi-factor authentication');
    expect(chip(v, 'Security', 'App')).toMatchObject({ on: true, lock: true, live: false, tip: LOCKED });
    expect(chip(v, 'Security', 'Email')).toMatchObject({ on: true, lock: true, tip: LOCKED });
    expect(chip(v, 'Security', 'Push').lock).toBe(false);
    expect(chip(v, 'Account', 'Email')).toMatchObject({
      on: false,
      live: false,
      lock: false,
      tip: 'Email is turned off',
    });
  });

  it('describes push by support and permission', () => {
    expect(pushText({ appName: 'Roedy Mail', support: 'yes', permission: 'granted' })).toBe('Allowed in the browser');
    expect(pushText({ appName: 'Roedy Mail', support: 'yes', permission: 'denied' })).toBe(
      'Blocked in the browser. Allow notifications in your browser settings.',
    );
    expect(pushText({ appName: 'Roedy Mail', support: 'yes', permission: 'default' })).toBe(
      'Not yet allowed in the browser',
    );
    expect(pushText({ appName: 'Roedy Mail', support: 'none', permission: 'default' })).toBe(
      'This browser doesn’t support push notifications',
    );
    expect(pushText({ support: 'ios', permission: 'granted', appName: 'Roedy Mail' })).toBe(
      'On iPhone and iPad, push notifications only work when Roedy Mail is on your Home Screen as an app.',
    );
  });

  it('offers "Allow in browser" only with the channel on and the browser not subscribed', () => {
    const push = (status: NotifInput['push']['status'], on: boolean) =>
      values(
        { push: { support: 'yes', permission: 'default', status, subscribed: false, appName: 'Roedy Mail' } },
        { nCh: { app: true, mail: true, push: on } },
      ).nChRows[2]?.askHere;
    expect(push('ask', true)).toBe(true);
    expect(push('ask', false)).toBe(false);
    expect(push('active', true)).toBe(false);
    expect(push('denied', true)).toBe(false);
    expect(push('busy', true)).toBe(false);
    const ctx = context();
    notifValues(input(), ctx).pushRequest();
    expect(ctx.pushDialog).toHaveBeenCalledOnce();
  });

  it('toggles app and email', () => {
    const ctx = context();
    const v = notifValues(input(), ctx);
    v.nChRows[0]?.tg.onClick();
    expect(ctx.set).toHaveBeenLastCalledWith({ nCh: { app: false, mail: true, push: false } });
    v.nChRows[1]?.tg.onClick();
    expect(ctx.set).toHaveBeenLastCalledWith({ nCh: { app: true, mail: false, push: false } });
  });

  it('push: off turns off the channel and unsubscribes the mail accounts of this device', () => {
    const ctx = context();
    notifValues(input({}, { nCh: { app: true, mail: true, push: true } }), ctx).nChRows[2]?.tg.onClick();
    expect(ctx.set).toHaveBeenCalledWith({ nCh: { app: true, mail: true, push: false } });
    expect(ctx.mailPushPause).toHaveBeenCalledOnce();
    expect(ctx.pushOn).not.toHaveBeenCalled();
    expect(ctx.pushDialog).not.toHaveBeenCalled();
  });

  it('turning off app and email leaves the mail accounts alone', () => {
    const ctx = context();
    const v = notifValues(input(), ctx);
    v.nChRows[0]?.tg.onClick();
    v.nChRows[1]?.tg.onClick();
    expect(ctx.mailPushPause).not.toHaveBeenCalled();
  });

  it('turning on push: if subscribed only the channel, with permission subscribe silently, otherwise the dialog', () => {
    const on = (p: NotifInput['push']) => {
      const ctx = context();
      notifValues(input({ push: p }), ctx).nChRows[2]?.tg.onClick();
      return ctx;
    };
    const subscribed = on({
      support: 'yes',
      permission: 'granted',
      status: 'ask',
      subscribed: true,
      appName: 'Roedy Mail',
    });
    expect(subscribed.set).toHaveBeenCalledWith({ nCh: { app: true, mail: true, push: true } });
    expect(subscribed.pushOn).not.toHaveBeenCalled();

    const granted = on({
      support: 'yes',
      permission: 'granted',
      status: 'ask',
      subscribed: false,
      appName: 'Roedy Mail',
    });
    expect(granted.pushOn).toHaveBeenCalledOnce();
    expect(granted.set).not.toHaveBeenCalled();
    expect(granted.pushDialog).not.toHaveBeenCalled();

    for (const p of [
      { support: 'yes', permission: 'default', status: 'ask', subscribed: false, appName: 'Roedy Mail' },
      { support: 'yes', permission: 'denied', status: 'denied', subscribed: false, appName: 'Roedy Mail' },
      { support: 'none', permission: 'default', status: 'none', subscribed: false, appName: 'Roedy Mail' },
      { support: 'ios', permission: 'default', status: 'ios', subscribed: false, appName: 'Roedy Mail' },
    ] as const) {
      const ctx = on(p);
      expect(ctx.pushDialog).toHaveBeenCalledOnce();
      expect(ctx.set).not.toHaveBeenCalled();
      expect(ctx.pushOn).not.toHaveBeenCalled();
    }
  });
});

describe('notifications: topics', () => {
  it('shows all five topics for administrators', () => {
    const v = values();
    expect(v.nTopicRows.map((t) => [t.label, t.icon, t.sep])).toEqual([
      ['Security', 'ti-shield-lock', false],
      ['Account', 'ti-user', true],
      ['Team', 'ti-users', true],
      ['System', 'ti-server', true],
      ['News', 'ti-sparkles', true],
    ]);
    expect(row(v, 'Team').desc).toBe('Invitations and role changes');
    expect(row(v, 'System').desc).toBe('Updates, backups, and maintenance');
    expect(row(v, 'Account').desc).toBe('Changes to your profile and storage space');
    expect(row(v, 'News').desc).toBe('New features and tips');
    expect(row(v, 'Security').chips.map((c) => [c.label, c.icon, c.aria])).toEqual([
      ['App', 'ti-bell', 'Security, In the app'],
      ['Email', 'ti-mail', 'Security, Email'],
      ['Push', 'ti-device-mobile', 'Security, Push notifications'],
    ]);
  });

  it('users do not see team and system', () => {
    const v = values({ isAdmin: false });
    expect(v.nTopicRows.map((t) => t.label)).toEqual(['Security', 'Account', 'News']);
    expect(v.nTopicRows[0]?.sep).toBe(false);
    expect(v.digestSum).toBe('One email every morning at 07:00 with everything new');
  });

  it('chips follow channel and selection; switched-off push chips with tooltip', () => {
    const v = values();
    expect(chip(v, 'Account', 'App')).toMatchObject({ on: true, live: true, lock: false, tip: undefined });
    expect(chip(v, 'Account', 'Email').on).toBe(true);
    expect(chip(v, 'Team', 'Email').on).toBe(false);
    expect(chip(v, 'Account', 'Push')).toMatchObject({
      on: false,
      live: false,
      tip: 'Push notifications is turned off',
    });
    // Security with push: chosen, but the channel is off.
    expect(chip(v, 'Security', 'Push')).toMatchObject({ on: false, live: false, lock: false });
  });

  it('toggles a channel per topic, not for locked or switched-off channels', () => {
    const ctx = context();
    const v = notifValues(input(), ctx);
    chip(v, 'Team', 'Email').onClick();
    expect(ctx.set).toHaveBeenLastCalledWith({
      nMx: { ...RESET0.nMx, team: { app: true, mail: true, push: false } },
    });
    chip(v, 'Account', 'App').onClick();
    expect(ctx.set).toHaveBeenLastCalledWith({
      nMx: { ...RESET0.nMx, account: { app: false, mail: true, push: false } },
    });
    ctx.set.mockClear();
    chip(v, 'Security', 'App').onClick();
    chip(v, 'Security', 'Email').onClick();
    chip(v, 'Account', 'Push').onClick();
    expect(ctx.set).not.toHaveBeenCalled();
  });

  it('adds a missing topic to the saved settings', () => {
    const ctx = context();
    const nMx = { security: { app: true, mail: true, push: true } };
    const v = notifValues(input({}, { nMx }), ctx);
    expect(chip(v, 'News', 'App').on).toBe(false);
    chip(v, 'News', 'App').onClick();
    expect(ctx.set).toHaveBeenCalledWith({ nMx: { ...nMx, news: { app: true, mail: false, push: false } } });
  });
});

describe('notifications: new emails', () => {
  const row = (a: Partial<MailPushAccount>, over: Partial<NotifInput> = {}) => {
    const ctx = context();
    const v = notifValues(input({ push: ACTIVE, mailAccounts: [{ ...ACCOUNT, ...a }], ...over }), ctx);
    const r = v.mpRows[0];
    if (!r) throw new Error('row missing');
    return { r, ctx };
  };

  it('knows texts and states without accounts', () => {
    const v = values({ mailAccounts: [] });
    expect(v.mpSub).toBe(
      'A push notification when a new email arrives in your Inbox. These switches apply only to this device.',
    );
    expect(v).toMatchObject({
      mpNone: true,
      mpNoneText: 'Connect an email account first.',
      mpHasRows: false,
      mpRows: [],
      mpNeed: false,
    });
  });

  it('shows neither empty state nor rows before the accounts load', () => {
    expect(values()).toMatchObject({ mpNone: false, mpHasRows: false, mpNeed: false });
  });

  it('separates the rows from the second account on', () => {
    const v = values({ push: ACTIVE, mailAccounts: [ACCOUNT, { ...ACCOUNT, id: 'a2', email: 'account2@s1.test' }] });
    expect(v.mpRows.map((r) => [r.email, r.sep])).toEqual([
      ['account1@s1.test', false],
      ['account2@s1.test', true],
    ]);
    expect(v).toMatchObject({ mpHasRows: true, mpNone: false, mpNeed: false });
  });

  it('off and failed: free and switchable', () => {
    for (const status of ['off', 'failed'] as const)
      expect(row({ status }).r).toMatchObject({
        desc: 'Off',
        tone: null,
        dim: false,
        dis: false,
        busy: false,
        hasRe: false,
        hasCon: false,
        tg: { on: false },
      });
  });

  it('on', () => {
    expect(row({ status: 'on' }).r).toMatchObject({
      desc: 'On for this device',
      tone: null,
      dis: false,
      tg: { on: true },
    });
  });

  it('disabled while switching with a text per direction', () => {
    expect(row({ status: 'pending' }).r).toMatchObject({
      desc: 'Turning on …',
      busy: true,
      dis: true,
      tg: { on: false },
    });
    expect(row({ status: 'stopping' }).r).toMatchObject({ desc: 'Turning off …', busy: true, dis: true });
  });

  it('server without push: disabled', () => {
    expect(row({ status: 'unsupported' }).r).toMatchObject({
      desc: 'mail.s1.test doesn’t support push notifications.',
      tone: null,
      dis: true,
      tg: { on: false },
    });
  });

  it('expired: warning colour, can be turned on again', () => {
    const { r, ctx } = row({ status: 'expired' });
    expect(r).toMatchObject({
      desc: 'Expired. Turn push back on for this account.',
      tone: 'warn',
      dis: false,
      tg: { on: false },
    });
    r.tg.onClick();
    expect(ctx.mailPushOn).toHaveBeenCalledWith('a1');
  });

  it('sign-in required: disabled, "Sign in again" leads to the connection', () => {
    const { r, ctx } = row({ auth: true, status: 'on' });
    expect(r).toMatchObject({
      desc: 'Sign in to account1@s1.test again.',
      tone: 'danger',
      dis: true,
      hasRe: true,
      hasCon: false,
      tg: { on: false },
    });
    r.tg.onClick();
    expect(ctx.mailPushOff).not.toHaveBeenCalled();
    r.goCon();
    expect(ctx.goConnection).toHaveBeenCalledWith('a1');
  });

  it('locked server takes precedence over sign-in required, "Go to connection"', () => {
    const { r, ctx } = row({ blocked: true, auth: true, status: 'on' });
    expect(r).toMatchObject({
      desc: 'mail.s1.test is no longer an approved server.',
      tone: 'danger',
      dis: true,
      hasRe: false,
      hasCon: true,
      tg: { on: false },
    });
    r.goCon();
    expect(ctx.goConnection).toHaveBeenCalledWith('a1');
  });

  it('push channel not active: dimmed, disabled, "Off", the selection stays', () => {
    const push = { ...ACTIVE, status: 'ask' as const };
    const { r, ctx } = row({ status: 'on' }, { push });
    expect(r).toMatchObject({ desc: 'Off', dim: true, dis: true, tg: { on: false } });
    r.tg.onClick();
    expect(ctx.mailPushOn).not.toHaveBeenCalled();
    expect(ctx.mailPushOff).not.toHaveBeenCalled();
  });

  it('"Turn on push": like the switch of the channel', () => {
    const run = (push: NotifInput['push']) => {
      const ctx = context();
      const v = notifValues(input({ push, mailAccounts: [ACCOUNT] }), ctx);
      expect(v).toMatchObject({
        mpNeed: true,
        mpNeedText: 'This requires the Push channel to be turned on for this device.',
        mpNeedBtn: 'Turn on push',
      });
      v.mpNeedRun();
      return ctx;
    };
    const base = { ...ACTIVE, status: 'ask' as const };
    expect(run(base).set).toHaveBeenCalledWith({ nCh: { app: true, mail: true, push: true } });
    expect(run({ ...base, subscribed: false }).pushOn).toHaveBeenCalledOnce();
    expect(run({ ...base, subscribed: false, permission: 'default' }).pushDialog).toHaveBeenCalledOnce();
  });

  it('notice only with active push and active quiet hours', () => {
    const quiet = { nQuiet: true, nFrom: '22:00', nTo: '07:00' };
    expect(values({ push: ACTIVE }, quiet)).toMatchObject({
      mpNoteOn: true,
      mpNote: 'During quiet hours, new emails arrive without sound.',
    });
    expect(values({ push: ACTIVE }, { ...quiet, nTo: '22:00' }).mpNoteOn).toBe(false);
    expect(values({ push: ACTIVE }, { ...quiet, nQuiet: false }).mpNoteOn).toBe(false);
    expect(values({}, quiet).mpNoteOn).toBe(false);
  });

  it('turns on and off, success without a toast', async () => {
    const off = row({});
    off.r.tg.onClick();
    expect(off.ctx.mailPushOn).toHaveBeenCalledWith('a1');
    const on = row({ status: 'on' });
    on.r.tg.onClick();
    expect(on.ctx.mailPushOff).toHaveBeenCalledWith('a1');
    await Promise.resolve();
    expect(off.ctx.toastError).not.toHaveBeenCalled();
    expect(on.ctx.toastError).not.toHaveBeenCalled();
  });

  it('reports a failed turn-on as a toast, server without push only in the row', async () => {
    const { r, ctx } = row({});
    ctx.mailPushOn.mockResolvedValueOnce('failed');
    r.tg.onClick();
    const text = 'Push wasn’t turned on. Please try again.';
    await vi.waitFor(() => expect(ctx.toastError).toHaveBeenCalledWith(text));

    ctx.toastError.mockClear();
    ctx.mailPushOn.mockRejectedValueOnce(new Error('broken'));
    r.tg.onClick();
    await vi.waitFor(() => expect(ctx.toastError).toHaveBeenCalledWith(text));

    ctx.toastError.mockClear();
    ctx.mailPushOn.mockResolvedValueOnce('unsupported');
    r.tg.onClick();
    await Promise.resolve();
    await Promise.resolve();
    expect(ctx.toastError).not.toHaveBeenCalled();
  });

  it('reports a failed turn-off as a toast', async () => {
    const { r, ctx } = row({ status: 'on' });
    ctx.mailPushOff.mockRejectedValueOnce(new Error('broken'));
    r.tg.onClick();
    await vi.waitFor(() => expect(ctx.toastError).toHaveBeenCalledWith('Push wasn’t turned off. Please try again.'));
  });

  it('does not switch without a connection', () => {
    for (const status of ['off', 'on'] as const) {
      const { r, ctx } = row({ status }, { offline: true });
      r.tg.onClick();
      expect(ctx.toastError).toHaveBeenCalledWith('No connection. Please try again.');
      expect(ctx.mailPushOn).not.toHaveBeenCalled();
      expect(ctx.mailPushOff).not.toHaveBeenCalled();
    }
  });
});

describe('notifications: delivery', () => {
  it('default: quiet hours off, digest daily', () => {
    const v = values();
    expect(v.tgQuiet.on).toBe(false);
    expect(v.quietSum).toBe('Emails and push notifications arrive at any time.');
    expect(v.quietNote).toBe(NOTE);
    expect(v.quietNoteIcon).toBe('ti-info-circle');
    expect(v.quietSame).toBe(false);
    expect(v.quietDim).toBe(true);
    expect(v.nFromSel).toMatchObject({
      title: 'Quiet hours start',
      inputVal: '22:00',
      disabled: true,
      open: false,
    });
    expect(v.nToSel).toMatchObject({ title: 'Quiet hours end', inputVal: '07:00', disabled: true });
    expect(v.nH24).toBe(true);
    expect(v.digestOpts.map((o) => [o.label, o.on])).toEqual([
      ['Instant', false],
      ['Daily', true],
      ['Weekly', false],
    ]);
    expect(v.digestSum).toBe('One email every morning at 07:00 with everything new');
    expect(v.digestDim).toBe(false);
    expect(v.delivSub).toBe(DELIV);
    expect(v.tgSound.on).toBe(true);
    expect(v.soundDis).toBe(false);
    expect(v.soundTip).toBeUndefined();
    expect(v.notifTabs.map((t) => t.label)).toEqual(['Channels', 'Topics', 'New emails', 'Delivery']);
  });

  it('quiet hours on (22:00–07:00)', () => {
    const v = values({}, { nQuiet: true });
    expect(v.tgQuiet.on).toBe(true);
    expect(v.quietSum).toBe(QUIET_ON);
    expect(v.quietNote).toBe(NOTE);
    expect(v.quietDim).toBe(false);
    expect(v.nFromSel.inputVal).toBe('22:00');
    expect(v.nToSel.inputVal).toBe('07:00');
    expect(v.nFromSel.disabled).toBe(false);
    expect(v.digestSum).toBe('One email every morning at 07:00 with everything new');
  });

  it('quiet hours on until 08:00: digest at the end of the quiet hours', () => {
    const v = values({}, { nQuiet: true, nTo: '08:00' });
    expect(v.quietSum).toBe(
      'No emails or push notifications daily from 22:00 to 08:00. Security alerts still arrive right away, new emails without sound.',
    );
    expect(v.digestSum).toBe('One email every day at 08:00 with everything new, at the end of quiet hours');
    expect(values({}, { nQuiet: true, nTo: '08:00', nDigest: 'weekly' }).digestSum).toBe(
      'One email every Monday at 08:00 with everything new, at the end of quiet hours',
    );
    // Quiet hours off: 07:00 as always.
    expect(values({}, { nTo: '08:00' }).digestSum).toBe('One email every morning at 07:00 with everything new');
  });

  it('quiet hours on, start = end (22:00)', () => {
    const v = values({}, { nQuiet: true, nTo: '22:00' });
    expect(v.quietSame).toBe(true);
    expect(v.quietSum).toBe('Start and end are the same, so no quiet hours apply.');
    expect(v.quietNote).toBe('Choose different times for start and end.');
    expect(v.quietNoteIcon).toBe('ti-alert-circle');
    expect(v.digestSum).toBe('One email every morning at 07:00 with everything new');
  });

  it('12-hour format, quiet hours on', () => {
    const v = values({}, { nQuiet: true, timeFmt: '12h' });
    expect(v.nH24).toBe(false);
    expect(v.nFromSel.inputVal).toBe('10:00 PM');
    expect(v.nToSel.inputVal).toBe('7:00 AM');
    expect(v.quietSum).toBe(
      'No emails or push notifications daily from 10:00 PM to 7:00 AM. Security alerts still arrive right away, new emails without sound.',
    );
    expect(v.digestSum).toBe('One email every morning at 7:00 AM with everything new');
  });

  it('digest instant, weekly and without the email channel', () => {
    expect(values({}, { nDigest: 'instant' }).digestSum).toBe('Each notification as a separate email');
    // Held-back emails go out individually, only with active quiet hours (start ≠ end).
    expect(values({}, { nDigest: 'instant', nQuiet: true }).digestSum).toBe(
      'Each notification as a separate email; those from quiet hours one by one when they end',
    );
    expect(values({}, { nDigest: 'instant', nQuiet: true, nFrom: '22:00', nTo: '22:00' }).digestSum).toBe(
      'Each notification as a separate email',
    );
    expect(values({}, { nDigest: 'weekly' }).digestSum).toBe('One email every Monday at 07:00 with everything new');
    const off = values({}, { nCh: { app: true, mail: false, push: false } });
    expect(off.digestSum).toBe('Email notifications are turned off. Security alerts are still sent by email.');
    expect(off.digestDim).toBe(true);
  });

  it('"In the app" channel off: sound disabled', () => {
    const ctx = context();
    const v = notifValues(input({}, { nCh: { app: false, mail: true, push: false } }), ctx);
    expect(v.tgSound.on).toBe(true);
    expect(v.soundDis).toBe(true);
    expect(v.soundTip).toBe('In-app notifications are turned off');
    v.tgSound.onClick();
    expect(ctx.set).not.toHaveBeenCalled();
    // No tooltip on mobile.
    expect(values({ isMobile: true }, { nCh: { app: false, mail: true, push: false } }).soundTip).toBeUndefined();
  });

  it('different time zone (automatic off, America/New_York)', () => {
    expect(values({ zone: 'America/New_York', device: 'Europe/Berlin' }).delivSub).toBe(
      `${DELIV} Times are shown in this time zone: New York, Toronto (GMT-5).`,
    );
    expect(values({ zone: 'America/New_York', device: undefined }).delivSub).toBe(DELIV);
  });

  it('actions: quiet hours, times, digest, sound and tabs', () => {
    const ctx = context();
    const v = notifValues(input({}, { nQuiet: true }), ctx);
    v.tgQuiet.onClick();
    expect(ctx.set).toHaveBeenLastCalledWith({ nQuiet: false });
    v.nFromSel.hours[21]?.onClick();
    expect(ctx.set).toHaveBeenLastCalledWith({ nFrom: '21:00' });
    expect(ctx.editTime).toHaveBeenLastCalledWith('from', null);
    v.nToSel.mins[30]?.onClick();
    expect(ctx.set).toHaveBeenLastCalledWith({ nTo: '07:30' });
    expect(ctx.showTime).toHaveBeenLastCalledWith(null);
    v.nToSel.toggle();
    expect(ctx.showTime).toHaveBeenLastCalledWith('to');
    v.nFromSel.onInput('23');
    expect(ctx.set).toHaveBeenLastCalledWith({ nFrom: '23:00' });
    expect(ctx.editTime).toHaveBeenLastCalledWith('from', '23');
    v.digestOpts[2]?.onClick();
    expect(ctx.set).toHaveBeenLastCalledWith({ nDigest: 'weekly' });
    v.tgSound.onClick();
    expect(ctx.set).toHaveBeenLastCalledWith({ nSound: false });
    v.notifTabs[2]?.onClick();
    expect(ctx.scrollTo).toHaveBeenLastCalledWith('mailpush');
    v.notifTabs[3]?.onClick();
    expect(ctx.scrollTo).toHaveBeenLastCalledWith('delivery');
    v.notifTabs[0]?.onClick();
    expect(ctx.scrollTo).toHaveBeenLastCalledWith('channels');
  });

  it('shows the open time picker and the typed text only at its own field', () => {
    const v = values({ time: 'to', edit: { key: 'from', text: '23:' } }, { nQuiet: true });
    expect(v.nFromSel).toMatchObject({ open: false, inputVal: '23:' });
    expect(v.nToSel).toMatchObject({ open: true, inputVal: '07:00' });
    expect(values({ time: 'to', isMobile: true }, { nQuiet: true }).nToSel.open).toBe(false);
  });

  it('inQuiet: across midnight and during the day', () => {
    expect(inQuiet(420, '22:00', '08:00')).toBe(true);
    expect(inQuiet(420, '22:00', '07:00')).toBe(false);
    expect(inQuiet(1380, '22:00', '07:00')).toBe(true);
    expect(inQuiet(420, '06:00', '09:00')).toBe(true);
    expect(inQuiet(600, '06:00', '09:00')).toBe(false);
  });
});
