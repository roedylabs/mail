import { fireEvent, render, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DONE_LEVELS, DONE_MOB_LEVELS, doneLook } from '#lib/auth-layout.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import AuthResult from './AuthResult.svelte';

afterEach(() => ui.reset());

const reg = () => () => {};
const base = { docTitle: 'Result · Test', title: 'All done', reg };

describe('AuthResult', () => {
  it('shows a good result on the accent with its chips and the bar', () => {
    const text = createRawSnippet(() => ({ render: () => '<span>Signed in as <b>anna</b>.</span>' }));
    const view = render(AuthResult, {
      ...base,
      icon: 'ti-check',
      text,
      chips: { label: 'What was set up', items: [{ icon: 'ti-key', text: 'Key' }] },
      progress: { text: 'Signing you in …', ms: 2600 },
    });
    const block = view.getByRole('status');
    expect(block).toHaveClass('good');
    expect(within(block).getByRole('heading', { level: 1 })).toHaveTextContent('All done');
    expect(block).toHaveTextContent('Signed in as anna.');
    expect(within(block).getByRole('list', { name: 'What was set up' })).toHaveTextContent('Key');
    expect(block.querySelector<HTMLElement>('.progress span')?.style.animationDuration).toBe('2600ms');
    expect(block).toHaveTextContent('Signing you in …');
  });

  it('shows a dead end muted as an alert, with the primary and the quiet action', async () => {
    const primary = vi.fn();
    const quiet = vi.fn();
    const view = render(AuthResult, {
      ...base,
      tone: 'muted',
      role: 'alert',
      icon: 'ti-link-off',
      primary: { label: 'Request a new link', icon: 'ti-send', onclick: primary },
      quiet: { label: 'Back to sign-in', icon: 'ti-arrow-left', onclick: quiet },
    });
    expect(view.getByRole('alert')).toHaveClass('muted');
    await fireEvent.click(view.getByRole('button', { name: 'Request a new link' }));
    await fireEvent.click(view.getByRole('button', { name: 'Back to sign-in' }));
    expect(primary).toHaveBeenCalledOnce();
    expect(quiet).toHaveBeenCalledOnce();
  });

  it('puts the icon of a back-type primary before its label', () => {
    const view = render(AuthResult, {
      ...base,
      icon: 'ti-check',
      primary: { label: 'Go to sign-in', icon: 'ti-arrow-left', iconLeft: true, onclick: () => {} },
    });
    const button = view.getByRole('button', { name: 'Go to sign-in' });
    expect(button.firstElementChild).toHaveClass('bi');
  });

  it('moves the focus to the heading unless the page does', async () => {
    const view = render(AuthResult, { ...base, icon: 'ti-check' });
    await vi.waitFor(() => expect(view.getByRole('heading', { level: 1 })).toHaveFocus());
    view.unmount();
    const other = render(AuthResult, { ...base, icon: 'ti-check', focusHeading: false });
    await new Promise((r) => setTimeout(r, 20));
    expect(other.getByRole('heading', { level: 1 })).not.toHaveFocus();
  });

  it('steps down through the result levels', () => {
    expect(DONE_LEVELS.map((l) => [l.h1, l.ctl, l.btn])).toEqual([
      ['44px', '56px', '28px'],
      ['40px', '52px', '24px'],
      ['36px', '48px', '20px'],
      ['30px', '44px', '16px'],
    ]);
    expect(DONE_MOB_LEVELS.map((l) => l.h1)).toEqual(['32px', '30px', '28px', '26px']);
    expect([doneLook(1280, 3).ctl, doneLook(1280, 3).btnTop]).toEqual(['44px', '16px']);
    expect(doneLook(390, 3).h1).toBe('26px');
  });
});
