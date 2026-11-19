import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HexColor } from '#lib/color.ts';
import ColorEditor from './ColorEditor.svelte';

afterEach(() => {
  vi.useRealTimers();
});

/** Opens the editor and waits until it has taken the focus. */
async function open(start: HexColor = '#f5a06e', sheet = false) {
  const onapply = vi.fn<(hex: HexColor) => void>();
  const onclose = vi.fn();
  const view = render(ColorEditor, { start, sheet, onapply, onclose });
  const dialog = view.getByRole('dialog', { name: 'More colors' });
  const field = view.getByLabelText('Or your own hex code');
  await vi.waitFor(() => expect(dialog).toHaveFocus());
  return { view, dialog, field, onapply, onclose };
}

describe('ColorEditor', () => {
  it('takes the focus and shows 18 colours as a radio group with one tab stop', async () => {
    const { dialog, field } = await open();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const radios = within(within(dialog).getByRole('radiogroup', { name: 'More colors' })).getAllByRole('radio');
    expect(radios).toHaveLength(18);
    // The start colour is no preset: none checked, the first one is the tab stop.
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(0);
    expect(radios.map((r) => r.tabIndex).filter((t) => t === 0)).toHaveLength(1);
    expect(radios[0]).toHaveAttribute('tabindex', '0');
    expect(field).toHaveValue('#F5A06E');
  });

  it('moves and selects with the arrows, Home and End', async () => {
    const { dialog, field } = await open('#f08a7e');
    const radio = (name: string) => within(dialog).getByRole('radio', { name });
    expect(radio('Coral')).toHaveAttribute('aria-checked', 'true');
    radio('Coral').focus();
    await fireEvent.keyDown(radio('Coral'), { key: 'ArrowRight' });
    expect(radio('Honey')).toHaveFocus();
    expect(radio('Honey')).toHaveAttribute('aria-checked', 'true');
    expect(field).toHaveValue('#ECB655');
    await fireEvent.keyDown(radio('Honey'), { key: 'ArrowDown' });
    expect(radio('Cornflower')).toHaveAttribute('aria-checked', 'true');
    await fireEvent.keyDown(radio('Cornflower'), { key: 'End' });
    expect(radio('Pebble')).toHaveFocus();
    await fireEvent.keyDown(radio('Pebble'), { key: 'Home' });
    expect(radio('Coral')).toHaveAttribute('aria-checked', 'true');
  });

  it('validates the hex code once the field is left and keeps the message line', async () => {
    const { view, dialog, field, onapply } = await open();
    const apply = within(dialog).getByRole('button', { name: 'Apply' });
    await fireEvent.input(field, { target: { value: 'xyz' } });
    expect(apply).toHaveAttribute('aria-disabled', 'true');
    expect(view.queryByText('Enter a hex code like #F5A06E.')).toBeNull();
    await fireEvent.blur(field);
    expect(view.getByText('Enter a hex code like #F5A06E.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Enter a hex code like #F5A06E.');
    // "Apply" with an invalid code: the error and the field, nothing applied.
    await fireEvent.click(apply);
    expect(onapply).not.toHaveBeenCalled();
    expect(field).toHaveFocus();
    await fireEvent.input(field, { target: { value: '#333' } });
    expect(view.getByText('Barely visible in the dark theme.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'false');
    await fireEvent.input(field, { target: { value: '#fafafa' } });
    expect(view.getByText('Barely visible in the light theme.')).toBeInTheDocument();
  });

  it('applies the normalised colour with Enter in the field or "Apply"', async () => {
    const { dialog, field, onapply } = await open();
    await fireEvent.input(field, { target: { value: '4A7BD0' } });
    await fireEvent.keyDown(field, { key: 'Enter' });
    expect(onapply).toHaveBeenLastCalledWith('#4a7bd0');
    await fireEvent.click(within(dialog).getByRole('radio', { name: 'Mint' }));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Apply' }));
    expect(onapply).toHaveBeenLastCalledWith('#78c895');
  });

  it('closes with Escape, "Close", "Cancel" and on the backdrop', async () => {
    const { view, dialog, onclose } = await open();
    await fireEvent.keyDown(dialog, { key: 'Escape' });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    const scrim = view.container.querySelector('[data-scrim]');
    if (!scrim) throw new Error('no backdrop');
    await fireEvent.mouseDown(scrim);
    expect(onclose).toHaveBeenCalledTimes(4);
  });

  it('keeps Tab inside', async () => {
    const { dialog } = await open();
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const apply = within(dialog).getByRole('button', { name: 'Apply' });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    apply.focus();
    await fireEvent.keyDown(apply, { key: 'Tab' });
    expect(close).toHaveFocus();
    await fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(apply).toHaveFocus();
    expect(cancel).toBeInTheDocument();
  });

  it('is a bottom sheet with a grip on mobile', async () => {
    const { view, dialog } = await open('#f5a06e', true);
    expect(dialog).toHaveClass('sheet');
    expect(view.container.querySelector('.grip')).not.toBeNull();
    expect(view.container.querySelector('[data-scrim]')).toHaveClass('sheet');
  });
});
