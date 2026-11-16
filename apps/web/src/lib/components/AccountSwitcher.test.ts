import { fireEvent, render, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AccountSwitcher from './AccountSwitcher.svelte';
import type { AccountSwitcherValues, SwitcherAccount } from '#lib/shell.ts';

function acct(patch: Partial<SwitcherAccount> = {}): SwitcherAccount {
  return {
    id: 'a1',
    email: 'account1@s1.test',
    letter: 'A',
    tileBg: '#94c48d',
    tileInk: '#13300f',
    warn: false,
    host: 'mail.s1.test',
    checked: true,
    isDef: true,
    onClick: () => {},
    ...patch,
  };
}

function values(patch: Partial<AccountSwitcherValues> = {}): AccountSwitcherValues {
  return {
    isMobile: false,
    acctAll: { show: true, checked: false, n: '4 mailboxes', onClick: () => {} },
    allTiles: [
      { letter: 'A', bg: '#94c48d', ink: '#13300f' },
      { letter: 'M', bg: '#e7b07a', ink: '#3d2208' },
      { letter: 'P', bg: '#9fb7e6', ink: '#13254a' },
      { letter: 'S', bg: '#d6a4d4', ink: '#3b1239' },
    ],
    acctList: [
      acct(),
      acct({
        id: 'a2',
        email: 'max@s2.test',
        letter: 'M',
        host: 'mail.s2.test',
        warn: true,
        checked: false,
        isDef: false,
      }),
    ],
    addMailAcct: () => {},
    manageMailAccts: () => {},
    closeSw: () => {},
    ...patch,
  };
}

describe('account switcher', () => {
  it('shows the menu with "All accounts", the accounts and the actions on desktop', async () => {
    const all = vi.fn();
    const pick = vi.fn();
    const addMailAcct = vi.fn();
    const manageMailAccts = vi.fn();
    const v = values({ addMailAcct, manageMailAccts });
    v.acctAll.onClick = all;
    v.acctList[1]!.onClick = pick;
    const { getByRole, getByText, queryByRole } = render(AccountSwitcher, v);
    const menu = getByRole('menu', { name: 'Switch email account' });
    expect(menu).toHaveAttribute('data-pop');
    expect(getByText('Email accounts')).toBeInTheDocument();
    expect(queryByRole('radiogroup')).toBeNull();

    const allRow = getByRole('menuitemradio', { name: /All accounts/ });
    expect(allRow).toHaveAttribute('aria-checked', 'false');
    expect(allRow).not.toHaveClass('on');
    // The first three tiles on desktop (`allT`).
    expect(within(allRow).getByText('A')).toBeInTheDocument();
    expect(within(allRow).getByText('P')).toBeInTheDocument();
    expect(within(allRow).queryByText('S')).toBeNull();
    await fireEvent.click(allRow);
    expect(all).toHaveBeenCalled();

    const first = getByRole('menuitemradio', { name: /account1@s1\.test/ });
    expect(first).toHaveAttribute('aria-checked', 'true');
    expect(first).toHaveClass('on');
    expect(within(first).queryByText('Sign-in required')).toBeNull();
    // No host and no "Default" on desktop.
    expect(within(first).queryByText('mail.s1.test')).toBeNull();
    expect(within(first).queryByText('Default')).toBeNull();
    const second = getByRole('menuitemradio', { name: /max@s2\.test/ });
    expect(second).toHaveAttribute('aria-checked', 'false');
    expect(within(second).getByText('Sign-in required')).toBeInTheDocument();
    await fireEvent.click(second);
    expect(pick).toHaveBeenCalled();

    await fireEvent.click(getByRole('menuitem', { name: 'Add account' }));
    expect(addMailAcct).toHaveBeenCalled();
    await fireEvent.click(getByRole('menuitem', { name: 'Manage accounts' }));
    expect(manageMailAccts).toHaveBeenCalled();
  });

  it('shows "All accounts" only with more than one account', () => {
    const { queryByRole, getAllByRole } = render(
      AccountSwitcher,
      values({ acctAll: { show: false, checked: false, n: '1 mailboxes', onClick: () => {} }, acctList: [acct()] }),
    );
    expect(queryByRole('menuitemradio', { name: /All accounts/ })).toBeNull();
    expect(getAllByRole('menuitemradio')).toHaveLength(1);
  });

  it('marks "All accounts" as selected', () => {
    const { getByRole } = render(
      AccountSwitcher,
      values({
        acctAll: { show: true, checked: true, n: '2 mailboxes', onClick: () => {} },
        acctList: [acct({ checked: false })],
      }),
    );
    expect(getByRole('menuitemradio', { name: /All accounts/ })).toHaveAttribute('aria-checked', 'true');
    expect(getByRole('menuitemradio', { name: /account1@s1\.test/ })).toHaveAttribute('aria-checked', 'false');
  });

  it('shows the accounts as a choice with host, default and actions on mobile', async () => {
    const closeSw = vi.fn();
    const addMailAcct = vi.fn();
    const manageMailAccts = vi.fn();
    const pick = vi.fn();
    const v = values({ isMobile: true, closeSw, addMailAcct, manageMailAccts });
    v.acctList[0]!.onClick = pick;
    const { getByRole, getByText, queryByRole } = render(AccountSwitcher, v);
    expect(queryByRole('menu')).toBeNull();
    expect(getByText('Switch account')).toBeInTheDocument();
    const group = getByRole('radiogroup', { name: 'Email account' });

    const allRow = within(group).getByRole('radio', { name: /All accounts/ });
    expect(allRow).toHaveAttribute('aria-checked', 'false');
    expect(within(allRow).getByText('4 mailboxes combined')).toBeInTheDocument();
    // Up to four tiles on mobile (`mSwAll.tiles`).
    expect(within(allRow).getByText('S')).toBeInTheDocument();

    const first = within(group).getByRole('radio', { name: /account1@s1\.test/ });
    expect(first).toHaveAttribute('aria-checked', 'true');
    expect(first).toHaveClass('on');
    expect(within(first).getByText('Default')).toBeInTheDocument();
    expect(within(first).getByText('mail.s1.test')).toBeInTheDocument();
    await fireEvent.click(first);
    expect(pick).toHaveBeenCalled();
    const second = within(group).getByRole('radio', { name: /max@s2\.test/ });
    expect(within(second).getByText('Sign-in required')).toBeInTheDocument();
    expect(within(second).queryByText('mail.s2.test')).toBeNull();
    expect(within(second).queryByText('Default')).toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Back to mailboxes' }));
    expect(closeSw).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Add account' }));
    expect(addMailAcct).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Manage' }));
    expect(manageMailAccts).toHaveBeenCalled();
  });
});
