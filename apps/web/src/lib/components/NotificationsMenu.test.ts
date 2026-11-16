import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import NotificationsMenu from './NotificationsMenu.svelte';
import type { NotifItem, NotifMenuValues } from '#lib/notifications-menu.ts';

function item(patch: Partial<NotifItem> = {}): NotifItem {
  return {
    id: 'n1',
    icon: 'ti-device-mobile',
    title: 'New sign-in',
    text: 'Safari on iPhone in London',
    hasText: true,
    time: '2 hours ago',
    dot: true,
    fw: 800,
    tileBg: 'var(--accsoft)',
    tileInk: 'var(--deep)',
    open: () => {},
    key: () => {},
    // like `notifMenuValues`: "Remove" does not open the row
    dismiss: (event) => event.stopPropagation(),
    ...patch,
  };
}

function values(patch: Partial<NotifMenuValues> = {}): NotifMenuValues {
  return {
    isMobile: false,
    notifGroups: [
      { label: 'Today', items: [item(), item({ id: 'n2', title: 'Storage almost full', text: '', hasText: false })] },
      {
        label: 'Earlier',
        items: [
          item({
            id: 'n3',
            title: 'Welcome',
            text: 'Adjust appearance, language and more in the settings.',
            dot: false,
            fw: 700,
            tileBg: 'var(--surface2)',
            tileInk: 'var(--mfg)',
          }),
        ],
      },
    ],
    notifHas: true,
    notifEmpty: false,
    notifOff: false,
    hasUnread: true,
    notifNewLabel: '2',
    notifNewAria: '2 new',
    notifMarkAll: () => {},
    notifEnable: () => {},
    openNotifSettings: () => {},
    ...patch,
  };
}

const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.row')];
/** Button "Open" of a row with title and text. */
const openOf = (row: HTMLElement) => row.querySelector<HTMLButtonElement>(':scope > button.open')!;

describe('notifications', () => {
  it('shows the popover with groups and entries on desktop', () => {
    const { getByRole, getByText, queryByText, container } = render(NotificationsMenu, values());
    const pop = getByRole('dialog', { name: 'Notifications' });
    expect(pop).toHaveAttribute('data-pop');
    expect(container.querySelector('.scroll')).toHaveClass('no-scrollbar');
    expect([...container.querySelectorAll('.label')].map((l) => l.textContent)).toEqual(['Today', 'Earlier']);
    expect(getByRole('img', { name: '2 new' })).toHaveTextContent(/^2$/);
    expect(getByRole('button', { name: 'Mark all as read' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Notification settings' })).toBeInTheDocument();
    // The buttons sit as a group on the right, without a spacer.
    expect(container.querySelector('.head .acts')?.querySelectorAll('button')).toHaveLength(2);
    expect(container.querySelector('.grow')).toBeNull();

    const [first, second, third] = rows(container);
    // The row is not a control (axe `nested-interactive`), opening is a real button without `<div>`.
    expect(first).not.toHaveAttribute('role');
    expect(first).not.toHaveAttribute('tabindex');
    const open = getByRole('button', { name: /^New sign-in.*2 hours ago.*Safari on iPhone in London$/ });
    expect(open).toBe(openOf(first!));
    expect(open).toHaveAttribute('type', 'button');
    expect(open).not.toHaveAttribute('aria-label');
    expect(open.querySelector('div, button, [tabindex]')).toBeNull();
    expect(open.contains(first!.querySelector('.dismiss'))).toBe(false);
    expect(first?.querySelector('.dot')).not.toBeNull();
    expect(third?.querySelector('.dot')).toBeNull();
    expect(first?.querySelector('.time')).toHaveTextContent('2 hours ago');
    expect(getByText('Safari on iPhone in London')).toHaveClass('text');
    // Text only with `hasText`
    expect(second?.querySelector('.text')).toBeNull();
    expect(queryByText('All quiet')).toBeNull();
    expect(queryByText('Turned off in the app')).toBeNull();

    const title = getByText('New sign-in');
    // Titles come from the backend in the person's language, without their own `lang`.
    expect(title).not.toHaveAttribute('lang');
    expect(title.style.getPropertyValue('--fw')).toBe('800');
    expect(getByText('Welcome').style.getPropertyValue('--fw')).toBe('700');
    const tile = third?.querySelector<HTMLElement>('.tile');
    expect(tile?.style.getPropertyValue('--tile-bg')).toBe('var(--surface2)');
    expect(tile?.style.getPropertyValue('--tile-ink')).toBe('var(--mfg)');
  });

  it('shows "99+" from 100 unread and names the number for screen readers', () => {
    const { getByRole } = render(NotificationsMenu, values({ notifNewLabel: '99+', notifNewAria: '120 new' }));
    expect(getByRole('img', { name: '120 new' })).toHaveTextContent('99+');
  });

  it('shows counter and "Mark all as read" only with unread entries', () => {
    const { queryByRole, getByRole } = render(NotificationsMenu, values({ hasUnread: false }));
    expect(queryByRole('img', { name: '2 new' })).toBeNull();
    expect(queryByRole('button', { name: 'Mark all as read' })).toBeNull();
    expect(getByRole('button', { name: 'Notification settings' })).toBeInTheDocument();
  });

  it('opens an entry via its button by click and keyboard', async () => {
    const open = vi.fn();
    const key = vi.fn();
    const { container } = render(
      NotificationsMenu,
      values({ notifGroups: [{ label: 'Today', items: [item({ open, key })] }] }),
    );
    const [row] = rows(container);
    if (!row) throw new Error('no row');
    await fireEvent.click(openOf(row));
    expect(open).toHaveBeenCalledOnce();
    // A click on the text reaches the button.
    await fireEvent.click(row.querySelector('.text')!);
    expect(open).toHaveBeenCalledTimes(2);
    // Keyboard: the button is focusable, the browser triggers Enter and Space as a click – without its own
    // key handling (`key`), which would open a second time (jsdom does not trigger the click).
    openOf(row).focus();
    expect(document.activeElement).toBe(openOf(row));
    await fireEvent.keyDown(openOf(row), { key: 'Enter' });
    await fireEvent.keyDown(openOf(row), { key: ' ' });
    expect(key).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('removes an entry without opening it', async () => {
    const open = vi.fn();
    const dismiss = vi.fn((event: MouseEvent) => event.stopPropagation());
    const { getByRole } = render(
      NotificationsMenu,
      values({ notifGroups: [{ label: 'Today', items: [item({ open, dismiss })] }] }),
    );
    await fireEvent.click(getByRole('button', { name: 'Dismiss' }));
    expect(dismiss).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });

  it('moves focus after "Remove" via keyboard to the open button of the next row, not to the popup', async () => {
    const all = values().notifGroups.flatMap((g) => g.items);
    let shown = all;
    const props = () => values({ notifGroups: [{ label: 'Today', items: shown }] });
    const view = render(NotificationsMenu, props());
    const drop = (id: string) => {
      shown = shown.filter((n) => n.id !== id);
      void view.rerender(props());
    };
    shown = all.map((n) => ({ ...n, dismiss: () => drop(n.id) }));
    await view.rerender(props());
    const rows = () => [...view.container.querySelectorAll<HTMLElement>('.row')];
    const button = (row: HTMLElement) => row.querySelector<HTMLButtonElement>('button.dismiss')!;

    button(rows()[0]!).focus();
    await fireEvent.click(button(rows()[0]!));
    await tick();
    expect(document.activeElement).toBe(openOf(rows()[0]!));
    expect(rows()[0]).toHaveTextContent('Storage almost full');

    // Last row: focus to the previous one; without rows to the popup.
    button(rows()[1]!).focus();
    await fireEvent.click(button(rows()[1]!));
    await tick();
    expect(document.activeElement).toBe(openOf(rows()[0]!));
    button(rows()[0]!).focus();
    await fireEvent.click(button(rows()[0]!));
    await tick();
    expect(document.activeElement).toBe(view.getByRole('dialog', { name: 'Notifications' }));
  });

  it('marks everything as read and opens the settings', async () => {
    const notifMarkAll = vi.fn();
    const openNotifSettings = vi.fn();
    const { getByRole } = render(NotificationsMenu, values({ notifMarkAll, openNotifSettings }));
    await fireEvent.click(getByRole('button', { name: 'Mark all as read' }));
    expect(notifMarkAll).toHaveBeenCalledOnce();
    await fireEvent.click(getByRole('button', { name: 'Notification settings' }));
    expect(openNotifSettings).toHaveBeenCalledOnce();
  });

  it('shows "All quiet" without entries', () => {
    const { getByText, queryByText, container } = render(
      NotificationsMenu,
      values({ notifGroups: [], notifHas: false, notifEmpty: true, hasUnread: false }),
    );
    expect(getByText('All quiet')).toBeInTheDocument();
    expect(getByText('New notifications will appear here.')).toBeInTheDocument();
    expect(queryByText('Turn on')).toBeNull();
    expect(container.querySelector('.scroll')).toBeNull();
  });

  it('offers "Turn on" when turned off', async () => {
    const notifEnable = vi.fn();
    const { getByText, getByRole, queryByText } = render(
      NotificationsMenu,
      values({ notifGroups: [], notifHas: false, notifOff: true, hasUnread: false, notifEnable }),
    );
    expect(getByText('Turned off in the app')).toBeInTheDocument();
    expect(getByText('Turn on in-app notifications to see them here.')).toBeInTheDocument();
    expect(queryByText('All quiet')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Turn on' }));
    expect(notifEnable).toHaveBeenCalledOnce();
  });

  it('shows only the head before the first load', () => {
    const { getByRole, queryByText, container } = render(
      NotificationsMenu,
      values({ notifGroups: [], notifHas: false, hasUnread: false }),
    );
    expect(getByRole('button', { name: 'Notification settings' })).toBeInTheDocument();
    expect(container.querySelector('.scroll')).toBeNull();
    expect(container.querySelector('.state')).toBeNull();
    expect(queryByText('All quiet')).toBeNull();
  });

  it('shows the sheet content without a popover on mobile', async () => {
    const open = vi.fn();
    const notifMarkAll = vi.fn();
    const { getByText, getByRole, queryByRole, container } = render(
      NotificationsMenu,
      values({
        isMobile: true,
        notifMarkAll,
        notifGroups: [{ label: 'Today', items: [item({ open })] }],
      }),
    );
    expect(queryByRole('dialog')).toBeNull();
    expect(container.querySelector('[data-pop]')).toBeNull();
    expect(container.querySelector('.mobile')).not.toBeNull();
    expect(container.querySelector('.scroll')).toBeNull();
    expect(getByText('Notifications')).toHaveClass('title');
    expect(getByRole('img', { name: '2 new' })).toHaveTextContent(/^2$/);
    expect(getByText('Today')).toHaveClass('label');
    await fireEvent.click(getByRole('button', { name: 'Mark all as read' }));
    expect(notifMarkAll).toHaveBeenCalledOnce();
    const [row] = rows(container);
    if (!row) throw new Error('no row');
    expect(row).not.toHaveAttribute('role');
    await fireEvent.click(openOf(row));
    expect(open).toHaveBeenCalledOnce();
  });

  it('shows the turned-off state on mobile too', () => {
    const { getByRole } = render(
      NotificationsMenu,
      values({ isMobile: true, notifGroups: [], notifHas: false, notifOff: true, hasUnread: false }),
    );
    expect(getByRole('button', { name: 'Turn on' })).toBeInTheDocument();
  });
});
