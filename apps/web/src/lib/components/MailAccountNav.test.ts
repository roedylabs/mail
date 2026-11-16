import { fireEvent, render, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { NO_ACCOUNT, type CurrentAccount, type MailAccountNavValues } from '#lib/mail-account.svelte.ts';
import type { NavEntry } from '#lib/settings-nav.ts';
import MailAccountNav from './MailAccountNav.svelte';

const CUR: CurrentAccount = {
  kind: 'ok',
  st: 'Connected',
  needsAuth: false,
  email: 'account1@s1.test',
  letter: 'A',
  chip: '#94c48d',
  chipInk: '#13300f',
};

function entry(id: string, label: string, icon: NavEntry['icon'], onClick = () => {}): NavEntry {
  return { id, label, icon, on: id === 'overview', fw: id === 'overview' ? 800 : 600, tip: undefined, onClick };
}

function values(patch: Partial<MailAccountNavValues> = {}): MailAccountNavValues {
  return {
    maNav: [
      entry('overview', 'Overview', 'ti-layout-dashboard'),
      entry('identities', 'Identities', 'ti-id-badge-2'),
      entry('vacation', 'Vacation reply', 'ti-beach'),
      entry('connection', 'Connection', 'ti-plug-connected'),
      entry('rules', 'Rules', 'ti-filter'),
    ],
    maCur: CUR,
    maSwOpen: false,
    maSwTip: undefined,
    toggleMaSw: () => {},
    picker: { isMobile: true, maSwList: [], maSwAdd: () => {}, maSwManage: () => {}, closeSheet: () => {} },
    ...patch,
  };
}

describe('email account › start', () => {
  it('shows the account switch with address and status and opens the account picker', async () => {
    const toggleMaSw = vi.fn();
    const view = render(MailAccountNav, values({ toggleMaSw }));
    const sw = view.getByRole('button', { name: 'Switch email account' });
    expect(sw).toHaveAttribute('aria-haspopup', 'dialog');
    expect(sw).toHaveAttribute('aria-expanded', 'false');
    expect(within(sw).getByText('account1@s1.test').tagName).toBe('H1');
    const st = within(sw).getByText('Connected');
    expect(st).toHaveClass('ok');
    expect(sw.querySelector('.chip')).toHaveStyle({ color: '#13300f' });
    await fireEvent.click(sw);
    expect(toggleMaSw).toHaveBeenCalled();
  });

  it('reports "Sign-in required" and the open sheet', () => {
    const view = render(
      MailAccountNav,
      values({ maSwOpen: true, maCur: { ...CUR, kind: 'auth', st: 'Sign-in required', needsAuth: true } }),
    );
    const sw = view.getByRole('button', { name: 'Switch email account' });
    expect(sw).toHaveAttribute('aria-expanded', 'true');
    expect(within(sw).getByText('Sign-in required')).toHaveClass('auth');
  });

  it('shows an empty tile without an account (list loading)', () => {
    const view = render(MailAccountNav, values({ maCur: NO_ACCOUNT }));
    const sw = view.getByRole('button', { name: 'Switch email account' });
    expect(sw.querySelector('.st')).toHaveClass('none');
  });

  it('lists the account subpages', async () => {
    const open = vi.fn();
    const v = values();
    v.maNav[3] = entry('connection', 'Connection', 'ti-plug-connected', open);
    const view = render(MailAccountNav, v);
    const items = view.container.querySelectorAll('.m-item');
    expect([...items].map((b) => b.textContent?.trim())).toEqual([
      'Overview',
      'Identities',
      'Vacation reply',
      'Connection',
      'Rules',
    ]);
    await fireEvent.click(view.getByRole('button', { name: 'Connection' }));
    expect(open).toHaveBeenCalled();
  });
});
