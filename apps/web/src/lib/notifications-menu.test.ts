import { describe, expect, it, vi } from 'vitest';
import {
  bellValues,
  notifMenuValues,
  targetOf,
  visibleNotifications,
  type NotifMenuActions,
  type NotifMenuInput,
} from '#lib/notifications-menu.ts';
import type { AppNotification } from '#lib/state/notifications.svelte.ts';

const NOW = Date.parse('2026-11-04T15:00:00Z');
const ON = { app: true, mail: true, push: false };

function entry(id: string, over: Partial<AppNotification> = {}): AppNotification {
  return {
    id,
    topic: 'security',
    kind: 'security.login',
    icon: 'ti-device-mobile',
    title: 'New sign-in',
    text: 'Safari on iPhone in Hamburg, Germany. Not you? Sign out the device.',
    target: { view: 'settings', page: 'security', path: '/account/security' },
    created_at: '2026-11-04T13:00:00Z',
    read_at: null,
    ...over,
  };
}

function actions(): NotifMenuActions {
  return { open: vi.fn(), dismiss: vi.fn(), markAll: vi.fn(), enable: vi.fn(), settings: vi.fn() };
}

function input(over: Partial<NotifMenuInput> = {}): NotifMenuInput {
  return { isMobile: false, list: [], channels: ON, topics: {}, tz: 'Europe/Berlin', now: NOW, ...over };
}

describe('visibleNotifications', () => {
  it('counts unread entries of visible topics, none without the "In the app" channel', () => {
    const list = [entry('a'), entry('b', { topic: 'news' }), entry('c', { read_at: '2026-11-04T14:00:00Z' })];
    const topics = { news: { app: false, mail: true, push: false } };
    expect(visibleNotifications({ list, channels: ON, topics })).toMatchObject({ unread: 1 });
    expect(visibleNotifications({ list, channels: ON, topics }).visible.map((n) => n.id)).toEqual(['a', 'c']);
    expect(visibleNotifications({ list, channels: { ...ON, app: false }, topics }).unread).toBe(0);
    expect(visibleNotifications({ list: null, channels: ON, topics }).unread).toBe(0);
  });
});

describe('bellValues', () => {
  it('shows the number, from 10 "9+", and names it in the label', () => {
    expect(bellValues(0)).toEqual({ bellBadge: false, bellBadgeN: '0', bellLabel: 'Notifications' });
    expect(bellValues(2)).toEqual({ bellBadge: true, bellBadgeN: '2', bellLabel: 'Notifications, 2 new' });
    expect(bellValues(12)).toMatchObject({ bellBadgeN: '9+', bellLabel: 'Notifications, 12 new' });
  });
});

describe('notifMenuValues', () => {
  it('groups by "Today" and "Earlier" in the time zone', () => {
    const list = [
      entry('a'),
      // 00:30 in Berlin, still the previous day in UTC.
      entry('b', { created_at: '2026-11-03T23:30:00Z' }),
      entry('c', { created_at: '2026-11-03T22:00:00Z', read_at: '2026-11-03T23:00:00Z' }),
    ];
    const v = notifMenuValues(input({ list }), actions());
    expect(v.notifGroups.map((g) => [g.label, g.items.map((i) => i.id)])).toEqual([
      ['Today', ['a', 'b']],
      ['Earlier', ['c']],
    ]);
    const utc = notifMenuValues(input({ list, tz: 'UTC' }), actions());
    expect(utc.notifGroups.map((g) => g.items.length)).toEqual([1, 2]);
    expect(v).toMatchObject({
      notifHas: true,
      notifEmpty: false,
      notifOff: false,
      hasUnread: true,
      notifNewLabel: '2',
      notifNewAria: '2 new',
    });
  });

  it('counts only the number in the header, from 100 "99+", for screen readers "‹n› new"', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => entry('e' + i));
    expect(notifMenuValues(input({ list: many(99) }), actions())).toMatchObject({
      notifNewLabel: '99',
      notifNewAria: '99 new',
    });
    expect(notifMenuValues(input({ list: many(100) }), actions())).toMatchObject({
      notifNewLabel: '99+',
      notifNewAria: '100 new',
    });
  });

  it('builds entries with dot, weight, tile, time and text', () => {
    const list = [
      entry('a'),
      entry('b', {
        icon: 'ti-unknown',
        text: '',
        read_at: '2026-11-04T14:00:00Z',
        created_at: '2026-11-04T14:58:30Z',
      }),
    ];
    const [a, b] = notifMenuValues(input({ list }), actions()).notifGroups[0]!.items;
    expect(a).toMatchObject({
      icon: 'ti-device-mobile',
      dot: true,
      fw: 800,
      hasText: true,
      time: '2 hours ago',
      tileBg: 'var(--accsoft)',
      tileInk: 'var(--deep)',
    });
    expect(b).toMatchObject({
      icon: 'ti-bell',
      dot: false,
      fw: 700,
      hasText: false,
      time: '1 min ago',
      tileBg: 'var(--surface2)',
      tileInk: 'var(--mfg)',
    });
  });

  it('knows empty, switched off and "not loaded yet"', () => {
    expect(notifMenuValues(input(), actions())).toMatchObject({ notifHas: false, notifEmpty: true, notifOff: false });
    expect(notifMenuValues(input({ list: [entry('a')], channels: { ...ON, app: false } }), actions())).toMatchObject({
      notifHas: false,
      notifEmpty: false,
      notifOff: true,
      hasUnread: false,
    });
    expect(notifMenuValues(input({ list: null }), actions())).toMatchObject({
      notifHas: false,
      notifEmpty: false,
      notifOff: false,
    });
  });

  it('passes actions through; Enter and space open, "Dismiss" does not open', () => {
    const act = actions();
    const list = [entry('a')];
    const v = notifMenuValues(input({ list }), act);
    const item = v.notifGroups[0]!.items[0]!;
    item.open();
    expect(act.open).toHaveBeenCalledWith(list[0]);

    const row = document.createElement('div');
    const key = (k: string, target: EventTarget = row) => {
      const event = new KeyboardEvent('keydown', { key: k, cancelable: true });
      Object.defineProperty(event, 'target', { value: target });
      Object.defineProperty(event, 'currentTarget', { value: row });
      item.key(event);
      return event;
    };
    expect(key('Enter').defaultPrevented).toBe(true);
    key(' ');
    key('a');
    key('Enter', document.createElement('button'));
    expect(act.open).toHaveBeenCalledTimes(3);

    const click = new MouseEvent('click');
    const stop = vi.spyOn(click, 'stopPropagation');
    item.dismiss(click);
    expect(stop).toHaveBeenCalled();
    expect(act.dismiss).toHaveBeenCalledWith('a');

    v.notifMarkAll();
    v.notifEnable();
    v.openNotifSettings();
    expect(act.markAll).toHaveBeenCalledOnce();
    expect(act.enable).toHaveBeenCalledOnce();
    expect(act.settings).toHaveBeenCalledOnce();
  });
});

describe('targetOf', () => {
  it('leads to the path and opens the row under Administration › Users', () => {
    expect(targetOf(null)).toBeNull();
    expect(targetOf({ view: 'settings', page: 'security', path: '/account/security' })).toEqual({
      path: '/account/security',
      userOpen: null,
    });
    expect(targetOf({ view: 'admin', page: 'users', path: '/admin/users', user_id: 'u2' })).toEqual({
      path: '/admin/users',
      userOpen: 'u2',
    });
    expect(targetOf({ view: 'admin', page: 'users', path: '/admin/users', invitation_id: 'i1' })).toMatchObject({
      userOpen: 'i1',
    });
    expect(
      targetOf({
        view: 'mailacct',
        page: 'overview',
        path: '/account/mail-accounts/a1/overview',
        mail_account_id: 'a1',
      }),
    ).toEqual({ path: '/account/mail-accounts/a1/overview', userOpen: null });
  });

  it('allows only app paths', () => {
    expect(targetOf({ view: 'settings', page: 'x', path: 'https://example.test/' })?.path).toBe('/start');
    expect(targetOf({ view: 'settings', page: 'x', path: '//example.test' })?.path).toBe('/start');
  });
});
