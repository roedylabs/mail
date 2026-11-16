import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AppsMenu from './AppsMenu.svelte';
import type { AppsMenuValues } from '#lib/shell.ts';

function values(patch: Partial<AppsMenuValues> = {}): AppsMenuValues {
  return {
    isMobile: false,
    logo: { isMark: true },
    appSoonCal: () => {},
    appSoonCon: () => {},
    closeMenus: () => {},
    closeSheet: () => {},
    ...patch,
  };
}

describe('apps', () => {
  it('offers Mail, Calendar and Contacts follow', async () => {
    const closeMenus = vi.fn();
    const appSoonCal = vi.fn();
    const appSoonCon = vi.fn();
    const { getByRole } = render(AppsMenu, values({ closeMenus, appSoonCal, appSoonCon }));
    expect(getByRole('menu', { name: 'Apps' })).toHaveAttribute('data-pop');
    await fireEvent.click(getByRole('menuitem', { name: 'Mail' }));
    expect(closeMenus).toHaveBeenCalled();
    const calendar = getByRole('menuitem', { name: 'Calendar' });
    expect(calendar).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.click(calendar);
    expect(appSoonCal).toHaveBeenCalled();
    await fireEvent.click(getByRole('menuitem', { name: 'Contacts' }));
    expect(appSoonCon).toHaveBeenCalled();
  });

  it('closes the sheet on mobile', async () => {
    const closeSheet = vi.fn();
    const { getByRole, queryByRole } = render(AppsMenu, values({ isMobile: true, closeSheet }));
    expect(queryByRole('menu')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Mail' }));
    expect(closeSheet).toHaveBeenCalled();
  });
});
