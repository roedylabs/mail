import { fireEvent, render, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { LoadValues } from '#lib/mail-account.svelte.ts';
import type { VacationValues } from '#lib/vacation.svelte.ts';
import MailVacation from './MailVacation.svelte';

function values(over: Partial<VacationValues> = {}): VacationValues {
  return {
    load: null,
    na: false,
    naText: 'mail.example.test doesn’t offer vacation replies, so automatic replies can’t be set up for this account.',
    on: false,
    from: '',
    to: '',
    subject: 'Out of office',
    text: '',
    dirty: false,
    saving: false,
    summary: 'Off',
    rlHint: false,
    rlHintText:
      'While the vacation reply is on, forwarding and filter rules are paused, even before the start date and after the end date. Turn it off when you’re back.',
    rlHintGo: 'Go to rules',
    goRules: vi.fn(),
    onToggle: vi.fn(),
    onFrom: vi.fn(),
    onTo: vi.fn(),
    onSubject: vi.fn(),
    onText: vi.fn(),
    discard: vi.fn(),
    save: vi.fn(),
    ...over,
  };
}

function setup(over: Partial<VacationValues> = {}, isMobile = false) {
  const v = values(over);
  const view = render(MailVacation, { ...v, isMobile });
  return { view, v };
}

describe('email account › vacation reply', () => {
  it('shows "Off" when turned off, the toggle off and the fields editable', () => {
    const { view } = setup();
    expect(view.getByText('Reply automatically')).toBeInTheDocument();
    expect(view.getByText('Off')).toHaveClass('summary');
    const tg = view.getByRole('switch', { name: 'Vacation reply' });
    expect(tg).toHaveAttribute('aria-checked', 'false');
    expect(tg).not.toHaveClass('on');
    expect(view.container.querySelector('.auto')).not.toHaveClass('on');
    // Not dimmed: the fields stay operable, the toggle shows the state.
    const inputs = view.container.querySelectorAll('.fields input, .fields textarea');
    expect(inputs.length).toBeGreaterThan(0);
    for (const el of inputs) expect(el).toBeEnabled();
    expect(view.getByText('Each sender receives this reply only once per absence.')).toHaveClass('note');
  });

  it('shows the period and the toggle on when turned on', () => {
    const { view } = setup({
      on: true,
      from: '2026-11-10',
      to: '2026-11-20',
      summary: 'From 10. November 2026 to 20. November 2026',
    });
    expect(view.getByText('From 10. November 2026 to 20. November 2026')).toBeInTheDocument();
    const tg = view.getByRole('switch', { name: 'Vacation reply' });
    expect(tg).toHaveAttribute('aria-checked', 'true');
    expect(tg).toHaveClass('on');
    expect(view.container.querySelector('.auto')).toHaveClass('on');
  });

  it('switches via the toggle', async () => {
    const { view, v } = setup();
    await fireEvent.click(view.getByRole('switch', { name: 'Vacation reply' }));
    expect(v.onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows no hint "Rules paused" without active rules', () => {
    const { view } = setup();
    expect(view.queryByRole('note')).toBeNull();
    expect(view.queryByRole('button', { name: 'Go to rules' })).toBeNull();
  });

  it('shows the hint "Rules paused" below the toggle, also when off, and leads to the rules', async () => {
    const { view, v } = setup({ rlHint: true });
    const hint = view.getByRole('note');
    expect(hint).toHaveTextContent(/^While the vacation reply is on, forwarding and filter rules are paused/);
    expect(hint.querySelector('.rl-hint-icon svg')).not.toBeNull();
    // Between "Reply automatically" and the fields
    expect(view.container.querySelector('.auto + .rl-hint + .fields')).not.toBeNull();
    await fireEvent.click(within(hint).getByRole('button', { name: 'Go to rules' }));
    expect(v.goRules).toHaveBeenCalledTimes(1);
  });

  it('shows the fields with values, types and placeholders', () => {
    const { view } = setup({ from: '2026-11-10', to: '2026-11-20', subject: 'Vacation', text: 'Away.' });
    const from = view.getByLabelText('From (optional)');
    expect(from).toHaveAttribute('type', 'date');
    expect(from).toHaveValue('2026-11-10');
    const to = view.getByLabelText('Until (optional)');
    expect(to).toHaveAttribute('type', 'date');
    expect(to).toHaveValue('2026-11-20');
    const subject = view.getByRole('textbox', { name: 'Subject' });
    expect(subject).toHaveValue('Vacation');
    expect(subject).toHaveAttribute('placeholder', 'Out of office');
    const text = view.getByRole('textbox', { name: 'Message' });
    expect(text.tagName).toBe('TEXTAREA');
    expect(text).toHaveValue('Away.');
    expect(text).toHaveAttribute('rows', '6');
    expect(text).toHaveAttribute('placeholder', 'I’m away until … For urgent matters, please contact …');
  });

  it('reports date, subject and message to the handlers', async () => {
    const { view, v } = setup();
    await fireEvent.input(view.getByLabelText('From (optional)'), { target: { value: '2026-11-10' } });
    expect(v.onFrom).toHaveBeenCalledWith('2026-11-10');
    await fireEvent.change(view.getByLabelText('Until (optional)'), { target: { value: '2026-11-20' } });
    expect(v.onTo).toHaveBeenCalledWith('2026-11-20');
    await fireEvent.input(view.getByRole('textbox', { name: 'Subject' }), { target: { value: 'Vacation' } });
    expect(v.onSubject).toHaveBeenCalledWith('Vacation');
    await fireEvent.input(view.getByRole('textbox', { name: 'Message' }), { target: { value: 'Away.' } });
    expect(v.onText).toHaveBeenCalledWith('Away.');
  });

  it('reports a date only once, even if the browser sends `input` and `change`', async () => {
    const { view, v } = setup({ from: '2026-11-10' });
    const from = view.getByLabelText('From (optional)');
    await fireEvent.change(from, { target: { value: '2026-11-10' } });
    expect(v.onFrom).not.toHaveBeenCalled();
    await fireEvent.change(from, { target: { value: '' } });
    expect(v.onFrom).toHaveBeenCalledWith('');
  });

  it('shows the bar "Unsaved changes" only with changes', () => {
    const { view } = setup();
    expect(view.queryByRole('region', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('discards and saves via the bar', async () => {
    const { view, v } = setup({ dirty: true });
    const bar = view.getByRole('region', { name: 'Unsaved changes' });
    expect(bar).toHaveTextContent('Unsaved changes');
    await fireEvent.click(view.getByRole('button', { name: 'Discard' }));
    expect(v.discard).toHaveBeenCalledTimes(1);
    const save = view.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    await fireEvent.click(save);
    expect(v.save).toHaveBeenCalledTimes(1);
  });

  it('shows the bar on mobile without text, with "Save" while saving', () => {
    const { view } = setup({ dirty: true, saving: true }, true);
    const bar = view.getByRole('region', { name: 'Unsaved changes' });
    expect(bar).toHaveClass('mobile');
    expect(bar.querySelector('.dirty-text')).toBeNull();
    const save = bar.querySelector('.dirty-save')!;
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(save).toHaveTextContent(/^Save$/);
  });

  it('shows spinner and "Saving …" while saving, fields read-only', () => {
    const { view } = setup({ dirty: true, saving: true, on: true });
    expect(view.getByRole('region', { name: 'Unsaved changes' })).toHaveTextContent('Unsaved changes');
    const save = view.getByRole('button', { name: 'Saving …' });
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save.querySelector('.spin svg')).not.toBeNull();
    expect(view.getByRole('button', { name: 'Discard' })).toHaveAttribute('aria-disabled', 'true');
    const tg = view.getByRole('switch', { name: 'Vacation reply' });
    expect(tg).toHaveAttribute('aria-disabled', 'true');
    expect(tg).toHaveAttribute('aria-checked', 'true');
    for (const field of [
      view.getByLabelText('From (optional)'),
      view.getByLabelText('Until (optional)'),
      view.getByRole('textbox', { name: 'Subject' }),
      view.getByRole('textbox', { name: 'Message' }),
    ]) {
      expect(field).toHaveAttribute('readonly');
    }
  });

  it('shows "Save" without spinner and writable fields when not saving', () => {
    const { view } = setup({ dirty: true });
    const save = view.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('aria-busy', 'false');
    expect(save.querySelector('.spin')).toBeNull();
    expect(view.getByRole('switch', { name: 'Vacation reply' })).toHaveAttribute('aria-disabled', 'false');
    expect(view.getByRole('textbox', { name: 'Subject' })).not.toHaveAttribute('readonly');
  });

  it('shows the card instead of toggle, fields and hint when loading failed', async () => {
    const load: LoadValues = {
      text: 'Sign-in to mail.example.test required',
      retry: false,
      reauth: true,
      con: false,
      onRetry: vi.fn(),
      goCon: vi.fn(),
    };
    const { view } = setup({ load, dirty: true, rlHint: true });
    const card = view.getByRole('alert');
    expect(view.queryByRole('note')).toBeNull();
    expect(card).toHaveTextContent('Couldn’t load the vacation reply');
    expect(card).toHaveTextContent('Sign-in to mail.example.test required');
    expect(view.queryByRole('switch')).toBeNull();
    expect(view.queryByRole('region')).toBeNull();
    expect(view.queryByText(/Any sender/)).toBeNull();
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Sign in again']);
    await fireEvent.click(within(card).getByRole('button', { name: 'Sign in again' }));
    expect(load.goCon).toHaveBeenCalledTimes(1);
  });

  it('shows the card "not available" without vacation notice on the server', () => {
    const { view } = setup({ na: true, dirty: true });
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByText('This mail server doesn’t support vacation replies')).toBeInTheDocument();
    expect(
      view.getByText(
        'mail.example.test doesn’t offer vacation replies, so automatic replies can’t be set up for this account.',
      ),
    ).toBeInTheDocument();
    expect(view.queryByRole('switch')).toBeNull();
    expect(view.queryByRole('region')).toBeNull();
    expect(view.queryByText(/Any sender/)).toBeNull();
    expect(view.queryByRole('button')).toBeNull();
  });
});
