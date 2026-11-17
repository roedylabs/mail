import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tooltips } from '#lib/actions/tooltip.ts';
import { buildInfo } from '#lib/build-info.ts';
import { m } from '#lib/paraglide/messages.js';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session, type Me } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { UP_IMAGE, UP_REPO, type UpdatesView } from '#lib/updates.svelte.ts';
import Page from './+page.svelte';

const sections = vi.hoisted(() => ({ scrollToSection: vi.fn() }));
vi.mock('#lib/sections.ts', () => sections);

const ME: Me = {
  id: 'u0',
  username: 'jane',
  email: 'jane@example.com',
  display_name: 'Jane Doe',
  role: 'admin',
  mfa_enabled: false,
  sole_admin: false,
  password_changed_at: '2026-10-20T10:00:00Z',
  email_change: null,
  system_mail_configured: true,
};

const REPO = UP_REPO;
const IMAGE = UP_IMAGE;
/** Package page of the image in the repository's container registry. */
const PACKAGE_URL = `https://${REPO}/pkgs/container/${IMAGE.split('/').pop()}`;
const DAY = 24 * 3600_000;

/** State from `GET admin/updates`: up to date, checked two hours ago, token for nine days. */
function status(patch: Partial<UpdatesView> = {}): UpdatesView {
  return {
    version: '0.1.0',
    latest: '0.1.0',
    available: false,
    status: 'ok',
    reason: null,
    checked_at: new Date(Date.now() - 2 * 3600_000 - 60_000).toISOString(),
    next_at: new Date(Date.now() + DAY).toISOString(),
    auto: true,
    every: 'daily',
    time: '03:00',
    weekday: 'monday',
    show: true,
    pat: { prefix: 'ghp_', tail: 'a1F3', saved_at: new Date(Date.now() - 9 * DAY - 60_000).toISOString() },
    update: null,
    ...patch,
  };
}

/** No token stored: checks run anonymously. */
const NO_PAT = { pat: null } satisfies Partial<UpdatesView>;

beforeEach(() => {
  session.user = ME;
  // jsdom does not know `scrollTo` on elements (columns of the time picker).
  HTMLElement.prototype.scrollTo = vi.fn();
});

afterEach(() => {
  // Clean up first: `dispose` sends pending changes, `fetch` must still be in place for that.
  cleanup();
  vi.unstubAllGlobals();
  sections.scrollToSection.mockClear();
  ui.reset();
  prefs.reset();
  session.user = null;
  window.dispatchEvent(new Event('resize'));
});

function renderPage(view: UpdatesView = status(), routes: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({ 'GET admin/updates': [{ body: view }], ...routes });
  return { ...render(Page), ...api };
}

/** Page with tabs: the state is loaded. */
async function loaded(view: UpdatesView = status(), routes: Parameters<typeof mockApi>[0] = {}) {
  const page = renderPage(view, routes);
  await page.findByRole('heading', { level: 2, name: 'Status' });
  return page;
}

function mobile(): void {
  vi.stubGlobal('innerWidth', 390);
  window.dispatchEvent(new Event('resize'));
}

const section = (name: string) => screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement;
const card = () => section('Status').querySelector('.status') as HTMLElement;
const value = (label: string) => screen.getByText(label).nextElementSibling;
const token = () => screen.getByLabelText<HTMLInputElement>('Access token');
const save = () => screen.getByRole('button', { name: 'Verify and save' });
const puts = (calls: { method: string; body: unknown }[]) => calls.filter((c) => c.method === 'PUT').map((c) => c.body);

describe('Administration › Updates page', () => {
  it('shows the header until the first response and the skeleton after a short time', async () => {
    mockApi({ 'GET admin/updates': [() => new Promise(() => {})] });
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Updates');
    expect(view.getByText('Installed version and automatic update check.')).toBeInTheDocument();
    expect(view.queryByText('Loading data …')).toBeNull();
    expect(await view.findByText('Loading data …')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Status' })).toBeNull();
    expect(view.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('shows "Up to date" with tabs, source, schedule and display', async () => {
    const view = await loaded();
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Status',
      'Source',
      'Schedule',
      'Display',
    ]);

    expect(card()).not.toHaveClass('bad');
    expect(within(card()).getByText('Up to date')).toBeInTheDocument();
    expect(within(card()).getByText('Version 0.1.0 is the latest version.')).toBeInTheDocument();
    expect(card().querySelector('.st-tile svg')).toHaveClass('tabler-icon-circle-check');
    const check = view.getByRole('button', { name: 'Check now' });
    expect(check).toHaveAttribute('aria-disabled', 'false');
    expect(value('Installed version')).toHaveTextContent(`0.1.0 · Build ${buildInfo.sha}`);
    expect(value('Latest version')).toHaveTextContent('0.1.0');
    expect(value('Last checked')).toHaveTextContent('2 hours ago');
    expect(view.queryByText('The last check failed.', { exact: false })).toBeNull();

    const source = within(section('Source'));
    expect(source.getByText(m.updates_source_desc())).toBeInTheDocument();
    const repo = source.getByRole('link', { name: REPO });
    expect(repo).toHaveAttribute('href', `https://${REPO}`);
    expect(repo).toHaveAttribute('target', '_blank');
    expect(repo).toHaveAttribute('rel', 'noopener noreferrer');
    expect(repo.querySelector('svg')).toHaveClass('tabler-icon-external-link');
    expect(source.getByRole('link', { name: `${IMAGE}:0.1.0` })).toHaveAttribute('href', PACKAGE_URL);

    const schedule = within(section('Schedule'));
    expect(schedule.getByText('Regular checks for new versions.')).toBeInTheDocument();
    expect(schedule.getByRole('switch', { name: 'Check automatically' })).toHaveAttribute('aria-checked', 'true');
    expect(schedule.getByText('Look for new versions in the background')).toBeInTheDocument();
    expect(schedule.getByText('Interval between checks')).toBeInTheDocument();
    expect(
      within(schedule.getByRole('group', { name: 'Frequency' }))
        .getAllByRole('button')
        .map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['Hourly', 'false'],
      ['Daily', 'true'],
      ['Weekly', 'false'],
    ]);
    expect(schedule.getByRole('textbox', { name: 'Time' })).toHaveValue('03:00');
    // The English clock has no unit after the field.
    expect(schedule.queryByText(m.time_uhr({}, { locale: 'de' }))).toBeNull();
    expect(schedule.getByText('Ideally at night, when things are quiet')).toBeInTheDocument();
    expect(value('Next check')?.textContent).toMatch(/^tomorrow, \d\d:\d\d$/);

    const display = within(section('Display'));
    expect(display.getByText('What users see under Settings › About.')).toBeInTheDocument();
    expect(display.getByRole('switch', { name: 'Show update status' })).toHaveAttribute('aria-checked', 'true');
    expect(display.getByText('Shows whether the app is up to date')).toBeInTheDocument();
  });

  it('shows the optional token field without a token and keeps "Check now" enabled', async () => {
    const view = await loaded(status(NO_PAT));
    expect(within(card()).getByText('Up to date')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Check now' })).toHaveAttribute('aria-disabled', 'false');
    expect(view.getByText(m.updates_pat_hint())).toBeInTheDocument();
    expect(token()).toHaveAttribute('type', 'password');
    expect(token()).toHaveAttribute('placeholder', 'ghp_… or github_pat_…');
    expect(token()).toHaveAttribute('autocomplete', 'off');
    expect(view.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Replace' })).toBeNull();
    expect(save()).toHaveAttribute('aria-disabled', 'true');
    expect(save()).not.toHaveClass('on');
  });

  it('shows "Update available" without a notice below the card', async () => {
    const view = await loaded(status({ latest: '0.2.0', available: true }));
    expect(within(card()).getByText('Update available')).toBeInTheDocument();
    expect(
      within(card()).getByText('Version 0.2.0 is out. Pull the new image and restart the container.'),
    ).toBeInTheDocument();
    expect(card()).not.toHaveClass('bad');
    expect(card().querySelector('.st-tile svg')).toHaveClass('tabler-icon-cloud-download');
    expect(value('Latest version')).toHaveTextContent('0.2.0');
    expect(view.container.querySelector('.warn')).toBeNull();
  });

  it.each([
    ['token', 'key-off', m.updates_err_token()],
    ['no_access', 'lock', m.updates_err_no_access({ repo: REPO })],
    ['rate_limited', 'hourglass', 'GitHub is rate-limiting requests right now. Try again later.'],
    ['unreachable', 'cloud-off', 'GitHub can’t be reached right now. Try again later.'],
  ] as const)('shows "Check failed" for %s with icon and reason', async (reason, icon, text) => {
    await loaded(status({ status: 'err', reason }));
    expect(within(card()).getByText('Check failed')).toBeInTheDocument();
    expect(within(card()).getByText(text)).toBeInTheDocument();
    expect(card()).toHaveClass('bad');
    expect(card().querySelector('.st-tile svg')).toHaveClass(`tabler-icon-${icon}`);
  });

  it('names the reason of the failed check next to a found version', async () => {
    const view = await loaded(status({ latest: '0.2.0', available: true, status: 'err', reason: 'unreachable' }));
    expect(within(card()).getByText('Update available')).toBeInTheDocument();
    expect(card()).not.toHaveClass('bad');
    const warn = view.container.querySelector('.warn') as HTMLElement;
    expect(warn).toHaveTextContent('The last check failed. GitHub can’t be reached right now. Try again later.');
    expect(warn.previousElementSibling).toBe(card());
    expect(warn.querySelector('svg')).toHaveClass('tabler-icon-alert-circle');
  });

  it('shows "No version released yet" without a release', async () => {
    await loaded(status({ latest: null }));
    expect(within(card()).getByText('No version released yet')).toBeInTheDocument();
    expect(within(card()).getByText('The repository has no releases yet.')).toBeInTheDocument();
    expect(card().querySelector('.st-tile svg')).toHaveClass('tabler-icon-package-off');
    expect(value('Latest version')).toHaveTextContent('Not known yet');
  });

  it('spins the icon while checking, locks the button and shows the toast', async () => {
    let finish: (reply: { body: UpdatesView }) => void = () => {};
    const view = await loaded(status(), {
      'POST admin/updates/check': [() => new Promise((resolve) => (finish = resolve))],
    });
    await fireEvent.click(view.getByRole('button', { name: 'Check now' }));
    const busy = view.getByRole('button', { name: 'Checking' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toHaveClass('busy');
    expect(busy.querySelector('.check-icon')).toHaveStyle('--rot: 720deg');
    expect(within(card()).getByText('Checking …')).toBeInTheDocument();
    expect(within(card()).getByText('Looking for new versions')).toBeInTheDocument();
    await fireEvent.click(busy);
    expect(view.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    finish({ body: status() });
    expect(await view.findByRole('button', { name: 'Check now' })).toHaveAttribute('aria-busy', 'false');
    expect(ui.toast?.text).toBe('No new updates');
  });

  it('shows the card instead of the sections when loading fails, and reloads', async () => {
    const view = renderPage(status(), {
      'GET admin/updates': [{ status: 500, body: { error: 'internal' } }, { body: status() }],
    });
    const alert = await view.findByRole('alert');
    expect(within(alert).getByText('Couldn’t load updates')).toBeInTheDocument();
    expect(within(alert).getByText(m.error_act())).toBeInTheDocument();
    expect(alert.querySelector('.tile svg')).toHaveClass('tabler-icon-cloud-off');
    expect(view.queryByRole('heading', { level: 2 })).toBeNull();
    expect(view.queryByRole('button', { name: 'Status' })).toBeNull();
    await fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(view.queryByRole('alert')).toBeNull();
    expect(await view.findByRole('heading', { level: 2, name: 'Status' })).toBeInTheDocument();
    expect(view.getAllByRole('button', { name: 'Status' })).toHaveLength(1);
  });

  it('shows the saved token masked with its age and asks before removing', async () => {
    const view = await loaded();
    const source = within(section('Source'));
    expect(source.getByText('ghp_••••••••••••a1F3')).toBeInTheDocument();
    expect(source.getByText('Saved 9 days ago')).toBeInTheDocument();
    expect(view.queryByLabelText('Access token')).toBeNull();
    const remove = source.getByRole('button', { name: 'Remove access token' });
    expect(tooltips.targets.get(remove)?.text).toBe('Remove');
    expect(ui.confirm).toBeNull();
    await fireEvent.click(remove);
    expect(ui.confirm?.title).toBe('Remove access token?');
    expect(view.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('replaces the token with cancel and eye', async () => {
    const view = await loaded();
    await fireEvent.click(view.getByRole('button', { name: 'Replace' }));
    expect(view.queryByText('ghp_••••••••••••a1F3')).toBeNull();
    expect(token()).toHaveValue('');
    await fireEvent.input(token(), { target: { value: 'ghp_new' } });
    expect(save()).toHaveAttribute('aria-disabled', 'false');
    expect(save()).toHaveClass('on');

    const eye = view.getByRole('button', { name: 'Show' });
    expect(tooltips.targets.get(eye)?.text).toBe('Show');
    expect(eye.querySelector('svg')).toHaveClass('tabler-icon-eye');
    await fireEvent.click(eye);
    expect(token()).toHaveAttribute('type', 'text');
    expect(view.getByRole('button', { name: 'Hide' }).querySelector('svg')).toHaveClass('tabler-icon-eye-off');

    await fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByLabelText('Access token')).toBeNull();
    expect(view.getByText('ghp_••••••••••••a1F3')).toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Replace' }));
    expect(token()).toHaveValue('');
    expect(token()).toHaveAttribute('type', 'password');
  });

  it('saves with Enter and shows the spinner during the check', async () => {
    let finish: (reply: { body: UpdatesView }) => void = () => {};
    const view = await loaded(status(NO_PAT), {
      'PUT admin/updates': [() => new Promise((resolve) => (finish = resolve))],
    });
    await fireEvent.input(token(), { target: { value: ' ghp_new ' } });
    await fireEvent.keyDown(token(), { key: 'Enter' });
    expect(puts(view.calls)).toEqual([{ pat: 'ghp_new' }]);
    const busy = view.getByRole('button', { name: 'Verifying …' });
    expect(busy).toHaveClass('on', 'busy');
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy.querySelector('svg')).toHaveClass('tabler-icon-loader-2');
    finish({ body: status() });
    expect(await view.findByText('ghp_••••••••••••a1F3')).toBeInTheDocument();
    expect(view.queryByLabelText('Access token')).toBeNull();
    expect(ui.toast?.text).toBe('Access token saved');
  });

  it('shows "invalid" at the field with a red border and clears the error on input', async () => {
    const view = await loaded(status(NO_PAT), {
      'PUT admin/updates': [{ status: 422, body: { error: 'invalid', fields: { pat: { code: 'invalid' } } } }],
    });
    await fireEvent.input(token(), { target: { value: 'ghp_wrong' } });
    await fireEvent.click(save());
    const alert = await view.findByRole('alert');
    expect(alert).toHaveTextContent(`Invalid token or no access to ${REPO}.`);
    expect(alert.querySelector('svg')).toHaveClass('tabler-icon-alert-circle');
    expect(token()).toHaveClass('bad');
    expect(token()).toHaveValue('ghp_wrong');
    await fireEvent.input(token(), { target: { value: 'ghp_falsc' } });
    expect(view.queryByRole('alert')).toBeNull();
    expect(token()).not.toHaveClass('bad');
  });

  it('shows "unavailable" at the field without a red border', async () => {
    const view = await loaded(status(NO_PAT), {
      'PUT admin/updates': [{ status: 422, body: { error: 'invalid', fields: { pat: { code: 'unavailable' } } } }],
    });
    await fireEvent.input(token(), { target: { value: 'ghp_new' } });
    await fireEvent.click(save());
    expect(await view.findByRole('alert')).toHaveTextContent(
      'GitHub isn’t responding right now. The token wasn’t saved. Try again later.',
    );
    expect(token()).not.toHaveClass('bad');
  });

  it('copies repository and image with a toast', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const view = await loaded();
    const repo = view.getByRole('button', { name: 'Copy Repository' });
    expect(tooltips.targets.get(repo)?.text).toBe('Copy');
    await fireEvent.click(repo);
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Repository URL copied'));
    expect(writeText).toHaveBeenLastCalledWith(`https://${REPO}`);
    await fireEvent.click(view.getByRole('button', { name: 'Copy Docker image' }));
    await vi.waitFor(() => expect(ui.toast?.text).toBe('Image copied'));
    expect(writeText).toHaveBeenLastCalledWith(`${IMAGE}:0.1.0`);
    Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('shows time and weekday depending on the frequency and sends the change', async () => {
    const view = await loaded(status(), { 'PUT admin/updates': [{ body: status({ every: 'daily' }) }] });
    const schedule = within(section('Schedule'));
    expect(schedule.queryByRole('group', { name: 'Day of the week' })).toBeNull();

    await fireEvent.click(schedule.getByRole('button', { name: 'Weekly' }));
    const days = schedule.getByRole('group', { name: 'Day of the week' });
    expect(schedule.getByText('Checks run on this day')).toBeInTheDocument();
    expect(
      within(days)
        .getAllByRole('button')
        .map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['Mon', 'true'],
      ['Tue', 'false'],
      ['Wed', 'false'],
      ['Thu', 'false'],
      ['Fri', 'false'],
      ['Sat', 'false'],
      ['Sun', 'false'],
    ]);
    await fireEvent.click(within(days).getByRole('button', { name: 'Fri' }));
    expect(within(days).getByRole('button', { name: 'Fri' })).toHaveClass('on');
    expect(schedule.getByRole('textbox', { name: 'Time' })).toBeInTheDocument();

    await fireEvent.click(schedule.getByRole('button', { name: 'Hourly' }));
    expect(schedule.queryByRole('group', { name: 'Day of the week' })).toBeNull();
    expect(schedule.queryByRole('textbox', { name: 'Time' })).toBeNull();
    expect(schedule.getByRole('button', { name: 'Hourly' })).toHaveAttribute('aria-pressed', 'true');

    await fireEvent.click(schedule.getByRole('button', { name: 'Daily' }));
    expect(schedule.queryByRole('group', { name: 'Day of the week' })).toBeNull();
    expect(schedule.getByRole('textbox', { name: 'Time' })).toBeInTheDocument();
    await vi.waitFor(() => expect(puts(view.calls)).toEqual([{ every: 'daily', weekday: 'friday' }]));
  });

  it('dims and locks the selection when "Check automatically" is off', async () => {
    const view = await loaded(status({ auto: false, every: 'weekly', next_at: null }), {
      'PUT admin/updates': [{ body: status({ every: 'weekly', next_at: null }) }],
    });
    const schedule = within(section('Schedule'));
    expect(schedule.getByRole('switch', { name: 'Check automatically' })).toHaveAttribute('aria-checked', 'false');
    const rows = () => [...section('Schedule').querySelectorAll('.row:not(.toggle)')];
    expect(rows()).toHaveLength(3);
    expect(rows().every((r) => r.classList.contains('dim'))).toBe(true);
    expect(schedule.getByRole('button', { name: 'Daily' })).toBeDisabled();
    expect(schedule.getByRole('button', { name: 'Mon' })).toBeDisabled();
    expect(schedule.getByRole('textbox', { name: 'Time' })).toBeDisabled();
    expect(schedule.getByRole('button', { name: 'Choose Time' })).toBeDisabled();
    expect(value('Next check')).toHaveTextContent('Disabled');

    await fireEvent.click(schedule.getByRole('switch', { name: 'Check automatically' }));
    expect(schedule.getByRole('switch', { name: 'Check automatically' })).toHaveAttribute('aria-checked', 'true');
    expect(rows().some((r) => r.classList.contains('dim'))).toBe(false);
    expect(schedule.getByRole('button', { name: 'Daily' })).toBeEnabled();
    await vi.waitFor(() => expect(puts(view.calls)).toEqual([{ auto: true }]));
  });

  it('toggles "Show update status"', async () => {
    const view = await loaded(status(), { 'PUT admin/updates': [{ body: status({ show: false }) }] });
    const show = view.getByRole('switch', { name: 'Show update status' });
    expect(show).toHaveClass('on');
    await fireEvent.click(show);
    expect(show).toHaveAttribute('aria-checked', 'false');
    expect(show).not.toHaveClass('on');
    await vi.waitFor(() => expect(puts(view.calls)).toEqual([{ show: false }]));
  });

  it('time field on desktop: focus opens the popover, select hour and minute', async () => {
    const view = await loaded(status(), { 'PUT admin/updates': [{ body: status({ time: '04:30' }) }] });
    const field = view.getByRole('textbox', { name: 'Time' });
    const clock = view.getByRole('button', { name: 'Choose Time' });
    expect(clock).toHaveAttribute('aria-haspopup', 'dialog');
    expect(clock).toHaveAttribute('aria-expanded', 'false');
    await fireEvent.focus(field);
    await tick();
    expect(ui.menu).toBe('time');
    expect(clock).toHaveAttribute('aria-expanded', 'true');
    expect(field.parentElement).toHaveClass('open');
    const pop = view.getByRole('dialog', { name: 'Choose time' });
    expect(pop.closest('[data-pop]')).not.toBeNull();
    const hours = within(pop).getByRole('listbox', { name: 'Hour' });
    expect(within(hours).getByRole('option', { selected: true })).toHaveTextContent('03');
    await fireEvent.click(within(hours).getByRole('option', { name: '04' }));
    expect(field).toHaveValue('04:00');
    expect(view.getByRole('dialog', { name: 'Choose time' })).toBeInTheDocument();
    await fireEvent.click(within(pop).getByRole('option', { name: '30' }));
    await tick();
    expect(field).toHaveValue('04:30');
    expect(ui.menu).toBeNull();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(field.parentElement).not.toHaveClass('open');
    await vi.waitFor(() => expect(puts(view.calls)).toEqual([{ time: '04:30' }]));
  });

  it('time field on desktop: clock opens and closes, the layout closes from outside', async () => {
    const view = await loaded();
    const clock = view.getByRole('button', { name: 'Choose Time' });
    await fireEvent.click(clock);
    expect(view.getByRole('dialog', { name: 'Choose time' })).toBeInTheDocument();
    await tick();
    expect(ui.menu).toBe('time');
    await fireEvent.click(clock);
    await tick();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(ui.menu).toBeNull();

    await fireEvent.click(clock);
    await tick();
    // Click outside or Escape: the layout closes the menu.
    ui.closeMenu();
    await tick();
    expect(view.queryByRole('dialog')).toBeNull();
    // Afterwards the clock opens again.
    await fireEvent.click(clock);
    await tick();
    expect(view.getByRole('dialog', { name: 'Choose time' })).toBeInTheDocument();
    expect(ui.menu).toBe('time');
  });

  it('time field: input, arrow keys and Enter', async () => {
    const view = await loaded(status(), { 'PUT admin/updates': [{ body: status({ time: '04:20' }) }] });
    const field = view.getByRole('textbox', { name: 'Time' });
    expect(field).toHaveAttribute('maxlength', '5');
    expect(field).toHaveAttribute('placeholder', 'hh:mm');
    await fireEvent.focus(field);
    await fireEvent.input(field, { target: { value: '04:15x' } });
    expect(field).toHaveValue('04:15');
    await fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(field).toHaveValue('04:20');
    await fireEvent.keyDown(field, { key: 'Enter' });
    await tick();
    expect(ui.menu).toBeNull();
    expect(view.queryByRole('dialog')).toBeNull();
    await vi.waitFor(() => expect(puts(view.calls)).toEqual([{ time: '04:20' }]));
  });

  it('time field stays 24-hour with an en-US browser and the 12-hour time format', async () => {
    vi.stubGlobal('navigator', { ...navigator, languages: ['en-US'], language: 'en-US' });
    prefs.set({ timeFmt: '12h' });
    const view = await loaded();
    const field = view.getByRole('textbox', { name: 'Time' });
    expect(field).toHaveValue('03:00');
    expect(field).toHaveAttribute('maxlength', '5');
    expect(field).toHaveAttribute('placeholder', 'hh:mm');
    await fireEvent.click(view.getByRole('button', { name: 'Choose Time' }));
    await tick();
    const hours = within(view.getByRole('dialog', { name: 'Choose time' })).getByRole('listbox', { name: 'Hour' });
    const labels = within(hours)
      .getAllByRole('option')
      .map((o) => o.textContent?.trim());
    expect(labels).toEqual(Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')));
    expect(within(hours).queryByText(/AM|PM/)).toBeNull();
    // Only the next check follows the time format.
    expect(value('Next check')?.textContent).toMatch(/^tomorrow, \d{1,2}:\d\d [AP]M$/);
  });

  it('shows the clock unit of the German interface next to the time, also with the 12-hour time format', async () => {
    const german = { locale: 'de' } as const;
    prefs.set({ lang: 'de', timeFmt: '12h' });
    await loaded();
    const schedule = within(section(m.updates_tab_schedule({}, german)));
    expect(schedule.getByRole('textbox', { name: m.updates_time_title({}, german) })).toHaveValue('03:00');
    expect(schedule.getByText(m.time_uhr({}, german))).toBeInTheDocument();
  });

  it('cleans up dialog and popover on leaving', async () => {
    const view = await loaded();
    await fireEvent.focus(view.getByRole('textbox', { name: 'Time' }));
    await tick();
    expect(ui.menu).toBe('time');
    expect(ui.pageDialog).not.toBeNull();
    view.unmount();
    expect(ui.menu).toBeNull();
    expect(ui.pageDialog).toBeNull();
  });

  it('scrolls to the section via the tabs', async () => {
    const view = await loaded();
    expect(view.getByRole('button', { name: 'Status' })).toHaveClass('tab');
    await fireEvent.click(view.getByRole('button', { name: 'Schedule' }));
    expect(sections.scrollToSection).toHaveBeenCalledTimes(1);
    const [root, key, animate] = sections.scrollToSection.mock.calls[0] as [HTMLElement, string, boolean];
    expect(key).toBe('schedule');
    expect(animate).toBe(true);
    expect([...root.querySelectorAll('section')].map((s) => s.dataset.sec)).toEqual([
      'status',
      'source',
      'schedule',
      'display',
    ]);
  });

  it('shows header, buttons without tooltip and the token with pencil on mobile', async () => {
    mobile();
    const view = await loaded(status(), {
      'PUT admin/updates': [{ status: 422, body: { error: 'invalid', fields: { pat: { code: 'invalid' } } } }],
    });
    expect(ui.isMobile).toBe(true);
    expect(view.container.querySelector('.page')).toHaveClass('mobile');
    expect(view.getByRole('heading', { level: 1 })).toHaveClass('m-title');
    expect(view.getByText('Installed version and automatic update check.')).toHaveClass('m-lead');
    expect(view.getByRole('link', { name: REPO }).querySelector('svg')).toBeNull();
    expect(tooltips.targets.get(view.getByRole('button', { name: 'Copy Repository' }))?.text).toBeUndefined();

    expect(view.queryByRole('button', { name: 'Replace' })).toBeNull();
    const replace = view.getByRole('button', { name: 'Replace access token' });
    expect(replace.querySelector('svg')).toHaveClass('tabler-icon-pencil');
    expect(tooltips.targets.get(view.getByRole('button', { name: 'Remove access token' }))?.text).toBeUndefined();
    expect(view.getByText('ghp_••••••••••••a1F3')).toBeInTheDocument();

    await fireEvent.click(replace);
    expect(tooltips.targets.get(view.getByRole('button', { name: 'Show' }))?.text).toBeUndefined();
    // On mobile the buttons sit below the field, the error in between.
    expect(save().parentElement).toHaveClass('pat-buttons');
    expect(view.getByRole('button', { name: 'Cancel' }).parentElement).toHaveClass('pat-buttons');
    await fireEvent.input(token(), { target: { value: 'ghp_wrong' } });
    await fireEvent.click(save());
    expect((await view.findByRole('alert')).nextElementSibling).toHaveClass('pat-buttons');
  });

  it('time picker on mobile in the sheet: focus opens nothing, the clock opens the sheet', async () => {
    mobile();
    const view = await loaded();
    expect(ui.pageDialog?.()).toBeNull();
    await fireEvent.focus(view.getByRole('textbox', { name: 'Time' }));
    await tick();
    expect(ui.menu).toBeNull();
    expect(ui.pageDialog?.()).toBeNull();
    const clock = view.getByRole('button', { name: 'Choose Time' });
    expect(clock).not.toHaveAttribute('aria-expanded');
    await fireEvent.click(clock);
    await tick();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(ui.menu).toBeNull();
    expect(ui.pageDialog?.()?.title).toBe('Time');
    ui.pageDialog?.()?.close();
    expect(ui.pageDialog?.()).toBeNull();
  });
});
