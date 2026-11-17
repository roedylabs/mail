import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tooltips } from '#lib/actions/tooltip.ts';
import type { Backup, BackupsView, MaintenanceMode, StorageView } from '#lib/maintenance.svelte.ts';
import { MT_SAVE_DELAY } from '#lib/maintenance.svelte.ts';
import { m } from '#lib/paraglide/messages.js';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { session, type Me } from '#lib/state/session.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
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

const MB = 1024 * 1024;
const HOUR = 3600_000;
const LEAD = 'Maintenance mode, backups, and storage.';
const DEFAULT = m.login_maint_default();
const MODE: MaintenanceMode = { on: false, message: null };
const ON: MaintenanceMode = { on: true, message: null };
const STORAGE: StorageView = { database: 148 * MB, assets: 0, asset_name: null, compacted_at: null };

function backup(patch: Partial<Backup> = {}): Backup {
  return {
    id: 'b1',
    at: new Date(Date.now() - 9 * HOUR).toISOString(),
    size: 200 * MB,
    auto: true,
    legacy: false,
    ...patch,
  };
}

function backups(patch: Partial<BackupsView> = {}): BackupsView {
  return {
    backups: [backup(), backup({ id: 'b2', at: new Date(Date.now() - 30 * HOUR).toISOString(), auto: false })],
    auto: true,
    every: 'daily',
    keep: 30,
    next_at: new Date(Date.now() + 3 * HOUR).toISOString(),
    ...patch,
  };
}

type Routes = Parameters<typeof mockApi>[0];

function routes(extra: Routes = {}): Routes {
  return {
    'GET admin/maintenance': [{ body: MODE }],
    'GET admin/backups': [{ body: backups() }],
    'GET admin/storage': [{ body: STORAGE }],
    ...extra,
  };
}

/** Page with sections: all three responses are there. */
async function loaded(extra: Routes = {}) {
  const api = mockApi(routes(extra));
  const page = render(Page);
  await page.findByRole('heading', { level: 2, name: 'Storage' });
  return { ...page, ...api };
}

function mobile(): void {
  vi.stubGlobal('innerWidth', 390);
  window.dispatchEvent(new Event('resize'));
}

const section = (name: string) => screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement;
const field = () => screen.getByLabelText<HTMLTextAreaElement>('Notice for users');
const download = () => within(section('Backups')).getAllByRole('link', { name: 'Download' });
const written = (calls: { method: string; body: unknown }[], method: string) =>
  calls.filter((c) => c.method === method).map((c) => c.body);

beforeEach(() => {
  session.user = ME;
});

afterEach(() => {
  // Clean up first: `dispose` sends what is pending, `fetch` must still be in place for that.
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sections.scrollToSection.mockClear();
  ui.toasts.discard();
  ui.confirmCancel();
  ui.reset();
  prefs.reset();
  session.user = null;
  window.dispatchEvent(new Event('resize'));
});

describe('Administration › Maintenance page', () => {
  it('shows only the header until the first response and the skeleton after a short time', async () => {
    mockApi(routes({ 'GET admin/storage': [() => new Promise(() => {})] }));
    const view = render(Page);
    expect(view.getByRole('heading', { level: 1 })).toHaveClass('title');
    expect(view.getByRole('heading', { level: 1 })).toHaveTextContent('Maintenance');
    expect(view.getByText(LEAD)).toHaveClass('lead');
    expect(view.queryByText('Loading data …')).toBeNull();
    expect(await view.findByText('Loading data …')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Backups' })).toBeNull();
    expect(view.queryByRole('heading', { level: 2 })).toBeNull();
  });

  it('shows the card instead of the sections when loading fails, and reloads', async () => {
    mockApi(
      routes({
        'GET admin/maintenance': [{ body: MODE }, { body: MODE }],
        'GET admin/backups': [{ body: backups() }, { body: backups() }],
        'GET admin/storage': [{ status: 500, body: { error: 'internal' } }, { body: STORAGE }],
      }),
    );
    const view = render(Page);
    const alert = await view.findByRole('alert');
    expect(within(alert).getByText('Couldn’t load maintenance settings')).toBeInTheDocument();
    expect(within(alert).getByText(m.error_act())).toBeInTheDocument();
    expect(alert.querySelector('.tile svg')).toHaveClass('tabler-icon-cloud-off');
    expect(view.queryByRole('heading', { level: 2 })).toBeNull();
    expect(view.queryByRole('button', { name: 'Backups' })).toBeNull();
    await fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(view.queryByRole('alert')).toBeNull();
    expect(await view.findByRole('heading', { level: 2, name: 'Storage' })).toBeInTheDocument();
  });

  it('shows tabs and all sections with their texts', async () => {
    const view = await loaded();
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Maintenance mode',
      'Backups',
      'Storage',
    ]);
    expect([...view.container.querySelectorAll('.tab')].map((t) => t.textContent)).toEqual([
      'Maintenance mode',
      'Backups',
      'Storage',
    ]);

    const mode = within(section('Maintenance mode'));
    expect(mode.getByText('Temporarily locks the app for everyone except administrators.')).toBeInTheDocument();
    expect(mode.getByText('Off')).toBeInTheDocument();
    expect(mode.getByText('Appears on the sign-in page while maintenance is in progress')).toBeInTheDocument();

    const list = within(section('Backups'));
    expect(list.getByText('Last backup 9 hours ago')).toBeInTheDocument();
    expect(list.getByText('Full backup of all data')).toBeInTheDocument();
    expect(list.getByText('Interval between backups')).toBeInTheDocument();
    expect(list.getByText('Older backups are deleted')).toBeInTheDocument();
    expect(list.getByText(/^Next backup /)).toBeInTheDocument();
    expect(
      within(list.getByRole('group', { name: 'Frequency' }))
        .getAllByRole('button')
        .map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['Daily', 'true'],
      ['Weekly', 'false'],
    ]);
    expect(
      within(list.getByRole('group', { name: 'Keep for' }))
        .getAllByRole('button')
        .map((b) => [b.textContent, b.getAttribute('aria-pressed')]),
    ).toEqual([
      ['7 days', 'false'],
      ['30 days', 'true'],
      ['90 days', 'false'],
    ]);

    const storage = within(section('Storage'));
    expect(storage.getByText('Space used on the server.')).toBeInTheDocument();
    expect(
      [...section('Storage').querySelectorAll('.st-row')].map((r) => [
        r.querySelector('.item-title')?.textContent,
        r.querySelector('.item-sub')?.textContent,
        r.querySelector('.st-size')?.textContent,
        r
          .querySelector('svg')
          ?.getAttribute('class')
          ?.match(/tabler-icon-[a-z-]+/)?.[0],
      ]),
    ).toEqual([
      ['Database', 'Users, settings, and audit log', '148 MB', 'tabler-icon-database'],
      ['Backups', '2 backups', '400 MB', 'tabler-icon-archive'],
      ['Logo files', 'No custom logo', '0 KB', 'tabler-icon-photo'],
    ]);
    expect(storage.getByText(m.maintenance_st_desc())).toBeInTheDocument();
    expect(section('Storage').querySelectorAll('.sep')).toHaveLength(3);
  });

  it('asks before enabling and shows maintenance mode on the tile', async () => {
    const view = await loaded({ 'PUT admin/maintenance': [{ body: { on: true, message: null } }] });
    const toggle = view.getByRole('switch', { name: 'Maintenance mode' });
    const tile = section('Maintenance mode').querySelector('.tile') as HTMLElement;
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).not.toHaveClass('on');
    expect(tile).not.toHaveClass('active');
    expect(tile.querySelector('svg')).toHaveClass('tabler-icon-tool');

    await fireEvent.click(toggle);
    expect(ui.confirm?.title).toBe('Turn on maintenance mode?');
    expect(written(view.calls, 'PUT')).toEqual([]);
    ui.confirm?.run();
    await vi.waitFor(() => expect(written(view.calls, 'PUT')).toEqual([{ on: true }]));
    await vi.waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(toggle).toHaveClass('on');
    expect(tile).toHaveClass('active');
    expect(view.getByText('Active. Only administrators can use the app.')).toBeInTheDocument();
  });

  it('wires the notice field with every input and offers the default text', async () => {
    const view = await loaded({ 'PUT admin/maintenance': [{ body: { on: false, message: 'Until 6 pm' } }] });
    expect(field().tagName).toBe('TEXTAREA');
    expect(field()).toHaveValue(DEFAULT);
    expect(field()).toHaveAttribute('rows', '3');
    expect(field()).toHaveAttribute('maxlength', '500');
    expect(view.queryByRole('button', { name: 'Default text' })).toBeNull();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await fireEvent.input(field(), { target: { value: 'Until 6 pm' } });
    expect(field()).toHaveValue('Until 6 pm');
    await vi.advanceTimersByTimeAsync(MT_SAVE_DELAY);
    vi.useRealTimers();
    await vi.waitFor(() => expect(written(view.calls, 'PUT')).toEqual([{ message: 'Until 6 pm' }]));

    await fireEvent.click(view.getByRole('button', { name: 'Default text' }));
    expect(field()).toHaveValue(DEFAULT);
    expect(view.queryByRole('button', { name: 'Default text' })).toBeNull();
  });

  it('shows the backups with link, restore and delete', async () => {
    const view = await loaded({ 'GET admin/maintenance': [{ body: ON }] });
    expect(section('Backups').querySelector('.bk-maint')).toBeNull();
    const rows = () => [...section('Backups').querySelectorAll<HTMLElement>('.bk-row')];
    const [first, second] = rows() as [HTMLElement, HTMLElement];
    expect(rows()).toHaveLength(2);
    expect(first.querySelector('svg')).toHaveClass('tabler-icon-clock');
    expect(first).toHaveTextContent('200 MB · Automatic');
    expect(second.querySelector('svg')).toHaveClass('tabler-icon-hand-click');
    expect(second).toHaveTextContent('200 MB · Manual');
    expect(first.parentElement?.querySelector('.sep')).toBeNull();
    expect(second.parentElement?.querySelector('.sep')).not.toBeNull();

    const link = within(first).getByRole('link', { name: 'Download' });
    expect(download()).toHaveLength(2);
    expect(link).toHaveAttribute('href', '/api/v1/admin/backups/b1/download');
    expect(link).toHaveAttribute('download');
    expect(tooltips.targets.get(link)?.text).toBe('Download');
    // The click should only show the toast here; jsdom cannot navigate.
    link.addEventListener('click', (event) => event.preventDefault());
    await fireEvent.click(link);
    expect(ui.toast?.text).toBe('Preparing download');

    const row = within(first);
    await fireEvent.click(row.getByRole('button', { name: 'Restore' }));
    expect(ui.confirm?.title).toBe('Restore backup?');
    expect(ui.confirm?.word).toBe('RESTORE');
    ui.confirmCancel();

    const remove = row.getByRole('button', { name: 'Delete' });
    expect(tooltips.targets.get(remove)?.text).toBe('Delete');
    await fireEvent.click(remove);
    expect(rows()).toHaveLength(1);
    expect(ui.toast?.text).toBe('Backup deleted');
    expect(written(view.calls, 'DELETE')).toEqual([]);
  });

  it('locks "Restore" outside maintenance mode and offers to turn it on above the list', async () => {
    const view = await loaded({ 'PUT admin/maintenance': [{ body: ON }] });
    const list = section('Backups');
    const notice = list.querySelector('.bk-maint') as HTMLElement;
    expect(notice.nextElementSibling).toHaveClass('sep');
    expect(notice.parentElement?.firstElementChild).toBe(notice);
    expect(notice.querySelector('svg')).toHaveClass('tabler-icon-tool');
    expect(notice).toHaveTextContent('Restore only in maintenance mode');
    expect(notice).toHaveTextContent('That way nobody changes data while it’s being reset.');

    for (const restore of within(list).getAllByRole('button', { name: 'Restore' })) {
      expect(restore).toHaveAttribute('aria-disabled', 'true');
      expect(restore).toHaveClass('restore', 'locked');
      expect(tooltips.targets.get(restore)?.text).toBe('Only possible in maintenance mode');
    }
    await fireEvent.click(within(list).getAllByRole('button', { name: 'Restore' })[0] as HTMLElement);
    expect(ui.confirm).toBeNull();

    const on = within(notice).getByRole('button', { name: 'Turn on maintenance mode' });
    expect(on).toHaveClass('restore');
    await fireEvent.click(on);
    expect(ui.confirm?.title).toBe('Turn on maintenance mode?');
    ui.confirm?.run();
    await vi.waitFor(() => expect(list.querySelector('.bk-maint')).toBeNull());
    expect(written(view.calls, 'PUT')).toEqual([{ on: true }]);
    const restore = within(list).getAllByRole('button', { name: 'Restore' })[0] as HTMLElement;
    expect(restore).toHaveAttribute('aria-disabled', 'false');
    expect(restore).not.toHaveClass('locked');
    expect(tooltips.targets.get(restore)?.text).toBeUndefined();
    await fireEvent.click(restore);
    expect(ui.confirm?.title).toBe('Restore backup?');
  });

  it('marks a legacy backup and locks "Restore" with its own tooltip, also in maintenance mode', async () => {
    const legacy = backups({ backups: [backup(), backup({ id: 'b2', auto: false, legacy: true })] });
    await loaded({ 'GET admin/maintenance': [{ body: ON }], 'GET admin/backups': [{ body: legacy }] });
    const list = section('Backups');
    expect(list.querySelector('.bk-maint')).toBeNull();
    const [free, old] = [...list.querySelectorAll<HTMLElement>('.bk-row')];
    expect(within(free as HTMLElement).getByText('200 MB · Automatic')).toBeInTheDocument();
    expect(
      within(old as HTMLElement).getByText('200 MB · Manual · Older version, can’t be restored'),
    ).toBeInTheDocument();
    const restore = within(old as HTMLElement).getByRole('button', { name: 'Restore' });
    expect(restore).toHaveAttribute('aria-disabled', 'true');
    expect(restore).toHaveClass('restore', 'locked');
    expect(tooltips.targets.get(restore)?.text).toBe('Comes from an older version and can’t be restored');
    await fireEvent.click(restore);
    expect(ui.confirm).toBeNull();
    const other = within(free as HTMLElement).getByRole('button', { name: 'Restore' });
    expect(other).toHaveAttribute('aria-disabled', 'false');
  });

  it('shows no notice without backups', async () => {
    await loaded({ 'GET admin/backups': [{ body: backups({ backups: [] }) }] });
    expect(section('Backups').querySelector('.bk-maint')).toBeNull();
  });

  it('shows the empty text without backups and names no date without a schedule', async () => {
    const view = await loaded({ 'GET admin/backups': [{ body: backups({ backups: [], auto: false }) }] });
    const list = section('Backups');
    expect(list.querySelector('.bk-row')).toBeNull();
    expect(list.querySelector('.empty')).toHaveTextContent('No backups yet');
    expect(list.querySelector('.sec-desc')).toHaveTextContent('No backups yet');
    expect(within(list).getByText('Off')).toBeInTheDocument();
    expect(view.getByText('No backups')).toBeInTheDocument();
  });

  it('dims and locks frequency and retention when "Back up automatically" is off', async () => {
    const view = await loaded({
      'GET admin/backups': [{ body: backups({ auto: false, next_at: null }) }],
      'PUT admin/backups/schedule': [{ body: backups() }, { body: backups({ every: 'weekly', keep: 7 }) }],
    });
    const list = within(section('Backups'));
    const toggle = list.getByRole('switch', { name: 'Back up automatically' });
    const rows = () => [...section('Backups').querySelectorAll('.row:has(.seg)')];
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(rows()).toHaveLength(2);
    expect(rows().every((r) => r.classList.contains('dim'))).toBe(true);
    // Dimmed text only on locked elements: otherwise axe flags it.
    expect(rows().every((r) => r.getAttribute('role') === 'group' && r.getAttribute('aria-disabled') === 'true')).toBe(
      true,
    );
    expect(list.getByRole('button', { name: 'Weekly' })).toBeDisabled();
    expect(list.getByRole('button', { name: '90 days' })).toBeDisabled();

    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(rows().some((r) => r.classList.contains('dim'))).toBe(false);
    expect(rows().some((r) => r.hasAttribute('aria-disabled'))).toBe(false);
    expect(list.getByRole('button', { name: 'Weekly' })).toBeEnabled();
    await vi.waitFor(() => expect(written(view.calls, 'PUT')).toEqual([{ auto: true }]));

    await fireEvent.click(list.getByRole('button', { name: 'Weekly' }));
    await fireEvent.click(list.getByRole('button', { name: '7 days' }));
    expect(list.getByRole('button', { name: 'Weekly' })).toHaveAttribute('aria-pressed', 'true');
    expect(list.getByRole('button', { name: '7 days' })).toHaveAttribute('aria-pressed', 'true');
    await vi.waitFor(() => expect(written(view.calls, 'PUT')).toEqual([{ auto: true }, { every: 'weekly', keep: 7 }]));
  });

  it('spins the icon and locks the button while backing up', async () => {
    let finish: (reply: { body: Backup }) => void = () => {};
    const view = await loaded({
      'POST admin/backups': [() => new Promise((resolve) => (finish = resolve))],
    });
    const button = view.getByRole('button', { name: 'Back up now' });
    expect(button).toHaveAttribute('aria-disabled', 'false');
    expect(button).not.toHaveClass('busy');
    expect(button.querySelector('svg')).toHaveClass('tabler-icon-database-plus');

    await fireEvent.click(button);
    const busy = await within(section('Backups')).findByRole('button', { name: 'Running …' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toHaveClass('busy');
    expect(busy.querySelector('.busy-icon')).toHaveStyle('--rot: 720deg');
    expect(busy.querySelector('svg')).toHaveClass('tabler-icon-loader-2');
    await fireEvent.click(busy);
    await vi.waitFor(() => expect(written(view.calls, 'POST')).toHaveLength(1));

    finish({ body: backup({ id: 'b3' }) });
    expect(await view.findByRole('button', { name: 'Back up now' })).toHaveAttribute('aria-busy', 'false');
    expect(ui.toast?.text).toBe('Backup created');
  });

  it('asks before compacting, spins the icon and shows the last run', async () => {
    let finish: (reply: { body: StorageView }) => void = () => {};
    const view = await loaded({
      'POST admin/storage/compact': [() => new Promise((resolve) => (finish = resolve))],
    });
    const storage = within(section('Storage'));
    const button = storage.getByRole('button', { name: 'Compact' });
    expect(button.querySelector('svg')).toHaveClass('tabler-icon-arrows-minimize');

    await fireEvent.click(button);
    expect(ui.confirm?.title).toBe('Compact database?');
    ui.confirm?.run();
    const busy = await storage.findByRole('button', { name: 'Running …' });
    expect(busy).toHaveAttribute('aria-disabled', 'true');
    expect(busy).toHaveClass('busy');
    expect(busy.querySelector('.busy-icon')).toHaveStyle('--rot: 720deg');
    expect(written(view.calls, 'POST')).toHaveLength(1);

    finish({ body: { ...STORAGE, compacted_at: new Date(Date.now() - 2 * HOUR - 60_000).toISOString() } });
    expect(await storage.findByRole('button', { name: 'Compact' })).toHaveAttribute('aria-busy', 'false');
    expect(storage.getByText(/Last run 2 hours ago\.$/)).toBeInTheDocument();
    expect(ui.toast?.text).toBe('Database compacted');
  });

  it('scrolls to the section via the tabs', async () => {
    const view = await loaded();
    const tab = [...view.container.querySelectorAll<HTMLElement>('.tab')].find((t) => t.textContent === 'Storage');
    await fireEvent.click(tab as HTMLElement);
    expect(sections.scrollToSection).toHaveBeenCalledTimes(1);
    const [root, key, animate] = sections.scrollToSection.mock.calls[0] as [HTMLElement, string, boolean];
    expect(key).toBe('storage');
    expect(animate).toBe(true);
    expect([...root.querySelectorAll('section')].map((s) => s.dataset.sec)).toEqual(['mode', 'backups', 'storage']);
  });

  it('sends what is still pending on leaving', async () => {
    const view = await loaded({ 'PUT admin/backups/schedule': [{ body: backups({ keep: 90 }) }] });
    await fireEvent.click(within(section('Backups')).getByRole('button', { name: '90 days' }));
    expect(written(view.calls, 'PUT')).toEqual([]);
    view.unmount();
    await vi.waitFor(() => expect(written(view.calls, 'PUT')).toEqual([{ keep: 90 }]));
  });

  it('shows the shorter texts, icon buttons without download and the button without card on mobile', async () => {
    mobile();
    const view = await loaded({
      'GET admin/maintenance': [{ body: { on: false, message: 'Until 6 pm' } }],
    });
    expect(ui.isMobile).toBe(true);
    expect(view.container.querySelector('.page')).toHaveClass('mobile');
    expect(view.getByRole('heading', { level: 1 })).toHaveClass('m-title');
    expect(view.getByText(LEAD)).toHaveClass('m-lead');

    const mode = within(section('Maintenance mode'));
    expect(mode.getByText('Locks the app for everyone except administrators.')).toBeInTheDocument();
    expect(mode.getByText('Appears on the sign-in page')).toBeInTheDocument();
    expect(mode.queryByText('Appears on the sign-in page while maintenance is in progress')).toBeNull();
    const reset = mode.getByRole('button', { name: 'Use default text' });
    expect(field().nextElementSibling).toBe(reset);
    await fireEvent.click(reset);
    expect(field()).toHaveValue(DEFAULT);
    expect(mode.queryByRole('button', { name: 'Use default text' })).toBeNull();

    const list = section('Backups');
    const now = within(list).getByRole('button', { name: 'Back up now' });
    expect(now.closest('.box')).toBeNull();
    expect(within(list).queryByText('Full backup of all data')).toBeNull();
    expect(within(list).queryByRole('link')).toBeNull();
    const row = within(list.querySelector('.bk-row') as HTMLElement);
    const restore = row.getByRole('button', { name: 'Restore' });
    expect(restore).toHaveClass('icon-btn');
    expect(restore.querySelector('svg')).toHaveClass('tabler-icon-history');
    // Outside maintenance mode: locked, without a tooltip, the notice with the full-width button.
    expect(restore).toHaveAttribute('aria-disabled', 'true');
    expect(restore).toHaveClass('locked');
    expect(tooltips.targets.get(restore)?.text).toBeUndefined();
    const notice = list.querySelector('.bk-maint') as HTMLElement;
    expect(notice).toHaveTextContent('Restore only in maintenance mode');
    const on = within(notice).getByRole('button', { name: 'Turn on maintenance mode' });
    expect(on).toHaveClass('bk-maint-on');
    expect(on.parentElement).toBe(notice);
    expect(tooltips.targets.get(row.getByRole('button', { name: 'Delete' }))?.text).toBeUndefined();
    expect(within(list).queryByText('Interval between backups')).toBeNull();
    expect(within(list).getByText('Older backups are deleted')).toBeInTheDocument();
  });

  it('marks a legacy backup on mobile without a tooltip', async () => {
    mobile();
    const legacy = backups({ backups: [backup({ legacy: true })] });
    await loaded({ 'GET admin/maintenance': [{ body: ON }], 'GET admin/backups': [{ body: legacy }] });
    const row = within(section('Backups').querySelector('.bk-row') as HTMLElement);
    expect(row.getByText('200 MB · Automatic · Older version, can’t be restored')).toBeInTheDocument();
    const restore = row.getByRole('button', { name: 'Restore' });
    expect(restore.querySelector('svg')).toHaveClass('tabler-icon-history');
    expect(restore).toHaveAttribute('aria-disabled', 'true');
    expect(restore).toHaveClass('locked');
    expect(tooltips.targets.get(restore)?.text).toBeUndefined();
  });
});
