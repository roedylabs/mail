import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AccountMenu from './AccountMenu.svelte';
import { hideTooltip, TIP_DELAY, TIP_FADE } from '#lib/actions/tooltip.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import type { AccountMenuValues } from '#lib/shell.ts';

async function tipOf(el: Element): Promise<string | undefined> {
  vi.useFakeTimers();
  await fireEvent.pointerEnter(el, { pointerType: 'mouse' });
  vi.advanceTimersByTime(TIP_DELAY);
  const text = ui.tip?.text;
  await fireEvent.pointerLeave(el, { pointerType: 'mouse' });
  vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);
  vi.useRealTimers();
  return text;
}

afterEach(() => {
  hideTooltip();
  ui.reset();
  vi.useRealTimers();
});

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
      {
        id: 'system',
        code: '',
        name: 'System',
        sub: 'Browser: English',
        label: 'System – Browser: English',
        on: false,
        onClick: () => {},
      },
      { id: 'de', code: 'DE', name: 'Deutsch', sub: 'German', label: 'DE Deutsch', on: true, onClick: () => {} },
      { id: 'en', code: 'EN', name: 'English', sub: '', label: 'EN English', on: false, onClick: () => {} },
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
    v.langSeg[2]!.onClick = english;
    const system = vi.fn();
    v.langSeg[0]!.onClick = system;
    const { getAllByRole, getByRole, getByText, queryByRole } = render(AccountMenu, { ...v, id: 'account-pop' });
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
    expect(getByRole('radio', { name: 'DE Deutsch' })).toBeChecked();
    await fireEvent.click(en);
    expect(english).toHaveBeenCalled();
    // "System" first, icon only: named with the browser's language, no `lang` of its own.
    const radios = getAllByRole('radio').slice(2);
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'System – Browser: English',
      'DE Deutsch',
      'EN English',
    ]);
    expect(radios[0]).toHaveTextContent('');
    expect(radios[0]!.querySelector('.tabler-icon-world')).not.toBeNull();
    expect(await tipOf(radios[0]!)).toBe('System');
    expect(radios[0]).not.toHaveAttribute('lang');
    expect(radios[0]).not.toBeChecked();
    await fireEvent.click(radios[0]!);
    expect(system).toHaveBeenCalled();
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
