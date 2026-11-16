import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideTooltip, TIP_DELAY, TIP_FADE } from '#lib/actions/tooltip.ts';
import { moveValues, type MoveTargets, type MoveValues } from '#lib/message-view.ts';
import type { FolderNode } from '#lib/state/mailboxes.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import MoveDialog from './MoveDialog.svelte';

const folder = (id: string, name: string, children: FolderNode[] = []): FolderNode => ({
  id,
  name,
  children,
  unread: 0,
  total: 0,
});

/** Inbox (where the emails are), Archive with 2025, Projects. */
const TARGETS: MoveTargets = {
  inbox: 'in',
  folders: [folder('a', 'Archive', [folder('a1', '2025')]), folder('p', 'Projects')],
  on: (box) => box === 'in',
};

function setup(props: { mvp?: MoveValues; isMobile?: boolean; focusFirst?: boolean } = {}) {
  const fns = { onPick: vi.fn(), onClose: vi.fn(), onBack: vi.fn() };
  const mvp = props.mvp ?? moveValues('Sharing home page by Friday?', TARGETS, false);
  const view = render(MoveDialog, { mvp, isMobile: false, ...fns, ...props });
  const items = () => view.getAllByRole('menuitem');
  return { view, items, mvp, ...fns };
}

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

describe('MoveDialog', () => {
  it('shows title, subject and the targets with indent, divider and check marks on desktop', async () => {
    const { view, items } = setup();
    const dialog = view.getByRole('dialog', { name: 'Move to' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('data-pop', '1');
    expect(within(dialog).getByText('Sharing home page by Friday?')).toHaveClass('sub');
    const menu = within(dialog).getByRole('menu', { name: 'Move to' });
    expect(items().map((b) => b.textContent)).toEqual(['Inbox', 'Archive', '2025', 'Projects']);
    const [inbox, archive, y2025, projects] = items();
    expect(inbox).toHaveAttribute('aria-disabled', 'true');
    expect(inbox).toHaveStyle({ paddingLeft: '14px', cursor: 'default' });
    expect(inbox!.getAttribute('style')).toContain('color: var(--mfg)');
    expect(inbox!.querySelector('.tabler-icon-inbox')).not.toBeNull();
    expect(inbox!.querySelector('.o-ck')).toHaveStyle({ opacity: '1' });
    expect(archive).toHaveAttribute('aria-disabled', 'false');
    expect(archive).toHaveStyle({ paddingLeft: '14px', cursor: 'pointer' });
    expect(archive!.getAttribute('style')).toContain('color: var(--fg)');
    expect(archive!.querySelector('.tabler-icon-folder')).not.toBeNull();
    expect(archive!.querySelector('.o-ck')).toHaveStyle({ opacity: '0' });
    expect(y2025).toHaveStyle({ paddingLeft: '32px' });
    expect(projects).toHaveStyle({ paddingLeft: '14px' });
    // Divider only before the first top-level folder
    const seps = menu.querySelectorAll('[role="separator"]');
    expect(seps).toHaveLength(1);
    expect(seps[0]!.nextElementSibling).toBe(archive);
    // Focus on the first selectable target
    expect(document.activeElement).toBe(archive);
    expect(await tipOf(view.getByRole('button', { name: 'Close' }))).toBe('Close (Esc)');
  });

  it('reports the chosen target, also the disabled one (the route skips it)', async () => {
    const { view, onPick } = setup();
    await fireEvent.click(view.getByRole('menuitem', { name: 'Inbox' }));
    await fireEvent.click(view.getByRole('menuitem', { name: '2025' }));
    expect(onPick.mock.calls).toEqual([
      [expect.objectContaining({ id: 'in', dis: 'true' })],
      [expect.objectContaining({ id: 'a1', label: '2025', dis: 'false' })],
    ]);
  });

  it('closes via button and click on the backdrop, not via click in the dialog', async () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const { view, onClose } = setup();
    expect(document.activeElement).not.toBe(before);
    await fireEvent.mouseDown(view.getByRole('dialog'));
    await fireEvent.mouseDown(view.getByRole('menuitem', { name: 'Archive' }));
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.mouseDown(view.getByRole('presentation'));
    expect(onClose).toHaveBeenCalledOnce();
    await fireEvent.click(view.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(2);
    // No back on desktop
    expect(view.queryByRole('button', { name: 'Back' })).toBeNull();
    view.unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('focuses the dialog instead of a target after the swipe gesture (`focusFirst`)', () => {
    const { view } = setup({ focusFirst: false });
    expect(document.activeElement).toBe(view.getByRole('dialog'));
  });

  it('focuses the first one without a selectable target', () => {
    const mvp = moveValues('Subject', { inbox: 'in', folders: [], on: () => true }, false);
    const { items } = setup({ mvp });
    expect(document.activeElement).toBe(items()[0]);
  });

  it('shows the sheet content with back, title and close on mobile', async () => {
    const mvp = moveValues('Sharing home page by Friday?', TARGETS, true);
    const { view, items, onBack, onClose, onPick } = setup({ mvp, isMobile: true });
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.queryByRole('presentation')).toBeNull();
    expect(view.getByText('Move to', { selector: '.m-title' })).toBeInTheDocument();
    // Only the desktop shows the subject.
    expect(view.queryByText('Sharing home page by Friday?')).toBeNull();
    expect(view.container.querySelector('.m-gap')).toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(view.getByRole('menu', { name: 'Move to' })).toBeInTheDocument();
    expect(items()).toHaveLength(4);
    expect(items()[2]).toHaveStyle({ paddingLeft: '32px' });
    expect(view.container.querySelectorAll('.sep.m')).toHaveLength(1);

    const back = view.getByRole('button', { name: 'Back' });
    expect(back.querySelector('.tabler-icon-chevron-left')).not.toBeNull();
    await fireEvent.click(back);
    expect(onBack).toHaveBeenCalledOnce();
    await fireEvent.click(view.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledOnce();
    await fireEvent.click(view.getByRole('menuitem', { name: 'Projects' }));
    expect(onPick).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'p' }));
  });

  it('shows a narrow gap before the title without back on mobile', () => {
    const { view } = setup({ isMobile: true });
    expect(view.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(view.container.querySelector('.m-gap')).not.toBeNull();
  });
});
