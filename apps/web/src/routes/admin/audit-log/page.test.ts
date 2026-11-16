import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditCounts, AuditEntry } from '#lib/audit.svelte.ts';
import { mockApi, type Call } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import Page from './+page.svelte';

/** Thursday, 12:00; times below are one hour later in Europe/Berlin. */
const NOW = Date.parse('2026-11-05T11:00:00Z');

const entry = (id: number, at: string, patch: Partial<AuditEntry>): AuditEntry => ({
  id,
  at,
  cat: 'login',
  icon: 'ti-login',
  who: 'Doe, Jane',
  act: ' signed in',
  meta: 'London, United Kingdom',
  warn: false,
  ...patch,
});

const ENTRIES = [
  entry(4, '2026-11-05T08:26:00Z', {}),
  entry(3, '2026-11-05T07:00:00Z', {
    cat: 'users',
    icon: 'ti-user-off',
    who: 'Brown, Alice',
    act: ' suspended Luke Clark',
    meta: '',
    warn: true,
  }),
  entry(2, '2026-11-04T15:10:00Z', {
    cat: 'settings',
    icon: 'ti-settings',
    who: 'Walker, Lily',
    act: ' changed the branding',
    meta: 'Manchester, United Kingdom',
  }),
  entry(1, '2026-11-02T09:00:00Z', {
    cat: 'system',
    icon: 'ti-history',
    who: 'Clark, Luke',
    act: ' did something',
  }),
];
const COUNTS: AuditCounts = { all: 4, login: 1, users: 1, settings: 1, system: 1 };
const DATA = { entries: ENTRIES, counts: COUNTS, next: null };
const NONE = { entries: [], counts: { all: 0, login: 0, users: 0, settings: 0, system: 0 }, next: null };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  prefs.set({ tzAuto: false, tz: 'Europe/Berlin', timeFmt: '24h' });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  ui.reset();
  prefs.reset();
  window.dispatchEvent(new Event('resize'));
});

function renderPage(routes: Parameters<typeof mockApi>[0] = {}) {
  const api = mockApi({
    'GET admin/audit': [{ body: DATA }],
    'GET admin/audit/retention': [{ body: { days: 90 } }],
    ...routes,
  });
  return { ...render(Page), ...api };
}

/** A response that only arrives on `release()`. */
function held(body: unknown) {
  let release = () => {};
  const reply = new Promise<{ body: unknown }>((resolve) => {
    release = () => resolve({ body });
  });
  return { reply: () => reply, release: () => release() };
}

const filter = (label: string) => screen.getByRole('button', { name: new RegExp(`^${label}`) });
const keepGroup = () => screen.getByRole('group', { name: 'Keep entries' });
const keep = (label: string) => within(keepGroup()).getByRole('button', { name: label });
const row = (who: string) => screen.getByText(who).closest('.entry') as HTMLElement;
const listCalls = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && !c.path.endsWith('retention'));

describe('Audit log page', () => {
  it('shows heading, search, filters with counts and the entries by day', async () => {
    const view = renderPage();
    await view.findByText('Doe, Jane');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Audit log');
    expect(view.getByText('Track changes and sign-ins.')).toBeInTheDocument();
    const search = view.getByRole('textbox', { name: 'Search audit log' });
    expect(search).toHaveAttribute('placeholder', 'Person, action, or location');
    const exportButton = view.getByRole('button', { name: 'Export as CSV' });
    expect(exportButton).toHaveTextContent('Export as CSV');
    expect(exportButton).not.toHaveAttribute('aria-label');

    const pills = within(view.getAllByRole('group').at(0) as HTMLElement).getAllByRole('button');
    expect(pills.map((b) => b.textContent.trim())).toEqual(['All4', 'Sign-in1', 'Users1', 'Settings1', 'System1']);
    expect(filter('All')).toHaveAttribute('aria-pressed', 'true');
    expect(filter('Sign-in')).toHaveAttribute('aria-pressed', 'false');

    // Days as h2 directly below the h1, then "Retention".
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Today',
      'Yesterday',
      'Monday 2 November',
      'Retention',
    ]);
    expect(view.queryByRole('heading', { level: 3 })).toBeNull();
    expect(row('Doe, Jane')).toHaveTextContent('Doe, Jane signed in');
    expect(within(row('Doe, Jane')).getByText('09:26 · London, United Kingdom')).toBeInTheDocument();
    expect(within(row('Doe, Jane')).getByText('Sign-in')).toBeInTheDocument();
    // Without a place only the time; the warning's tile is red.
    expect(within(row('Brown, Alice')).getByText('08:00')).toBeInTheDocument();
    expect(within(row('Brown, Alice')).getByText('Users')).toBeInTheDocument();
    expect(row('Brown, Alice').querySelector('.tile')).toHaveClass('warn');
    expect(row('Doe, Jane').querySelector('.tile')).not.toHaveClass('warn');
    // Divider only between two entries of a day.
    expect(view.container.querySelectorAll('.sep')).toHaveLength(1);
    expect(view.queryByText('No entries found')).toBeNull();
    expect(view.queryByRole('button', { name: 'Load more entries' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('keeps counts, days and period empty before the first response', async () => {
    const list = held(DATA);
    const days = held({ days: 90 });
    const view = renderPage({ 'GET admin/audit': [list.reply], 'GET admin/audit/retention': [days.reply] });
    expect(filter('All').textContent.trim()).toBe('All');
    const frame = view.getByRole('status', { name: 'Loading audit log' });
    expect(frame).toHaveAttribute('aria-busy', 'true');
    expect(frame).toHaveClass('empty', 'first');
    expect(view.queryByText('No entries found')).toBeNull();
    // Retention without selection, locked, without a row below.
    expect(keepGroup().closest('.box')).toHaveAttribute('aria-busy', 'true');
    for (const label of ['30 days', '90 days', '1 year']) {
      expect(keep(label)).toHaveAttribute('aria-disabled', 'true');
      expect(keep(label)).toHaveAttribute('aria-pressed', 'false');
    }
    await fireEvent.click(keep('1 year'));
    expect(view.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    expect(view.queryByText(/are deleted/)).toBeNull();

    list.release();
    days.release();
    await view.findByText('Doe, Jane');
    expect(view.queryByRole('status', { name: 'Loading audit log' })).toBeNull();
    expect(view.container.querySelector('.empty')).toBeNull();
    await view.findByText('Entries older than 90 days are deleted');
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(keep('90 days')).toHaveAttribute('aria-disabled', 'false');
  });

  it('sends `cat` on a click on a filter and shows its entries', async () => {
    const list = held({ ...DATA, entries: ENTRIES.slice(1, 2) });
    const view = renderPage({ 'GET admin/audit?cat=users': [list.reply] });
    await view.findByText('Doe, Jane');

    await fireEvent.click(filter('Users'));
    expect(filter('Users')).toHaveAttribute('aria-pressed', 'true');
    expect(filter('All')).toHaveAttribute('aria-pressed', 'false');
    // The previous list stays until the response.
    expect(view.getByText('Doe, Jane').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');

    list.release();
    await vi.waitFor(() => expect(view.queryByText('Doe, Jane')).toBeNull());
    expect(view.getByText('Brown, Alice').closest('[aria-busy]')).toHaveAttribute('aria-busy', 'false');
    expect(listCalls(view.calls).map((c) => c.path)).toEqual(['admin/audit', 'admin/audit?cat=users']);
  });

  it('shows the empty state without days', async () => {
    const view = renderPage({ 'GET admin/audit': [{ body: NONE }] });
    expect(await view.findByText('No entries found')).toBeInTheDocument();
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Retention']);
    expect(filter('All').textContent.trim()).toBe('All0');
  });

  it('shows the load card in place of the list and reloads with "Try again"', async () => {
    const view = renderPage({ 'GET admin/audit': [{ status: 500 }, { body: DATA }] });
    const card = await view.findByRole('alert');
    expect(card).toHaveTextContent('Couldn’t load the audit log');
    expect(card).toHaveTextContent('That didn’t work. Please try again.');
    expect(view.queryByText('No entries found')).toBeNull();
    expect(view.queryByRole('status', { name: 'Loading audit log' })).toBeNull();
    expect(filter('All').textContent.trim()).toBe('All');

    await fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(await view.findByText('Doe, Jane')).toBeInTheDocument();
    expect(view.queryByRole('alert')).toBeNull();
    expect(filter('All').textContent.trim()).toBe('All4');
  });

  it('after a failed switch the card stays and the counts are empty', async () => {
    const view = renderPage({ 'GET admin/audit?cat=users': [{ status: 500 }] });
    await view.findByText('Doe, Jane');
    await fireEvent.click(filter('Users'));
    const card = await view.findByRole('alert');
    expect(card).toHaveTextContent('Couldn’t load the audit log');
    expect(view.queryByText('Doe, Jane')).toBeNull();
    expect(filter('Users').textContent.trim()).toBe('Users');
  });

  it('appends the next page with "Load more entries"', async () => {
    const page = held({ ...DATA, entries: ENTRIES.slice(3), next: null });
    const view = renderPage({
      'GET admin/audit': [{ body: { ...DATA, entries: ENTRIES.slice(0, 3), next: 2 } }],
      'GET admin/audit?before=2': [page.reply],
    });
    const more = await view.findByRole('button', { name: 'Load more entries' });
    expect(more).toHaveAttribute('aria-busy', 'false');
    expect(more).toBeEnabled();
    expect(more).not.toHaveClass('busy');
    expect(view.queryByText('Clark, Luke')).toBeNull();

    await fireEvent.click(more);
    // While loading more: "Loading …", `aria-busy`, not `disabled` (the focus stays).
    expect(more).toHaveAttribute('aria-busy', 'true');
    expect(more).toHaveTextContent('Loading …');
    expect(more).toHaveClass('busy');
    expect(more).toBeEnabled();
    await fireEvent.click(more);
    expect(view.calls.filter((c) => c.path.includes('before='))).toHaveLength(1);

    page.release();
    expect(await view.findByText('Clark, Luke')).toBeInTheDocument();
    expect(view.getByText('Doe, Jane')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Load more entries' })).toBeNull();
  });

  it('reports a failed load-more as an error toast; entries and button stay', async () => {
    const view = renderPage({
      'GET admin/audit': [{ body: { ...DATA, entries: ENTRIES.slice(0, 3), next: 2 } }],
      'GET admin/audit?before=2': [{ status: 500 }],
    });
    await fireEvent.click(await view.findByRole('button', { name: 'Load more entries' }));
    await vi.waitFor(() =>
      expect(ui.toast).toMatchObject({ error: true, text: 'That didn’t work. Please try again.' }),
    );
    expect(view.getByText('Doe, Jane')).toBeInTheDocument();
    expect(view.getByRole('button', { name: 'Load more entries' })).toHaveAttribute('aria-busy', 'false');
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows the period with total and saves a new one at once', async () => {
    const view = renderPage({
      'GET admin/audit': [{ body: DATA }, { body: DATA }],
      'PUT admin/audit/retention': [{ body: { days: 365 } }],
    });
    expect(await view.findByText('Entries older than 90 days are deleted')).toBeInTheDocument();
    expect(view.getByRole('heading', { level: 2, name: 'Retention' })).toBeInTheDocument();
    expect(view.getByText('Applies to all areas of the audit log.')).toBeInTheDocument();
    expect(view.getByText('Keep entries')).toBeInTheDocument();
    expect(
      within(keepGroup())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['30 days', '90 days', '1 year']);
    expect(keep('90 days')).toHaveAttribute('aria-pressed', 'true');
    expect(keep('90 days')).toHaveClass('on');

    await fireEvent.click(keep('1 year'));
    expect(view.getByText('Entries older than one year are deleted')).toBeInTheDocument();
    expect(keep('1 year')).toHaveAttribute('aria-pressed', 'true');
    expect(keep('90 days')).toHaveAttribute('aria-pressed', 'false');
    expect(view.calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body])).toEqual([
      ['admin/audit/retention', { days: 365 }],
    ]);
    // The period applies at once, the list is reloaded.
    await vi.waitFor(() => expect(listCalls(view.calls)).toHaveLength(2));
  });

  it('shows the load card in place of the retention and reloads the period', async () => {
    const view = renderPage({ 'GET admin/audit/retention': [{ status: 500 }, { body: { days: 30 } }] });
    const card = await view.findByRole('alert');
    expect(card).toHaveTextContent('Couldn’t load the retention setting');
    expect(view.queryByRole('group', { name: 'Keep entries' })).toBeNull();
    expect(view.getByRole('heading', { level: 2, name: 'Retention' })).toBeInTheDocument();

    await fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(await view.findByText('Entries older than 30 days are deleted')).toBeInTheDocument();
    expect(view.queryByRole('alert')).toBeNull();
    expect(keep('30 days')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows "Clear search" only with input and clears the field', async () => {
    const view = renderPage();
    await view.findByText('Doe, Jane');
    const search = view.getByRole('textbox', { name: 'Search audit log' });
    await fireEvent.input(search, { target: { value: 'alice' } });
    expect(search).toHaveValue('alice');

    await fireEvent.click(view.getByRole('button', { name: 'Clear search' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(view.queryByRole('button', { name: 'Clear search' })).toBeNull();
    // The input never arrived, so nothing to reload.
    expect(listCalls(view.calls)).toHaveLength(1);
  });

  it('shows the area in the meta line, no badge and the export as an icon on mobile', async () => {
    vi.stubGlobal('innerWidth', 390);
    window.dispatchEvent(new Event('resize'));
    const view = renderPage();
    await view.findByText('Doe, Jane');
    expect(ui.isMobile).toBe(true);
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Audit log');
    expect(view.getByText('Track changes and sign-ins.')).toBeInTheDocument();

    expect(within(row('Doe, Jane')).getByText('09:26 · Sign-in · London, United Kingdom')).toBeInTheDocument();
    expect(within(row('Doe, Jane')).queryByText('09:26 · London, United Kingdom')).toBeNull();
    expect(within(row('Brown, Alice')).getByText('08:00 · Users')).toBeInTheDocument();
    expect(view.container.querySelector('.cat')).toBeNull();

    const exportButton = view.getByRole('button', { name: 'Export as CSV' });
    expect(exportButton).toHaveAttribute('aria-label', 'Export as CSV');
    expect(exportButton.textContent.trim()).toBe('');
    expect(view.getByText('Applies to all areas.')).toBeInTheDocument();
    expect(view.queryByText('Applies to all areas of the audit log.')).toBeNull();
  });
});
