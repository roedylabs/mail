import { fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import NameDialog from './NameDialog.svelte';
import type { NameDialogValues, NamePickOption, NameSwatch } from '#lib/state/folders.svelte.ts';

const opt = (key: string, label: string, depth: number, on = false, patch: Partial<NamePickOption> = {}) =>
  ({
    key,
    label,
    depth,
    icon: depth ? 'ti-folder' : 'ti-folders',
    dot: null,
    on,
    onClick: vi.fn(),
    ...patch,
  }) satisfies NamePickOption;

// Like `folders.values()` for "New folder" in an account with Projects › Website.
function values(patch: Partial<NameDialogValues> = {}): NameDialogValues {
  return {
    nameIsTag: false,
    nameTitle: 'New folder',
    nameSub: 'in account1@example.com',
    nameIcon: 'ti-folder-plus',
    nameTileBg: 'var(--acc)',
    nameTileInk: 'var(--accink)',
    nameVal: '',
    namePh: 'e.g. Projects',
    nameBtnLabel: 'Create',
    nameOk: false,
    namePickOpts: [
      opt('', 'Top level', 0, true),
      opt('f1', 'Projects', 1),
      opt('f2', 'Website', 2),
      opt('f3', 'Archive', 1),
    ],
    namePickLabel: 'Top level',
    namePickIcon: 'ti-folders',
    namePickOpen: false,
    nameSw: [],
    namePickToggle: vi.fn(),
    onNameInput: vi.fn(),
    nameCommit: vi.fn(),
    nameClose: vi.fn(),
    ...patch,
  };
}

const COLORS = [
  ['Apricot', '#f5a06e', '#3a1b06'],
  ['Sage', '#94c48d', '#13300f'],
  ['Lilac', '#b0a2f2', '#21134d'],
] as const;

// Tag variant: color "Sage" chosen, locations as tags with a color dot.
function tagValues(): NameDialogValues {
  return values({
    nameIsTag: true,
    nameTitle: 'New subtag',
    nameSub: 'For all email accounts',
    nameIcon: 'ti-tag',
    nameTileBg: '#94c48d',
    nameTileInk: '#13300f',
    namePh: 'e.g. Invoices',
    namePickOpts: [
      opt('', 'Top level', 0, false, { icon: 'ti-tags' }),
      opt('t1', 'Personal', 1, true, { icon: 'ti-tag', dot: '#f097ad' }),
    ],
    namePickLabel: 'Personal',
    namePickIcon: 'ti-tag',
    nameSw: COLORS.map(
      ([label, bg, ink], i) => ({ label, bg, ink, on: i === 1, onClick: vi.fn() }) satisfies NameSwatch,
    ),
  });
}

describe('name dialog', () => {
  it('shows the dialog with field and location on desktop', async () => {
    const v = values();
    const overlay = vi.fn();
    const { getByRole, getByText, queryByRole, container } = render(NameDialog, { ...v, isMobile: false, overlay });
    const dialog = getByRole('dialog', { name: 'New folder' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(getByText('in account1@example.com')).toHaveClass('sub');
    const tile = container.querySelector('.tile')!;
    expect(tile).toHaveAttribute('style', 'background: var(--acc); color: var(--accink);');
    expect(tile.querySelector('svg')).toHaveClass('tabler-icon-folder-plus');

    const field = getByRole('textbox', { name: 'Name' });
    expect(field).toHaveFocus();
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('placeholder', 'e.g. Projects');
    expect(field).toHaveAttribute('maxlength', '40');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(field).not.toHaveAttribute('enterkeyhint');

    expect(getByRole('button', { name: 'Location Top level' })).toHaveAttribute('aria-expanded', 'false');
    // No color picker without a tag.
    expect(queryByRole('radiogroup')).toBeNull();
    expect(container.querySelector('.colors')).toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Close' }));
    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(v.nameClose).toHaveBeenCalledTimes(2);
    await fireEvent.mouseDown(container.querySelector('.scrim')!);
    expect(overlay).toHaveBeenCalledOnce();
  });

  it('reports input and confirms with Enter', async () => {
    const v = values({ nameVal: 'Invoices', nameOk: true });
    const { getByRole } = render(NameDialog, { ...v, isMobile: false });
    const field = getByRole('textbox', { name: 'Name' });
    expect(field).toHaveValue('Invoices');
    await fireEvent.input(field, { target: { value: 'Invoices 2026' } });
    expect(v.onNameInput).toHaveBeenCalledWith('Invoices 2026');

    expect(await fireEvent.keyDown(field, { key: 'a' })).toBe(true);
    expect(v.nameCommit).not.toHaveBeenCalled();
    // Enter is not passed on (no form submission, no keyboard shortcut).
    expect(await fireEvent.keyDown(field, { key: 'Enter' })).toBe(false);
    expect(v.nameCommit).toHaveBeenCalledOnce();
  });

  it('disables "Create" without a name', async () => {
    const v = values();
    const { getByRole, rerender } = render(NameDialog, { ...v, isMobile: false });
    const ok = getByRole('button', { name: 'Create' });
    expect(ok).toHaveAttribute('aria-disabled', 'true');
    expect(ok).toHaveClass('off');
    await fireEvent.click(ok);
    expect(v.nameCommit).not.toHaveBeenCalled();

    await rerender({ nameOk: true, nameVal: 'Projects' });
    expect(ok).toHaveAttribute('aria-disabled', 'false');
    expect(ok).not.toHaveClass('off');
    await fireEvent.click(ok);
    expect(v.nameCommit).toHaveBeenCalledOnce();
  });

  it('labels editing', () => {
    const { getByRole, container } = render(NameDialog, {
      ...values({
        nameTitle: 'Edit folder',
        nameIcon: 'ti-folder-cog',
        nameBtnLabel: 'Save',
        nameVal: 'Website',
        nameOk: true,
        namePickLabel: 'Projects',
        namePickIcon: 'ti-folder',
      }),
      isMobile: false,
    });
    expect(getByRole('dialog', { name: 'Edit folder' })).toBeInTheDocument();
    expect(container.querySelector('.tile svg')).toHaveClass('tabler-icon-folder-cog');
    expect(getByRole('textbox', { name: 'Name' })).toHaveValue('Website');
    expect(getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'false');
    const pick = getByRole('button', { name: 'Location Projects' });
    expect(pick.querySelector('.pick-ic svg')).toHaveClass('tabler-icon-folder');
  });

  it('expands the picker "Location" and chooses a location', async () => {
    const v = values();
    const { getByRole, rerender, container } = render(NameDialog, { ...v, isMobile: false });
    const pick = getByRole('button', { name: 'Location Top level' });
    const fold = container.querySelector('.fold') as HTMLElement & { inert: boolean };
    // Collapsed outside the tab order (jsdom does not know `inert` as an attribute; Svelte sets the property).
    expect(fold).not.toHaveClass('open');
    expect(fold.inert).toBe(true);
    expect(container.querySelector('.chev')).not.toHaveClass('open');
    await fireEvent.click(pick);
    expect(v.namePickToggle).toHaveBeenCalledOnce();

    await rerender({ namePickOpen: true });
    expect(pick).toHaveAttribute('aria-expanded', 'true');
    expect(fold).toHaveClass('open');
    expect(fold.inert).toBe(false);
    expect(container.querySelector('.chev')).toHaveClass('open');
    const list = getByRole('listbox', { name: 'Location' });
    expect(pick).toHaveAttribute('aria-controls', list.id);
    const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map((o) => o.querySelector('.o-label')!.textContent)).toEqual([
      'Top level',
      'Projects',
      'Website',
      'Archive',
    ]);
    expect(options.map((o) => o.style.paddingLeft)).toEqual(['12px', '34px', '56px', '34px']);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false']);
    expect(options[0]).toHaveClass('on');
    expect(options[0]!.querySelector('.o-ic svg')).toHaveClass('tabler-icon-folders');
    expect(options[2]!.querySelector('.o-ic svg')).toHaveClass('tabler-icon-folder');
    expect(options[2]!.querySelector('.o-dot')).toBeNull();

    await fireEvent.click(getByRole('option', { name: 'Website' }));
    expect(v.namePickOpts[2]!.onClick).toHaveBeenCalledOnce();
  });

  it('shows color picker and color dots for tags', async () => {
    const v = tagValues();
    const { getByRole, getAllByRole, getByText, container } = render(NameDialog, {
      ...v,
      namePickOpen: true,
      isMobile: false,
    });
    expect(getByRole('dialog', { name: 'New subtag' })).toBeInTheDocument();
    expect(getByText('For all email accounts')).toBeInTheDocument();
    expect(container.querySelector('.tile')).toHaveAttribute(
      'style',
      'background: rgb(148, 196, 141); color: rgb(19, 48, 15);',
    );
    expect(getByRole('textbox', { name: 'Name' })).toHaveAttribute('placeholder', 'e.g. Invoices');
    expect(getByText('Color')).toHaveClass('lbl');

    const personal = getByRole('option', { name: 'Personal' });
    expect(personal.querySelector('.o-ic')).toBeNull();
    expect(personal.querySelector('.o-dot')).toHaveStyle({ color: '#f097ad' });
    expect(personal.querySelector('.o-dot svg')).toHaveClass('tabler-icon-tag');
    expect(getByRole('option', { name: 'Top level' }).querySelector('.o-ic svg')).toHaveClass('tabler-icon-tags');

    const group = getByRole('radiogroup', { name: 'Color' });
    const radios = getAllByRole('radio');
    expect(group).toContainElement(radios[0]!);
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Apricot', 'Sage', 'Lilac']);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(radios[1]).toHaveClass('on');
    expect(radios[0]).not.toHaveClass('on');
    expect(radios[0]).toHaveAttribute('style', '--sw: #f5a06e; color: rgb(58, 27, 6);');

    await fireEvent.click(getByRole('radio', { name: 'Lilac' }));
    expect(v.nameSw[2]!.onClick).toHaveBeenCalledOnce();
  });

  it('returns focus on close', () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const { getByRole, unmount } = render(NameDialog, { ...values(), isMobile: false });
    expect(getByRole('textbox', { name: 'Name' })).toHaveFocus();
    unmount();
    expect(before).toHaveFocus();
    before.remove();
  });

  it('shows only the content for the sheet on mobile', async () => {
    const v = tagValues();
    const { queryByRole, getByRole, getByText, container } = render(NameDialog, { ...v, isMobile: true });
    expect(queryByRole('dialog')).toBeNull();
    expect(container.querySelector('.scrim')).toBeNull();
    expect(getByText('New subtag')).toHaveClass('title');
    expect(container.querySelector('.head')).toHaveClass('m');
    expect(container.querySelector('.body')).toHaveClass('m');
    // Without own headings: "Location" sits in the button, "Color" only for screen readers.
    expect(container.querySelector('.lbl')).toBeNull();
    expect(getByRole('radiogroup', { name: 'Color' })).toHaveClass('m');

    const field = getByRole('textbox', { name: 'Name' });
    expect(field).toHaveAttribute('enterkeyhint', 'done');
    // Only after the sheet's focus (its effect runs after this one).
    await tick();
    expect(field).toHaveFocus();

    const pick = getByRole('button', { name: 'Location Personal' });
    expect(pick.querySelector('.pick-lbl')).toHaveTextContent('Location');
    expect(container.querySelector('.opts')).toHaveClass('no-scrollbar');

    await fireEvent.click(getByRole('button', { name: 'Close' }));
    await fireEvent.click(getByRole('button', { name: 'Cancel' }));
    expect(v.nameClose).toHaveBeenCalledTimes(2);
    await fireEvent.click(getByRole('button', { name: 'Create' }));
    expect(v.nameCommit).not.toHaveBeenCalled();
  });
});
