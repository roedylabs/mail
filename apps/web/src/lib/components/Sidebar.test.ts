import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import Sidebar from './Sidebar.svelte';
import { sidebarDerived, type SidebarInput, type SidebarRow } from '#lib/shell.ts';

const LABELS = { mail: 'Mailboxes', folders: 'Folders', tags: 'Tags' };
const TEXTS = { compose: 'New email (C)', folder: 'New folder', tag: 'New tag' };

function row(label: string, on: boolean, onClick = () => {}): SidebarRow {
  return {
    id: `m1:${label}`,
    label,
    icon: 'ti-inbox',
    on,
    fw: on ? 800 : 600,
    shadow: on ? 'var(--sh1)' : 'none',
    hasCnt: true,
    cntU: '4',
    cntN: '15',
    cntLabel: '4 unread of 15',
    tip: undefined,
    onClick,
  };
}

function input(patch: Partial<SidebarInput> = {}): SidebarInput & { collapsed: boolean } {
  return {
    wide: true,
    collapsed: false,
    hidden: false,
    sbTab: 'mail',
    navRows: [row('Inbox', true)],
    acctSw: {
      email: 'account1@s1.test',
      isAll: false,
      letter: 'A',
      open: false,
      sub: 'account1@s1.test',
      tip: undefined,
      title: 'Julian Schubert',
      warn: false,
      tileBg: '#94c48d',
      tileInk: '#13300f',
    },
    acctSwOpen: false,
    allT2: [],
    addFShow: true,
    ...patch,
  };
}

describe('sidebar', () => {
  it('derives tabs and tooltips from the sidebar state', () => {
    const wide = sidebarDerived({ wide: true, hidden: false, sbTab: 'mail' }, LABELS, TEXTS);
    expect(wide.rtTabs.map((t) => [t.label, t.icon, t.on, t.gap, t.tip])).toEqual([
      ['Mailboxes', 'ti-inbox', true, '7px', undefined],
      ['Folders', 'ti-folders', false, '0px', 'Folders'],
      ['Tags', 'ti-tags', false, '0px', 'Tags'],
    ]);
    expect(wide.rtCols).toBe('minmax(0,4fr) minmax(0,1fr) minmax(0,1fr)');
    expect(wide).toMatchObject({ labelOp: 1, cmpTip: undefined, rtG: '1', sbVis: 'visible', sbVisDelay: '0s' });
    expect(wide.rtPm).toEqual({ hidden: false, vis: 'visible', visDelay: '0s' });
    expect(wide.rtPf.hidden).toBe(true);

    const narrow = sidebarDerived({ wide: false, hidden: true, sbTab: 'tags' }, LABELS, TEXTS);
    expect(narrow).toMatchObject({
      labelOp: 0,
      cmpTip: 'New email (C)',
      addFTip: 'New folder',
      addTTip: 'New tag',
      rtCols: 'minmax(0,1fr)',
      rtG: undefined,
      sbVis: 'hidden',
    });
    expect(narrow.rtTabs[2]).toMatchObject({ on: true, tip: 'Tags' });
    expect(narrow.rtPt.hidden).toBe(false);
  });

  it('shows mailboxes with counters and the account switch', async () => {
    const onClick = vi.fn();
    const { getByRole, getAllByLabelText, getByText } = render(
      Sidebar,
      input({ navRows: [row('Inbox', true, onClick), row('Sent', false)] }),
    );
    expect(getByRole('button', { name: 'New email' })).toBeInTheDocument();
    expect(getByRole('tab', { name: 'Mailboxes' })).toHaveAttribute('aria-selected', 'true');
    expect(getAllByLabelText('4 unread of 15')).toHaveLength(2);
    await fireEvent.click(getByText('Inbox'));
    expect(onClick).toHaveBeenCalled();
    expect(getByText('Julian Schubert')).toBeInTheDocument();
    expect(getByText('account1@s1.test')).toBeInTheDocument();
  });

  it('switches the tab via onTab', async () => {
    const onTab = vi.fn();
    const { getByRole } = render(Sidebar, { ...input(), onTab });
    await fireEvent.click(getByRole('tab', { name: 'Tags' }));
    expect(onTab).toHaveBeenCalledWith('tags');
  });

  it('has one tab stop and switches the tabs with the arrow keys', async () => {
    const onTab = vi.fn();
    const { getByRole } = render(Sidebar, { ...input(), onTab });
    const mail = getByRole('tab', { name: 'Mailboxes' });
    expect(mail).toHaveAttribute('tabindex', '0');
    expect(getByRole('tab', { name: 'Folders' })).toHaveAttribute('tabindex', '-1');
    expect(getByRole('tab', { name: 'Tags' })).toHaveAttribute('tabindex', '-1');
    mail.focus();
    await fireEvent.keyDown(mail, { key: 'ArrowRight' });
    expect(getByRole('tab', { name: 'Folders' })).toHaveFocus();
    expect(onTab).toHaveBeenLastCalledWith('folders');
    await fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(onTab).toHaveBeenLastCalledWith('tags');
  });

  it('hides without a mail account', () => {
    const { container } = render(Sidebar, input({ hidden: true, navRows: [] }));
    expect(container.querySelector('nav')).toHaveClass('hidden');
    expect(container.querySelector('nav')).toHaveStyle({ visibility: 'hidden' });
  });
});
