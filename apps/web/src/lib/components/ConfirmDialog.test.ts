import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import ConfirmDialog from './ConfirmDialog.svelte';
import { confirmValues, type ConfirmDialogValues } from '#lib/shell.ts';

function values(patch: Partial<ConfirmDialogValues> = {}): ConfirmDialogValues {
  return {
    isMobile: false,
    cf: confirmValues(
      { title: 'Delete folder Projects?', text: 'The folder is empty.', danger: true, ok: 'Delete folder' },
      true,
      m.confirm_ok(),
    ),
    confirmIn: '',
    onConfirmIn: () => {},
    confirmKey: () => {},
    confirmOk: () => {},
    confirmCancel: () => {},
    onConfirmOverlay: () => {},
    ...patch,
  };
}

describe('confirmation', () => {
  it('derives `cf` from the request', () => {
    expect(confirmValues({ title: 'T', text: 'X' }, true, m.confirm_ok())).toEqual({
      title: 'T',
      text: 'X',
      icon: 'ti-help-circle',
      ok: m.confirm_ok(),
      hasCancel: true,
      hasWord: false,
      word: '',
      danger: false,
      okDis: false,
    });
    expect(
      confirmValues({ title: 'T', text: 'X', word: 'DELETE', noCancel: true }, false, m.confirm_ok()),
    ).toMatchObject({
      hasWord: true,
      word: 'DELETE',
      hasCancel: false,
      okDis: true,
    });
  });

  it('asks and focuses the button', async () => {
    const confirmOk = vi.fn();
    const confirmCancel = vi.fn();
    const { getByRole } = render(ConfirmDialog, values({ confirmOk, confirmCancel }));
    const dialog = getByRole('alertdialog', { name: 'Delete folder Projects?' });
    expect(dialog).toHaveAccessibleDescription('The folder is empty.');
    expect(getByRole('button', { name: 'Delete folder' })).toHaveFocus();
    await fireEvent.click(getByRole('button', { name: 'Delete folder' }));
    expect(confirmOk).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: m.confirm_cancel() }));
    expect(confirmCancel).toHaveBeenCalled();
  });

  it('requires the confirmation word', async () => {
    const onConfirmIn = vi.fn();
    const cf = confirmValues(
      { title: 'Delete account?', text: 'This is final.', word: 'DELETE' },
      false,
      m.confirm_ok(),
    );
    const { getByRole, getByText } = render(ConfirmDialog, values({ cf, onConfirmIn }));
    expect(getByText(m.confirm_word({ word: 'DELETE' }))).toBeInTheDocument();
    const input = getByRole('textbox', { name: m.confirm_word_label() });
    expect(input).toHaveFocus();
    await fireEvent.input(input, { target: { value: 'del' } });
    expect(onConfirmIn).toHaveBeenCalled();
    expect(getByRole('button', { name: m.confirm_ok() })).toHaveAttribute('aria-disabled', 'true');
  });
});
