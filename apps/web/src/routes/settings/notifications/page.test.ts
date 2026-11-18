import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { tooltips } from '#lib/actions/tooltip.ts';
import { mailPush, type MailPushStatus } from '#lib/mail-push.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { push } from '#lib/push.svelte.ts';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { network } from '#lib/state/network.svelte.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session, type Me } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

// The tabs scroll to the section; jsdom has no layout (`offsetParent`), hence only the call.
const scrollToSection = vi.hoisted(() => vi.fn());
vi.mock('#lib/sections.ts', () => ({ scrollToSection }));
const nav = vi.hoisted(() => ({ goto: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: nav.goto }));

const TABS = ['Channels', 'Topics', 'New emails', 'Delivery'];
const SECTIONS = ['channels', 'topics', 'mailpush', 'delivery'];
const DELIV = 'When emails and push notifications arrive and whether the app plays a sound.';
const QUIET_OFF = 'Emails and push notifications arrive at any time.';
const QUIET_ON =
  'No emails or push notifications daily from 22:00 to 07:00. Security alerts still arrive right away, new emails without sound.';
const LOCKED = 'Security alerts always arrive in the app and by email';

const ME: Me = {
  id: 'u1',
  username: 'jane',
  email: 'jane@example.com',
  display_name: 'Jane Doe',
  role: 'admin',
  mfa_enabled: false,
  password_changed_at: '2026-10-01T10:00:00Z',
  email_change: null,
  sole_admin: false,
};

const ACCOUNT: MailAccount = {
  id: 'a1',
  email: 'account1@s1.test',
  username: 'account1',
  url: 'https://mail.s1.test',
  host: 'mail.s1.test',
  server_id: 's1',
  auth_kind: 'oauth',
  color: 0,
  state: 'ok',
  blocked: false,
  quota_used: null,
  quota_total: null,
  last_check_at: null,
  created_at: '2026-11-01T10:00:00Z',
};

/** Push channel active on this device (`push.status`). */
function pushActive() {
  push.permission = 'granted';
  prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
  push.current = {
    id: 's1',
    endpoint: 'https://push.example.test/1',
    device: 'Firefox on Linux',
    created_at: '2026-11-01T10:00:00Z',
    expires_at: null,
    current: true,
  };
}

function mailSwitch() {
  return screen.getByRole('switch', { name: 'New emails for account1@s1.test' });
}

function setStatus(status: MailPushStatus) {
  mailPush.status = { a1: status };
}

function mobile() {
  vi.stubGlobal('innerWidth', 390);
  window.dispatchEvent(new Event('resize'));
}

function field(name: string) {
  return screen.getByRole('textbox', { name });
}

let refresh: MockInstance<() => Promise<void>>;
let request: MockInstance<() => Promise<void>>;
let enable: MockInstance<(id: string) => Promise<MailPushStatus>>;
let disable: MockInstance<(id: string) => Promise<void>>;
let inspect: MockInstance<(ids: readonly string[]) => Promise<void>>;
let restore: MockInstance<() => Promise<void>>;
let pause: MockInstance<() => Promise<void>>;

beforeEach(() => {
  refresh = vi.spyOn(push, 'refresh').mockResolvedValue(undefined);
  request = vi.spyOn(push, 'request').mockResolvedValue(undefined);
  enable = vi.spyOn(mailPush, 'enable').mockResolvedValue('on');
  disable = vi.spyOn(mailPush, 'disable').mockResolvedValue(undefined);
  inspect = vi.spyOn(mailPush, 'inspect').mockResolvedValue(undefined);
  restore = vi.spyOn(mailPush, 'restore').mockResolvedValue(undefined);
  pause = vi.spyOn(mailPush, 'pause').mockResolvedValue(undefined);
  push.support = 'yes';
  push.permission = 'default';
  session.user = ME;
  // jsdom does not know `scrollTo` on elements (columns of the time picker).
  HTMLElement.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  scrollToSection.mockClear();
  nav.goto.mockClear();
  network.simulated = false;
  accounts.reset();
  mailPush.reset();
  push.reset();
  push.support = 'none';
  push.permission = 'default';
  session.user = null;
  ui.reset();
  prefs.reset();
  window.dispatchEvent(new Event('resize'));
});

describe('Notifications page', () => {
  it('shows header, tabs and the sections and checks push on opening', () => {
    const view = render(Page);
    expect(refresh).toHaveBeenCalledOnce();
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Notifications');
    expect(view.getByText('Choose what you want to be notified about.')).toBeInTheDocument();
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(TABS);
    expect(Array.from(view.container.querySelectorAll('[data-sec]'), (s) => s.getAttribute('data-sec'))).toEqual(
      SECTIONS,
    );
    expect(view.getByText('How you receive notifications.')).toBeInTheDocument();
    expect(view.getByText('Choose the channels for each topic. Channels that are off are dimmed.')).toBeInTheDocument();
    expect(view.getByText(DELIV)).toBeInTheDocument();
  });

  it('swallows errors while checking push', () => {
    refresh.mockRejectedValue(new Error('offline'));
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toBeInTheDocument();
  });

  it('scrolls to the section via the tabs, instantly without animations', async () => {
    const view = render(Page);
    const tabs = Array.from(view.container.querySelectorAll<HTMLElement>('.tab'));
    expect(tabs.map((t) => t.textContent)).toEqual(TABS);
    for (const [i, tab] of tabs.entries()) {
      await fireEvent.click(tab);
      expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), SECTIONS[i], true);
    }
    prefs.set({ animations: false });
    await fireEvent.click(tabs[1]!);
    expect(scrollToSection).toHaveBeenLastCalledWith(expect.any(HTMLElement), 'topics', false);
  });

  it('shows and toggles the app and email channels', async () => {
    const view = render(Page);
    const app = view.getByRole('switch', { name: 'In the app' });
    const mail = view.getByRole('switch', { name: 'Email' });
    expect(view.getByText('Shown on the bell at the top right')).toBeInTheDocument();
    expect(view.getByText('To jane@example.com')).toBeInTheDocument();
    expect(app).toHaveAttribute('aria-checked', 'true');
    expect(app.parentElement?.querySelector('.tile')).toHaveClass('on');
    expect(app.parentElement?.querySelector('.tile svg')).toHaveClass('tabler-icon-bell');
    await fireEvent.click(mail);
    expect(prefs.values.nCh.mail).toBe(false);
    expect(mail).toHaveAttribute('aria-checked', 'false');
    expect(mail.parentElement?.querySelector('.tile')).not.toHaveClass('on');
    expect(view.getByText('To jane@example.com. Security alerts are still sent by email.')).toBeInTheDocument();
    await fireEvent.click(app);
    expect(prefs.values.nCh.app).toBe(false);
  });

  it('describes push by the state of the browser', async () => {
    const view = render(Page);
    expect(view.getByText('Not yet allowed in the browser')).toBeInTheDocument();
    push.permission = 'denied';
    await tick();
    expect(view.getByText('Blocked in the browser. Allow notifications in your browser settings.')).toBeInTheDocument();
    push.permission = 'granted';
    await tick();
    expect(view.getByText('Allowed in the browser')).toBeInTheDocument();
    push.support = 'ios';
    await tick();
    expect(
      view.getByText(/On iPhone and iPad, push notifications only work when .+ is on your Home Screen as an app\./),
    ).toBeInTheDocument();
  });

  it('push without permission opens the push dialog; "Allow in browser" too', async () => {
    const view = render(Page);
    expect(ui.pageDialog?.()).toBeNull();
    await fireEvent.click(view.getByRole('switch', { name: 'Push notifications' }));
    expect(prefs.values.nCh.push).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(ui.pageDialog?.()?.title).toBe('Push notifications');
    ui.pageDialog?.()?.close();
    expect(ui.pageDialog?.()).toBeNull();

    // Channel on, but the browser has not asked yet: button below the row.
    prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
    await tick();
    const allow = view.getByRole('button', { name: 'Allow in browser' });
    expect(allow.querySelector('svg')).toHaveClass('tabler-icon-bell-ringing');
    await fireEvent.click(allow);
    expect(ui.pageDialog?.()?.title).toBe('Push notifications');
  });

  it('push with permission subscribes this browser; on without "Allow in browser"', async () => {
    push.permission = 'granted';
    const view = render(Page);
    const sw = view.getByRole('switch', { name: 'Push notifications' });
    await fireEvent.click(sw);
    expect(request).toHaveBeenCalledOnce();
    expect(ui.pageDialog?.()).toBeNull();
    expect(prefs.values.nCh.push).toBe(false);

    // Turned on (also on another device): with permission it counts as active, without a button below.
    prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
    await tick();
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(view.getByText('Allowed in the browser')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Allow in browser' })).toBeNull();
    await fireEvent.click(sw);
    expect(prefs.values.nCh.push).toBe(false);
    expect(pause).toHaveBeenCalledOnce();
  });

  it('permission, channel on, silent subscription failed: off on this device, "Turn on push" subscribes', async () => {
    accounts.list = [ACCOUNT];
    push.permission = 'granted';
    prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
    push.missing = true;
    const view = render(Page);
    const sw = view.getByRole('switch', { name: 'Push notifications' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(view.getByText('Allowed in the browser')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Allow in browser' })).toBeNull();
    expect(mailSwitch()).toHaveAttribute('aria-disabled', 'true');
    expect(restore).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'Turn on push' }));
    expect(request).toHaveBeenCalledOnce();
    await fireEvent.click(sw);
    expect(request).toHaveBeenCalledTimes(2);
    expect(prefs.values.nCh.push).toBe(true);
    expect(ui.pageDialog?.()).toBeNull();
  });

  it('opens the push dialog from the command palette, also on the open page', async () => {
    ui.pushOpen = true;
    const view = render(Page);
    await vi.waitFor(() => expect(ui.pageDialog?.()?.title).toBe('Push notifications'));
    expect(ui.pushOpen).toBe(false);
    ui.pageDialog?.()?.close();
    ui.pushOpen = true;
    await vi.waitFor(() => expect(ui.pageDialog?.()?.title).toBe('Push notifications'));
    expect(ui.pushOpen).toBe(false);
    view.unmount();
    expect(ui.pageDialog).toBeNull();
  });

  it('shows the topics with chips; security with locked chips', async () => {
    const view = render(Page);
    for (const label of ['Security', 'Account', 'Team', 'System', 'News'])
      expect(view.getByText(label)).toBeInTheDocument();
    const secApp = view.getByRole('switch', { name: 'Security, In the app' });
    expect(secApp).toHaveTextContent('App');
    expect(secApp).toHaveAttribute('aria-checked', 'true');
    expect(secApp).toHaveAttribute('aria-disabled', 'true');
    expect(secApp).toHaveClass('on');
    expect(secApp).toHaveClass('fixed');
    expect(secApp.querySelector('.lock svg')).toHaveClass('tabler-icon-lock');
    expect(tooltips.targets.get(secApp)?.text).toBe(LOCKED);
    await fireEvent.click(secApp);
    expect(prefs.values.nMx.security?.app).toBe(true);

    const teamMail = view.getByRole('switch', { name: 'Team, Email' });
    expect(teamMail).toHaveAttribute('aria-checked', 'false');
    expect(teamMail).toHaveAttribute('aria-disabled', 'false');
    expect(teamMail.querySelector('.lock')).toBeNull();
    expect(tooltips.targets.get(teamMail)?.text).toBeUndefined();
    await fireEvent.click(teamMail);
    expect(prefs.values.nMx.team?.mail).toBe(true);
    expect(teamMail).toHaveAttribute('aria-checked', 'true');

    // Push is off: dimmed, without effect, with tooltip.
    const push0 = view.getByRole('switch', { name: 'Account, Push notifications' });
    expect(push0).toHaveClass('off');
    expect(push0).toHaveAttribute('aria-disabled', 'true');
    expect(tooltips.targets.get(push0)?.text).toBe('Push notifications is turned off');
    await fireEvent.click(push0);
    expect(prefs.values.nMx.account?.push).toBe(false);
  });

  it('shows users only security, account and news', () => {
    session.user = { ...ME, role: 'user' };
    const view = render(Page);
    expect(view.getByText('News')).toBeInTheDocument();
    expect(view.queryByText('Team')).toBeNull();
    expect(view.queryByText('System')).toBeNull();
    expect(view.container.querySelectorAll('.chips')).toHaveLength(3);
  });

  it('quiet hours: locked when off, with summary and notice when on', async () => {
    const view = render(Page);
    expect(view.getByText(QUIET_OFF)).toBeInTheDocument();
    const from = field('Quiet hours start');
    const to = field('Quiet hours end');
    expect(from).toHaveValue('22:00');
    expect(to).toHaveValue('07:00');
    expect(from).toBeDisabled();
    expect(view.getByRole('button', { name: 'Choose Quiet hours start' })).toBeDisabled();
    expect(view.container.querySelector('.times')).toHaveClass('dim');
    expect(view.container.querySelector('.note')).toHaveClass('dim');
    // The English clock has no unit after the field.
    expect(view.container.querySelector('.uhr')).toBeNull();

    await fireEvent.click(view.getByRole('switch', { name: 'Quiet hours' }));
    expect(prefs.values.nQuiet).toBe(true);
    expect(view.getByText(QUIET_ON)).toBeInTheDocument();
    expect(from).toBeEnabled();
    expect(view.container.querySelector('.times')).not.toHaveClass('dim');
    expect(
      view.getByText(
        'Emails and push notifications from this period arrive when it ends. The bell in the app shows everything right away.',
      ),
    ).toBeInTheDocument();
    expect(view.container.querySelector('.note-icon svg')).toHaveClass('tabler-icon-info-circle');

    // Start = end: warning.
    prefs.set({ nTo: '22:00' });
    await tick();
    expect(view.getByText('Start and end are the same, so no quiet hours apply.')).toBeInTheDocument();
    expect(view.getByText('Choose different times for start and end.')).toBeInTheDocument();
    expect(view.container.querySelector('.note')).toHaveClass('warn');
    expect(view.container.querySelector('.note-icon svg')).toHaveClass('tabler-icon-alert-circle');
  });

  it('time field on desktop: focus opens the popover, select hour and minute', async () => {
    prefs.set({ nQuiet: true });
    const view = render(Page);
    const from = field('Quiet hours start');
    const clock = view.getByRole('button', { name: 'Choose Quiet hours start' });
    expect(clock).toHaveAttribute('aria-haspopup', 'dialog');
    expect(clock).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.focus(from);
    expect(ui.menu).toBe('time');
    expect(clock).toHaveAttribute('aria-expanded', 'true');
    expect(from.parentElement).toHaveClass('open');
    const pop = view.getByRole('dialog', { name: 'Quiet hours start' });
    expect(pop.closest('[data-pop]')).not.toBeNull();
    const hours = within(pop).getByRole('listbox', { name: 'Hour' });
    expect(within(hours).getByRole('option', { selected: true })).toHaveTextContent('22');
    await fireEvent.click(within(hours).getByRole('option', { name: '23' }));
    expect(prefs.values.nFrom).toBe('23:00');
    expect(from).toHaveValue('23:00');
    expect(view.getByRole('dialog', { name: 'Quiet hours start' })).toBeInTheDocument();
    await fireEvent.click(within(pop).getByRole('option', { name: '45' }));
    expect(prefs.values.nFrom).toBe('23:45');
    expect(ui.menu).toBeNull();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(from.parentElement).not.toHaveClass('open');
  });

  it('time field on desktop: clock opens and closes, layout closes from outside', async () => {
    prefs.set({ nQuiet: true });
    const view = render(Page);
    const clock = view.getByRole('button', { name: 'Choose Quiet hours end' });
    await fireEvent.click(clock);
    expect(view.getByRole('dialog', { name: 'Quiet hours end' })).toBeInTheDocument();
    await fireEvent.click(clock);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(ui.menu).toBeNull();
    await fireEvent.click(clock);
    // Click outside or Escape: the layout closes the menu.
    ui.closeMenu();
    await tick();
    expect(view.queryByRole('dialog')).toBeNull();
    // Afterwards the clock opens again.
    await fireEvent.click(clock);
    expect(view.getByRole('dialog', { name: 'Quiet hours end' })).toBeInTheDocument();
    // The other field closes this one.
    await fireEvent.focus(field('Quiet hours start'));
    expect(view.getAllByRole('dialog').map((d) => d.getAttribute('aria-label'))).toEqual(['Quiet hours start']);
  });

  it('time field: input, arrow keys, Enter and Escape', async () => {
    prefs.set({ nQuiet: true });
    const view = render(Page);
    const to = field('Quiet hours end');
    await fireEvent.focus(to);
    await fireEvent.input(to, { target: { value: '8x3' } });
    expect(to).toHaveValue('83');
    expect(prefs.values.nTo).toBe('07:00');
    await fireEvent.input(to, { target: { value: '8:3' } });
    expect(prefs.values.nTo).toBe('08:03');
    expect(to).toHaveValue('8:3');
    expect(view.getByText(/to 08:03\./)).toBeInTheDocument();
    await fireEvent.blur(to);
    expect(to).toHaveValue('08:03');

    await fireEvent.keyDown(to, { key: 'ArrowUp' });
    expect(prefs.values.nTo).toBe('08:08');
    await fireEvent.keyDown(to, { key: 'ArrowDown', shiftKey: true });
    expect(prefs.values.nTo).toBe('07:08');
    expect(to).toHaveValue('07:08');
    await fireEvent.focus(to);
    expect(ui.menu).toBe('time');
    await fireEvent.keyDown(to, { key: 'Enter' });
    expect(ui.menu).toBeNull();
    expect(view.queryByRole('dialog')).toBeNull();
    await fireEvent.focus(to);
    await fireEvent.keyDown(to, { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull();
    await fireEvent.focus(to);
    await fireEvent.keyDown(to, { key: 'Tab' });
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('time field in 24-hour format shows the clock unit of the German interface', () => {
    prefs.set({ nQuiet: true, lang: 'de' });
    const view = render(Page);
    expect(view.getAllByText(m.time_uhr({}, { locale: 'de' }))).toHaveLength(2);
  });

  it('time field in 12-hour format', async () => {
    prefs.set({ nQuiet: true, timeFmt: '12h' });
    const view = render(Page);
    expect(field('Quiet hours start')).toHaveValue('10:00 PM');
    expect(field('Quiet hours end')).toHaveValue('7:00 AM');
    expect(
      view.getByText(
        'No emails or push notifications daily from 10:00 PM to 7:00 AM. Security alerts still arrive right away, new emails without sound.',
      ),
    ).toBeInTheDocument();
    await fireEvent.input(field('Quiet hours end'), { target: { value: '6:30 am' } });
    expect(prefs.values.nTo).toBe('06:30');
  });

  it('selects the email digest; locked without the email channel', async () => {
    const view = render(Page);
    const group = within(view.getByRole('radiogroup', { name: 'Email digest' }));
    expect(group.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Instant', 'Daily', 'Weekly']);
    expect(group.getByRole('radio', { checked: true })).toHaveTextContent('Daily');
    expect(view.getByText('One email every morning at 07:00 with everything new')).toBeInTheDocument();
    await fireEvent.click(group.getByRole('radio', { name: 'Weekly' }));
    expect(prefs.values.nDigest).toBe('weekly');
    expect(view.getByText('One email every Monday at 07:00 with everything new')).toBeInTheDocument();
    await fireEvent.click(group.getByRole('radio', { name: 'Instant' }));
    expect(view.getByText('Each notification as a separate email')).toBeInTheDocument();

    await fireEvent.click(view.getByRole('switch', { name: 'Email' }));
    expect(
      view.getByText('Email notifications are turned off. Security alerts are still sent by email.'),
    ).toBeInTheDocument();
    const seg = view.getByRole('radiogroup', { name: 'Email digest' });
    expect(seg).toHaveClass('dim');
    expect(seg).toHaveAttribute('aria-disabled', 'true');
    expect(group.getByRole('radio', { name: 'Daily' })).toBeDisabled();
  });

  it('sound: toggles, locked with tooltip without the "In the app" channel', async () => {
    const view = render(Page);
    const sound = view.getByRole('switch', { name: 'Sound for new notifications' });
    expect(view.getByText('A short sound when a notification arrives while the app is open.')).toBeInTheDocument();
    expect(sound).toHaveAttribute('aria-checked', 'true');
    expect(sound).toHaveAttribute('aria-disabled', 'false');
    expect(tooltips.targets.get(sound)?.text).toBeUndefined();
    await fireEvent.click(sound);
    expect(prefs.values.nSound).toBe(false);
    await fireEvent.click(sound);
    await fireEvent.click(view.getByRole('switch', { name: 'In the app' }));
    expect(sound).toHaveAttribute('aria-disabled', 'true');
    expect(sound).toHaveClass('locked');
    expect(tooltips.targets.get(sound)?.text).toBe('In-app notifications are turned off');
    await fireEvent.click(sound);
    expect(prefs.values.nSound).toBe(true);
  });

  it('names a different time zone from language & region', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 0, 15, 12));
    prefs.set({ tzAuto: false, tz: 'Asia/Tokyo' });
    const view = render(Page);
    expect(
      view.getByText(
        `When emails and push notifications arrive and whether the app plays a sound. Times are shown in this time zone: Tokyo, Seoul (GMT+9).`,
      ),
    ).toBeInTheDocument();
  });

  it('shows the shorter texts and the time picker in the sheet on mobile', async () => {
    mobile();
    prefs.set({ nQuiet: true });
    const view = render(Page);
    expect(view.container.querySelector('.page')).toHaveClass('mobile');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Notifications');
    expect(view.getByText('Choose the channels for each topic.')).toBeInTheDocument();
    const from = field('Quiet hours start');
    await fireEvent.focus(from);
    expect(ui.menu).toBeNull();
    expect(ui.pageDialog?.()).toBeNull();
    const clock = view.getByRole('button', { name: 'Choose Quiet hours start' });
    expect(clock).not.toHaveAttribute('aria-expanded');
    await fireEvent.click(clock);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(ui.menu).toBeNull();
    expect(ui.pageDialog?.()?.title).toBe('Quiet hours start');
    ui.pageDialog?.()?.close();
    expect(ui.pageDialog?.()).toBeNull();
    // Sound without tooltip.
    await fireEvent.click(view.getByRole('switch', { name: 'In the app' }));
    expect(tooltips.targets.get(view.getByRole('switch', { name: 'Sound for new notifications' }))?.text).toBe(
      undefined,
    );
  });

  describe('New emails', () => {
    it('shows only the notice without an account', () => {
      accounts.list = [];
      const view = render(Page);
      expect(view.getByText('Connect an email account first.')).toHaveClass('empty');
      expect(view.queryByText('Turn on push')).toBeNull();
      expect(
        view.getByText(
          'A push notification when a new email arrives in your Inbox. These switches apply only to this device.',
        ),
      ).toBeInTheDocument();
    });

    it('shows neither notice nor rows before the accounts load', () => {
      const view = render(Page);
      expect(view.queryByText('Connect an email account first.')).toBeNull();
      expect(view.container.querySelector('[data-sec="mailpush"] .box')).toBeNull();
      expect(inspect).not.toHaveBeenCalled();
    });

    it('row off and on, locked without an active channel', async () => {
      accounts.list = [ACCOUNT, { ...ACCOUNT, id: 'a2', email: 'account2@s1.test' }];
      const view = render(Page);
      const sw = mailSwitch();
      const tile = sw.parentElement?.querySelector('.tile');
      expect(tile?.querySelector('svg')).toHaveClass('tabler-icon-mail');
      expect(view.getAllByText('Off')).toHaveLength(2);
      expect(sw).toHaveAttribute('aria-disabled', 'true');
      expect(sw).toHaveClass('dim');
      expect(sw).toHaveClass('fixed');
      expect(tile).toHaveClass('dim');
      expect(view.container.querySelectorAll('[data-sec="mailpush"] .sep')).toHaveLength(2);

      pushActive();
      setStatus('on');
      await tick();
      expect(sw).toHaveAttribute('aria-checked', 'true');
      expect(sw).toHaveAttribute('aria-disabled', 'false');
      expect(sw).toHaveAttribute('aria-busy', 'false');
      expect(sw).toHaveClass('on');
      expect(sw).not.toHaveClass('dim');
      expect(sw).not.toHaveClass('fixed');
      expect(tile).toHaveClass('on');
      expect(view.getByText('On for this device')).toHaveAttribute('aria-live', 'polite');
      expect(view.getAllByText('Off')).toHaveLength(1);
      expect(view.queryByText('Turn on push')).toBeNull();
      expect(view.container.querySelectorAll('[data-sec="mailpush"] .sep')).toHaveLength(1);
    });

    it('shows toggling with aria-busy', async () => {
      accounts.list = [ACCOUNT];
      pushActive();
      setStatus('pending');
      const view = render(Page);
      const sw = mailSwitch();
      expect(view.getByText('Turning on …')).toBeInTheDocument();
      expect(sw).toHaveAttribute('aria-busy', 'true');
      expect(sw).toHaveAttribute('aria-disabled', 'true');
      expect(sw).toHaveAttribute('aria-checked', 'false');
      setStatus('stopping');
      await tick();
      expect(view.getByText('Turning off …')).toBeInTheDocument();
      await fireEvent.click(sw);
      expect(enable).not.toHaveBeenCalled();
      expect(disable).not.toHaveBeenCalled();
    });

    it('server without push and expired subscription', async () => {
      accounts.list = [ACCOUNT];
      pushActive();
      setStatus('unsupported');
      const view = render(Page);
      const sw = mailSwitch();
      expect(view.getByText('mail.s1.test doesn’t support push notifications.')).not.toHaveClass('danger');
      expect(sw).toHaveAttribute('aria-disabled', 'true');
      expect(sw).toHaveClass('fixed');
      expect(sw).not.toHaveClass('dim');

      setStatus('expired');
      await tick();
      expect(view.getByText('Expired. Turn push back on for this account.')).toHaveClass('warn');
      expect(sw).toHaveAttribute('aria-disabled', 'false');
      await fireEvent.click(sw);
      expect(enable).toHaveBeenCalledWith('a1');
    });

    it('sign-in required leads to the connection', async () => {
      accounts.list = [{ ...ACCOUNT, state: 'needs_reauth' }];
      pushActive();
      const view = render(Page);
      expect(view.getByText('Sign in to account1@s1.test again.')).toHaveClass('danger');
      expect(mailSwitch()).toHaveAttribute('aria-disabled', 'true');
      expect(inspect).not.toHaveBeenCalled();
      const go = view.getByRole('button', { name: 'Sign in again' });
      expect(go.querySelector('svg')).toHaveClass('tabler-icon-login-2');
      expect(view.queryByRole('button', { name: 'Go to connection' })).toBeNull();
      await fireEvent.click(go);
      expect(nav.goto).toHaveBeenCalledWith('/account/mail-accounts/a1/connection');
    });

    it('server locked leads to the connection', async () => {
      accounts.list = [{ ...ACCOUNT, blocked: true, state: 'needs_reauth' }];
      pushActive();
      const view = render(Page);
      expect(view.getByText('mail.s1.test is no longer an approved server.')).toHaveClass('danger');
      expect(inspect).not.toHaveBeenCalled();
      expect(view.queryByRole('button', { name: 'Sign in again' })).toBeNull();
      const go = view.getByRole('button', { name: 'Go to connection' });
      expect(go.querySelector('svg')).toHaveClass('tabler-icon-arrow-right');
      await fireEvent.click(go);
      expect(nav.goto).toHaveBeenCalledWith('/account/mail-accounts/a1/connection');
    });

    it('"Turn on push" toggles like the channel; without permission the push dialog', async () => {
      accounts.list = [ACCOUNT];
      const view = render(Page);
      expect(view.getByText('This requires the Push channel to be turned on for this device.')).toBeInTheDocument();
      const need = view.getByRole('button', { name: 'Turn on push' });
      expect(need.querySelector('svg')).toHaveClass('tabler-icon-bell-ringing');
      await fireEvent.click(need);
      expect(ui.pageDialog?.()?.title).toBe('Push notifications');
      ui.pageDialog?.()?.close();

      push.permission = 'granted';
      await tick();
      await fireEvent.click(need);
      expect(request).toHaveBeenCalledOnce();
    });

    it('names the quiet hours only with active push', async () => {
      prefs.set({ nQuiet: true });
      const view = render(Page);
      const NOTE = 'During quiet hours, new emails arrive without sound.';
      expect(view.queryByText(NOTE)).toBeNull();
      pushActive();
      await tick();
      const note = view.getByText(NOTE).closest('.note');
      expect(note).toHaveClass('under');
      expect(note?.querySelector('svg')).toHaveClass('tabler-icon-info-circle');
      prefs.set({ nTo: '22:00' });
      await tick();
      expect(view.queryByText(NOTE)).toBeNull();
    });

    it('turns on and off; success without toast', async () => {
      accounts.list = [ACCOUNT];
      pushActive();
      render(Page);
      const sw = mailSwitch();
      await fireEvent.click(sw);
      expect(enable).toHaveBeenCalledWith('a1');
      setStatus('on');
      await tick();
      await fireEvent.click(sw);
      expect(disable).toHaveBeenCalledWith('a1');
      await tick();
      expect(ui.toast).toBeNull();
    });

    it('reports errors while toggling as a toast', async () => {
      accounts.list = [ACCOUNT];
      pushActive();
      enable.mockResolvedValue('failed');
      render(Page);
      const sw = mailSwitch();
      await fireEvent.click(sw);
      await vi.waitFor(() => expect(ui.toast?.text).toBe('Push wasn’t turned on. Please try again.'));
      setStatus('on');
      await tick();
      disable.mockRejectedValue(new Error('kaputt'));
      await fireEvent.click(sw);
      await vi.waitFor(() => expect(ui.toast?.text).toBe('Push wasn’t turned off. Please try again.'));
    });

    it('does not toggle without a connection', async () => {
      accounts.list = [ACCOUNT];
      pushActive();
      network.simulated = true;
      render(Page);
      await fireEvent.click(mailSwitch());
      expect(enable).not.toHaveBeenCalled();
      expect(ui.toast?.text).toBe('No connection. Please try again.');
    });

    it('asks on opening and with the account list whether the mail servers support push', async () => {
      const view = render(Page);
      expect(inspect).not.toHaveBeenCalled();
      accounts.list = [
        ACCOUNT,
        { ...ACCOUNT, id: 'a2', state: 'needs_reauth' },
        { ...ACCOUNT, id: 'a3', blocked: true },
      ];
      await tick();
      expect(inspect).toHaveBeenCalledExactlyOnceWith(['a1']);
      view.unmount();
    });

    it('restores the selection with active push, also on opening', async () => {
      pushActive();
      const view = render(Page);
      await tick();
      expect(restore).toHaveBeenCalledOnce();
      view.unmount();

      restore.mockClear();
      prefs.set({ nCh: { ...prefs.values.nCh, push: false } });
      render(Page);
      await tick();
      expect(restore).not.toHaveBeenCalled();
      prefs.set({ nCh: { ...prefs.values.nCh, push: true } });
      await tick();
      expect(restore).toHaveBeenCalledOnce();
    });

    it('restores the selection only once this browser is registered', async () => {
      pushActive();
      const current = push.current;
      push.current = null;
      render(Page);
      await tick();
      expect(push.status).toBe('active');
      expect(restore).not.toHaveBeenCalled();
      push.current = current;
      await tick();
      expect(restore).toHaveBeenCalledOnce();
    });

    it('unsubscribes the mail accounts when the push channel turns off', async () => {
      pushActive();
      const view = render(Page);
      await fireEvent.click(view.getByRole('switch', { name: 'In the app' }));
      expect(pause).not.toHaveBeenCalled();
      await fireEvent.click(view.getByRole('switch', { name: 'Push notifications' }));
      expect(prefs.values.nCh.push).toBe(false);
      expect(pause).toHaveBeenCalledOnce();
    });

    it('shows the same rows on mobile', () => {
      mobile();
      accounts.list = [{ ...ACCOUNT, state: 'needs_reauth' }];
      const view = render(Page);
      expect(view.getByText('account1@s1.test')).toBeInTheDocument();
      expect(view.getByRole('button', { name: 'Sign in again' })).toBeInTheDocument();
      expect(view.getByRole('button', { name: 'Turn on push' })).toBeInTheDocument();
    });
  });

  it('cleans up dialog and popover on leaving', async () => {
    prefs.set({ nQuiet: true });
    const view = render(Page);
    await fireEvent.focus(field('Quiet hours start'));
    expect(ui.menu).toBe('time');
    view.unmount();
    expect(ui.menu).toBeNull();
    expect(ui.pageDialog).toBeNull();
  });
});
