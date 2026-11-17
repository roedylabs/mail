import { fireEvent, render } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { pointer } from '#lib/test/pointer.ts';
import Sheet from './Sheet.svelte';

const body = createRawSnippet(() => ({ render: () => '<p>Content</p>' }));

describe('Sheet', () => {
  it('shows the content as a dialog', () => {
    const { getByRole, getByText } = render(Sheet, { label: 'More', onclose: () => {}, children: body });
    expect(getByRole('dialog', { name: 'More' })).toHaveAttribute('aria-modal', 'true');
    expect(getByText('Content')).toBeInTheDocument();
  });

  it('closes with Escape and on a click on the backdrop', async () => {
    const onclose = vi.fn();
    const { container } = render(Sheet, { label: 'More', onclose, children: body });
    await fireEvent.keyDown(window, { key: 'Escape' });
    const scrim = container.querySelector('.scrim');
    if (!scrim) throw new Error('no backdrop');
    // The focus trap does not make the backdrop next to the panel inert.
    expect((scrim as HTMLElement & { inert?: boolean }).inert).toBeFalsy();
    await fireEvent.mouseDown(scrim);
    expect(onclose).toHaveBeenCalledTimes(2);
  });

  it('leaves Escape and operation to a level 2 sheet in front and takes focus back afterwards', async () => {
    const onclose = vi.fn();
    const { getByRole, rerender } = render(Sheet, { label: 'Mailboxes', onclose, children: body, behind: true });
    const sheet = getByRole('dialog', { hidden: true }) as HTMLElement & { inert: boolean };
    // jsdom does not know `inert` as an attribute; Svelte sets the property.
    expect(sheet.inert).toBe(true);
    expect(sheet).toHaveClass('behind');
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onclose).not.toHaveBeenCalled();
    await rerender({ behind: false });
    expect(sheet.inert).toBe(false);
    expect(document.activeElement).toBe(sheet);
  });

  it('closes like the backdrop when dragged down far enough, the backdrop fading along', () => {
    vi.useFakeTimers();
    try {
      const onclose = vi.fn();
      const { container, getByRole } = render(Sheet, { label: 'More', onclose, children: body });
      const sheet = getByRole('dialog');
      const scrim = container.querySelector<HTMLElement>('.scrim');
      Object.defineProperty(sheet, 'offsetHeight', { value: 400 });
      pointer('pointerdown', 100, 100, sheet);
      pointer('pointermove', 100, 110);
      pointer('pointermove', 100, 310);
      expect(sheet.style.translate).toBe('0px 200px');
      expect(scrim?.style.opacity).toBe('0.5');
      vi.advanceTimersByTime(200);
      pointer('pointerup', 100, 310);
      window.dispatchEvent(new MouseEvent('click'));
      expect(onclose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(250);
      expect(onclose).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips Escape that is already handled, and lies on top as level 2', () => {
    const onclose = vi.fn();
    const { getByRole } = render(Sheet, { label: 'Switch account', onclose, children: body, level: 2 });
    expect(getByRole('dialog')).toHaveClass('top');
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);
    expect(onclose).not.toHaveBeenCalled();
  });

  describe('focus trap', () => {
    const opener = createRawSnippet(() => ({ render: () => '<div><button>Switch account</button></div>' }));
    const list = createRawSnippet(() => ({ render: () => '<div><button>Account 1</button></div>' }));

    /** "Mailboxes" with "Switch account" as level 2 above, as in the layout. */
    function stack() {
      const lower = $state({ label: 'Mailboxes', onclose: () => {}, children: opener, behind: false });
      const view = render(Sheet, lower);
      const button = view.getByRole('button', { name: 'Switch account' });
      button.focus();
      const upper = render(Sheet, { label: 'Switch account', onclose: () => {}, children: list, level: 2 });
      flushSync(() => (lower.behind = true));
      return { lower, upper, button };
    }

    it('jumps to the button in level 1 after level 2 closes, even if level 1 is released only afterwards', async () => {
      const { lower, upper, button } = stack();
      expect(document.activeElement).not.toBe(button);
      // In the same pass: level 2 disappears, then Svelte releases level 1.
      upper.unmount();
      flushSync(() => (lower.behind = false));
      await Promise.resolve();
      expect(document.activeElement).toBe(button);
    });

    it('jumps back too when level 1 is released before level 2 closes', async () => {
      const { lower, upper, button } = stack();
      flushSync(() => (lower.behind = false));
      upper.unmount();
      await Promise.resolve();
      expect(document.activeElement).toBe(button);
    });

    it('does not let Tab behind the sheet', async () => {
      const outside = document.createElement('button');
      document.body.prepend(outside);
      const { getByRole } = render(Sheet, { label: 'More', onclose: () => {}, children: list });
      const only = getByRole('button', { name: 'Account 1' });
      only.focus();
      expect(await fireEvent.keyDown(only, { key: 'Tab' })).toBe(false);
      expect(document.activeElement).toBe(only);
      outside.remove();
    });
  });
});
