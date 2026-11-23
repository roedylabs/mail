import { fireEvent, render, within } from '@testing-library/svelte';
import { createRawSnippet, flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import AuthShell from './AuthShell.svelte';

afterEach(() => {
  vi.restoreAllMocks();
  prefs.reset();
  ui.reset();
});

/** A desktop window: jsdom has no layout (width 0 is the mobile layout). */
function desktop(w = 1280, h = 860) {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(w);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(h);
}

const fields = createRawSnippet(() => ({ render: () => '<input id="f" aria-label="Field" />' }));
const reg = () => () => {};

/** The shell with a field and a primary button. */
function shell(props: Record<string, unknown> = {}) {
  return render(AuthShell, {
    props: {
      docTitle: 'Screen · Test',
      title: 'Heading',
      heads: [],
      reg,
      fields,
      primary: { label: 'Continue', icon: 'ti-arrow-right' },
      ...props,
    },
  });
}

describe('AuthShell', () => {
  it('shows the step bars: the current one long, those up to it in the accent', () => {
    const view = shell({ bars: { n: 2, total: 4, label: 'Step 2 of 4' } });
    const bars = view.getByRole('img', { name: 'Step 2 of 4' });
    const items = [...bars.querySelectorAll('.bar')];
    expect(items).toHaveLength(4);
    expect(items.map((b) => b.classList.contains('long'))).toEqual([false, true, false, false]);
    expect(items.map((b) => b.classList.contains('on'))).toEqual([true, true, false, false]);
  });

  it('has no step bars and no light/dark button without them', () => {
    const view = shell();
    expect(view.queryByRole('img')).toBeNull();
    expect(view.queryByRole('button', { name: /theme/ })).toBeNull();
  });

  it('switches between light and dark with the button in the brand row', async () => {
    prefs.set({ mode: 'light' });
    flushSync();
    const view = shell({ themeToggle: true });
    const toDark = view.getByRole('button', { name: 'Dark theme' });
    expect(toDark).toHaveAttribute('title', 'Dark theme');
    await fireEvent.click(toDark);
    expect(prefs.values.mode).toBe('dark');
    const toLight = view.getByRole('button', { name: 'Light theme' });
    expect(toLight).toHaveAttribute('title', 'Light theme');
    await fireEvent.click(toLight);
    expect(prefs.values.mode).toBe('light');
  });

  it('lists the overview with checks before the current item, which is marked as the current step', () => {
    desktop();
    const view = shell({ overview: { label: 'Sign-in steps', items: ['One', 'Two', 'Three'], current: 2 } });
    const list = view.getByRole('list', { name: 'Sign-in steps' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.trim())).toEqual(['One', '2 Two', '3 Three']);
    expect(items[0]).toHaveClass('past');
    expect(items[0]!.querySelector('svg')).not.toBeNull();
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[2]).not.toHaveAttribute('aria-current');
  });

  it('names "Back" in full where it needs it and locks it while the primary button is busy', async () => {
    const onback = vi.fn();
    const view = shell({ back: { label: 'Back', ariaLabel: 'Back to sign-in', onback } });
    const back = view.getByRole('button', { name: 'Back to sign-in' });
    expect(back).toHaveTextContent('Back');
    await fireEvent.click(back);
    expect(onback).toHaveBeenCalledOnce();

    await view.rerender({
      primary: { label: 'Continue', icon: 'ti-arrow-right', busy: true, busyLabel: 'Checking …' },
    });
    expect(back).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.click(back);
    expect(onback).toHaveBeenCalledOnce();
  });

  it('gives the primary button the full width without "Back"', () => {
    desktop();
    const view = shell();
    const actions = view.container.querySelector('.actions')!;
    expect(within(actions as HTMLElement).getAllByRole('button')).toHaveLength(1);
  });

  it('submits on Enter in a field and sets the document title', async () => {
    const onsubmit = vi.fn();
    const view = shell({ onsubmit });
    expect(ui.authTitle).toBe('Screen · Test');
    await fireEvent.keyDown(view.getByLabelText('Field'), { key: 'Enter' });
    expect(onsubmit).toHaveBeenCalledOnce();
    view.unmount();
    expect(ui.authTitle).toBeNull();
  });

  it('shows the skeleton instead of the form while the first request is pending', () => {
    const skeleton = createRawSnippet(() => ({ render: () => '<span>Loading</span>' }));
    const view = shell({ skeleton });
    const busy = view.getByRole('status');
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toHaveTextContent('Loading');
    expect(view.container.querySelector('form')).toBeNull();
  });

  it('puts a text intro in place and its short variant falls back to the long one', () => {
    const view = shell({ intro: 'Long intro' });
    expect(view.container.querySelector('.intro')).toHaveTextContent('Long intro');
  });

  it('keeps the line under the actions on desktop and in the panel on mobile', () => {
    const below = createRawSnippet(() => ({ render: () => '<p>Already registered?</p>' }));
    desktop();
    const view = shell({ below });
    expect(view.container.querySelector('.actions .below')).toHaveTextContent('Already registered?');
    view.unmount();
    // Mobile: at the end of the panel.
    vi.restoreAllMocks();
    const phone = shell({ below });
    expect(phone.container.querySelector('.right .below')).toHaveTextContent('Already registered?');
    expect(phone.container.querySelector('.bottom .below')).toBeNull();
  });

  it('keeps the setup’s bottom bar as one row and stacks it for sign-in and invitation', () => {
    const back = { label: 'Back', onback: () => {} };
    // jsdom has no layout: the mobile layout, with the bottom bar.
    const row = shell({ back });
    const bar = row.container.querySelector('.bottom')!;
    expect(bar).not.toHaveClass('stack');
    expect([...bar.children].map((el) => el.tagName)).toEqual(['BUTTON', 'BUTTON']);
    row.unmount();

    const stacked = shell({ back, bottomBar: 'stack' });
    const stack = stacked.container.querySelector('.bottom.stack')!;
    const inner = stack.querySelector(':scope > .row')!;
    expect(
      within(inner as HTMLElement)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Back', 'Continue']);
  });
});
