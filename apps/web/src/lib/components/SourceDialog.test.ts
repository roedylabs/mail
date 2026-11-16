import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideTooltip, TIP_DELAY, TIP_FADE } from '#lib/actions/tooltip.ts';
import type { SourceValues } from '#lib/message-view.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import SourceDialog from './SourceDialog.svelte';

function source(patch: Partial<SourceValues> = {}): SourceValues {
  return {
    sub: 'Approve homepage by Friday?',
    head: [
      { k: 'From', v: 'Anna Baker <anna.baker@example.com>' },
      { k: 'Received', v: 'from mx.example.com\n\tby mail.s1.test' },
      { k: 'Received', v: 'from localhost' },
      { k: 'Subject', v: 'Approve homepage by Friday?' },
    ],
    body: 'Hi Jane,\n\nattached is the draft.',
    busy: false,
    close: vi.fn(),
    overlay: vi.fn(),
    copy: vi.fn(),
    download: vi.fn(),
    ...patch,
  };
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

describe('SourceDialog', () => {
  it('shows headers and text in the dialog on desktop; focus is in the source', async () => {
    const src = source();
    const view = render(SourceDialog, { src, isMobile: false });
    const dialog = view.getByRole('dialog', { name: 'Source' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(view.getByText('Approve homepage by Friday?', { selector: '.sub' })).toBeInTheDocument();
    const code = dialog.querySelector('.code')!;
    expect(document.activeElement).toBe(code);
    expect(code).toHaveAttribute('tabindex', '0');
    expect(code).toHaveAttribute('aria-busy', 'false');
    const lines = [...code.querySelectorAll('.line')].map((l) => l.textContent);
    expect(lines).toEqual([
      'From: Anna Baker <anna.baker@example.com>',
      'Received: from mx.example.com\n\tby mail.s1.test',
      'Received: from localhost',
      'Subject: Approve homepage by Friday?',
      'Hi Jane,\n\nattached is the draft.',
    ]);
    expect(code.querySelector('.key')).toHaveTextContent('From:');

    const close = view.getByRole('button', { name: 'Close' });
    expect(await tipOf(close)).toBe('Close (Esc)');
    await fireEvent.click(view.getByRole('button', { name: 'Download as .eml' }));
    await fireEvent.click(view.getByRole('button', { name: 'Copy' }));
    await fireEvent.click(close);
    expect(src.download).toHaveBeenCalledOnce();
    expect(src.copy).toHaveBeenCalledOnce();
    expect(src.close).toHaveBeenCalledOnce();
  });

  it('reports the backdrop to `overlay` and returns focus on close', async () => {
    const before = document.createElement('button');
    document.body.append(before);
    before.focus();
    const src = source({ busy: true, head: [], body: '' });
    const view = render(SourceDialog, { src, isMobile: false });
    expect(document.activeElement).not.toBe(before);
    expect(view.getByRole('dialog').querySelector('.code')).toHaveAttribute('aria-busy', 'true');
    await fireEvent.mouseDown(view.getByRole('presentation'));
    expect(src.overlay).toHaveBeenCalledOnce();
    view.unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it('shows only the sheet content with ".eml" and "Copy" on mobile', async () => {
    const src = source();
    const view = render(SourceDialog, { src, isMobile: true });
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.queryByRole('presentation')).toBeNull();
    expect(view.getByText('Source')).toBeInTheDocument();
    const lines = [...view.container.querySelectorAll('.line')].map((l) => l.textContent);
    expect(lines).toHaveLength(5);
    expect(lines[2]).toBe('Received: from localhost');
    expect(view.container.querySelector('.code')).toHaveAttribute('aria-busy', 'false');
    expect(document.activeElement).toBe(document.body);
    expect(view.container.querySelector('[tabindex="0"]')).toBeNull();
    const download = view.getByRole('button', { name: 'Download as .eml' });
    expect(download).toHaveTextContent('.eml');
    await fireEvent.click(download);
    await fireEvent.click(view.getByRole('button', { name: 'Copy' }));
    await fireEvent.click(view.getByRole('button', { name: 'Close' }));
    expect(src.download).toHaveBeenCalledOnce();
    expect(src.copy).toHaveBeenCalledOnce();
    expect(src.close).toHaveBeenCalledOnce();
  });
});

describe('SourceDialog, large sources', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the body section by section, the next as soon as the end comes into view', async () => {
    let seen: ((entries: { isIntersecting: boolean }[]) => void) | undefined;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
          seen = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const line = `${'A'.repeat(75)}\n`;
    const body = line.repeat(3000); // 228,000 characters
    const view = render(SourceDialog, { src: source({ body }), isMobile: false });
    const text = () => view.container.querySelector('.text')!.textContent.length;
    expect(text()).toBe(Math.floor(100_000 / line.length) * line.length);
    expect(view.container.querySelector('.more')).not.toBeNull();

    seen?.([{ isIntersecting: false }]);
    await Promise.resolve();
    expect(text()).toBe(Math.floor(100_000 / line.length) * line.length);
    seen?.([{ isIntersecting: true }]);
    await vi.waitFor(() => expect(text()).toBeGreaterThan(190_000));
    seen?.([{ isIntersecting: true }]);
    await vi.waitFor(() => expect(text()).toBe(body.length));
    expect(view.container.querySelector('.more')).toBeNull();
  });
});
