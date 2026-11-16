import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AccountMenu from './AccountMenu.svelte';
import type { AccountMenuValues } from '#lib/shell.ts';

function values(patch: Partial<AccountMenuValues> = {}): AccountMenuValues {
  return {
    isMobile: false,
    initials: 'JD',
    userName: 'Doe, Jane',
    userEmail: 'jane@example.com',
    modeSeg: [
      { label: 'Light', icon: 'ti-sun', on: false, onClick: () => {} },
      { label: 'Dark', icon: 'ti-moon', on: true, onClick: () => {} },
    ],
    langSeg: [
      { id: 'de', code: 'DE', name: 'German', sub: '', on: true, onClick: () => {} },
      { id: 'en', code: 'EN', name: 'English', sub: 'English', on: false, onClick: () => {} },
    ],
    openAccountSettings: () => {},
    logout: () => {},
    ...patch,
  };
}

describe('account menu', () => {
  it('shows account, theme, language and sign-out', async () => {
    const light = vi.fn();
    const logout = vi.fn();
    const openAccountSettings = vi.fn();
    const v = values({ logout, openAccountSettings });
    v.modeSeg[0]!.onClick = light;
    const english = vi.fn();
    v.langSeg[1]!.onClick = english;
    const { getByRole, getByText, queryByRole } = render(AccountMenu, { ...v, id: 'account-pop' });
    // Named group behind the avatar instead of `role="menu"` (disclosure pattern).
    const pop = getByRole('group', { name: 'Doe, Jane' });
    expect(pop).toHaveAttribute('data-pop');
    expect(pop).toHaveAttribute('id', 'account-pop');
    expect(queryByRole('menu')).toBeNull();
    expect(queryByRole('menuitem')).toBeNull();
    expect(getByText('Doe, Jane')).toBeInTheDocument();
    expect(getByText('jane@example.com')).toBeInTheDocument();
    expect(getByRole('radio', { name: 'Dark' })).toBeChecked();
    await fireEvent.click(getByRole('radio', { name: 'Light' }));
    expect(light).toHaveBeenCalled();
    // Name from the visible abbreviation and the language name (WCAG 2.5.3), in its own language (WCAG 3.1.2).
    const en = getByRole('radio', { name: 'EN English' });
    expect(en).toHaveTextContent('EN');
    expect(en).toHaveAttribute('lang', 'en');
    expect(en).not.toBeChecked();
    expect(getByRole('radio', { name: 'DE German' })).toBeChecked();
    await fireEvent.click(en);
    expect(english).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Manage account' }));
    expect(openAccountSettings).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Sign out' }));
    expect(logout).toHaveBeenCalled();
  });

  it('shows the content without a popover on mobile', () => {
    const { queryByRole, getByRole } = render(AccountMenu, values({ isMobile: true }));
    expect(queryByRole('group', { name: 'Doe, Jane' })).toBeNull();
    expect(getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
});
