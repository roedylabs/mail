import { fireEvent, render, screen } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DirtyBar from './DirtyBar.svelte';
import { toastLift } from '#lib/toast-lift.svelte.ts';

function setup(props: Partial<ComponentProps<typeof DirtyBar>> = {}) {
  const onDiscard = vi.fn();
  const onSave = vi.fn();
  const view = render(DirtyBar, { onDiscard, onSave, ...props });
  const bar = screen.getByRole('region', { name: 'Unsaved changes' });
  const discard = screen.getByRole('button', { name: 'Discard' });
  const save = bar.querySelector<HTMLButtonElement>('.dirty-save')!;
  return { ...view, bar, discard, save, onDiscard, onSave };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DirtyBar', () => {
  it('shows text, "Discard" and "Save" from one text set on desktop and calls the actions', async () => {
    const { bar, discard, save, onDiscard, onSave } = setup();
    expect(bar).toHaveClass('dirty');
    expect(bar).not.toHaveClass('mobile');
    expect(bar.querySelector('.dirty-text')).toHaveTextContent('Unsaved changes');
    expect(save).toHaveTextContent('Save');
    await fireEvent.click(discard);
    expect(onDiscard).toHaveBeenCalledOnce();
    await fireEvent.click(save);
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('shows a different text, the region name stays', () => {
    const { bar } = setup({ text: 'Unsaved changes to the active banner' });
    expect(bar).toHaveAccessibleName('Unsaved changes');
    expect(bar.querySelector('.dirty-text')).toHaveTextContent('Unsaved changes to the active banner');
  });

  it('leaves out the text on mobile', () => {
    const { bar } = setup({ isMobile: true });
    expect(bar).toHaveClass('mobile');
    expect(bar.querySelector('.dirty-text')).toBeNull();
  });

  it('has neither `aria-busy` nor `aria-disabled` without `saving`', () => {
    const { discard, save } = setup();
    expect(save).not.toHaveAttribute('aria-busy');
    expect(save).not.toHaveAttribute('aria-disabled');
    expect(discard).not.toHaveAttribute('aria-disabled');
  });

  it('shows the spinner and "Saving …" while saving', async () => {
    const { discard, save, rerender } = setup({ saving: false });
    expect(save).toHaveAttribute('aria-busy', 'false');
    expect(save).toHaveAttribute('aria-disabled', 'false');
    expect(discard).toHaveAttribute('aria-disabled', 'false');
    expect(save.querySelector('.spin')).toBeNull();

    await rerender({ saving: true });
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(discard).toHaveAttribute('aria-disabled', 'true');
    expect(save.querySelector('.spin')).not.toBeNull();
    expect(save).toHaveTextContent('Saving …');
  });

  it('triggers neither "Discard" nor "Save" while saving', async () => {
    const { discard, save, onDiscard, onSave, rerender } = setup({ saving: true });
    await fireEvent.click(discard);
    await fireEvent.click(save);
    expect(onDiscard).not.toHaveBeenCalled();
    expect(onSave).not.toHaveBeenCalled();

    await rerender({ saving: false });
    await fireEvent.click(save);
    expect(onSave).toHaveBeenCalledOnce();
  });

  it('keeps "Save" next to the spinner while saving on mobile', () => {
    const { save } = setup({ isMobile: true, saving: true });
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(save.querySelector('.spin')).not.toBeNull();
    expect(save).toHaveTextContent(/^Save$/);
  });

  it('registers for the toast offset and unregisters on removal', () => {
    const remove = vi.fn();
    const add = vi.spyOn(toastLift, 'add').mockReturnValue(remove);
    const { bar, unmount } = setup();
    expect(add).toHaveBeenCalledWith(bar);
    unmount();
    expect(remove).toHaveBeenCalledOnce();
  });
});
