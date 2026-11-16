import { fireEvent, render, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { AccountPickerValues, PickerAccount } from '#lib/mail-account.svelte.ts';
import AccountPicker from './AccountPicker.svelte';

function acct(patch: Partial<PickerAccount> = {}): PickerAccount {
  return {
    id: 'a1',
    email: 'account1@s1.test',
    host: 'mail.s1.test',
    letter: 'A',
    tileBg: '#94c48d',
    tileInk: '#13300f',
    isDef: true,
    ok: true,
    warn: false,
    checked: true,
    onClick: () => {},
    ...patch,
  };
}

function values(patch: Partial<AccountPickerValues> = {}): AccountPickerValues {
  return {
    isMobile: false,
    maSwList: [
      acct(),
      acct({
        id: 'a2',
        email: 'alex@s2.test',
        host: 'mail.s2.test',
        letter: 'M',
        isDef: false,
        ok: false,
        warn: true,
        checked: false,
      }),
    ],
    maSwAdd: () => {},
    maSwManage: () => {},
    closeSheet: () => {},
    ...patch,
  };
}

describe('account picker', () => {
  it('shows the menu with the accounts and the actions on desktop', async () => {
    const pick = vi.fn();
    const maSwAdd = vi.fn();
    const maSwManage = vi.fn();
    const v = values({ maSwAdd, maSwManage });
    v.maSwList[1]!.onClick = pick;
    const { getByRole, getByText, queryByRole, getAllByRole } = render(AccountPicker, v);
    const menu = getByRole('menu', { name: 'Switch email account' });
    expect(menu).toHaveAttribute('data-pop');
    expect(getByText('Email accounts')).toBeInTheDocument();
    expect(queryByRole('radiogroup')).toBeNull();
    expect(getAllByRole('menuitemradio')).toHaveLength(2);

    const first = getByRole('menuitemradio', { name: /account1@s1\.test/ });
    expect(first).toHaveAttribute('aria-checked', 'true');
    expect(first).toHaveClass('on');
    expect(within(first).getByText('A')).toHaveStyle({ backgroundColor: '#94c48d', color: '#13300f' });
    expect(within(first).queryByText('Sign-in required')).toBeNull();
    // No host and no "Default" on desktop.
    expect(within(first).queryByText('mail.s1.test')).toBeNull();
    expect(within(first).queryByText('Default')).toBeNull();

    const second = getByRole('menuitemradio', { name: /alex@s2\.test/ });
    expect(second).toHaveAttribute('aria-checked', 'false');
    expect(second).not.toHaveClass('on');
    expect(within(second).getByText('Sign-in required')).toBeInTheDocument();
    await fireEvent.click(second);
    expect(pick).toHaveBeenCalled();

    await fireEvent.click(getByRole('menuitem', { name: 'Add account' }));
    expect(maSwAdd).toHaveBeenCalled();
    await fireEvent.click(getByRole('menuitem', { name: 'View all accounts' }));
    expect(maSwManage).toHaveBeenCalled();
  });

  it('shows the accounts as a choice with host, default and actions on mobile', async () => {
    const closeSheet = vi.fn();
    const maSwAdd = vi.fn();
    const maSwManage = vi.fn();
    const pick = vi.fn();
    const v = values({ isMobile: true, closeSheet, maSwAdd, maSwManage });
    v.maSwList[0]!.onClick = pick;
    const { getByRole, getByText, queryByRole } = render(AccountPicker, v);
    expect(queryByRole('menu')).toBeNull();
    expect(getByText('Switch account')).toBeInTheDocument();
    const group = getByRole('radiogroup', { name: 'Email account' });

    const first = within(group).getByRole('radio', { name: /account1@s1\.test/ });
    expect(first).toHaveAttribute('aria-checked', 'true');
    expect(first).toHaveClass('on');
    expect(within(first).getByText('Default')).toBeInTheDocument();
    expect(within(first).getByText('mail.s1.test')).toBeInTheDocument();
    expect(within(first).queryByText('Sign-in required')).toBeNull();
    await fireEvent.click(first);
    expect(pick).toHaveBeenCalled();

    const second = within(group).getByRole('radio', { name: /alex@s2\.test/ });
    expect(second).toHaveAttribute('aria-checked', 'false');
    expect(within(second).getByText('Sign-in required')).toBeInTheDocument();
    expect(within(second).queryByText('mail.s2.test')).toBeNull();
    expect(within(second).queryByText('Default')).toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(closeSheet).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Add account' }));
    expect(maSwAdd).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'All accounts' }));
    expect(maSwManage).toHaveBeenCalled();
  });
});
