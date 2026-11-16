import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideTooltip, TIP_DELAY, TIP_FADE } from '#lib/actions/tooltip.ts';
import type { IdentitiesValues, IdentityForm, IdentityRow } from '#lib/identities.svelte.ts';
import type { LoadValues } from '#lib/mail-account.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import MailIdentities from './MailIdentities.svelte';

function row(over: Partial<IdentityRow> = {}): IdentityRow {
  return {
    id: 'i1',
    name: 'Jane Doe',
    email: 'max@example.test',
    ini: 'MM',
    avBg: '#f5a06e',
    avInk: '#3a1b06',
    sub: 'With signature',
    editing: false,
    edit: vi.fn(),
    ...over,
  };
}

function form(over: Partial<IdentityForm> = {}): IdentityForm {
  return {
    name: '',
    replyTo: '',
    sig: '',
    saving: false,
    onName: vi.fn(),
    onReply: vi.fn(),
    onSig: vi.fn(),
    cancel: vi.fn(),
    save: vi.fn(),
    ...over,
  };
}

function loadValues(over: Partial<LoadValues> = {}): LoadValues {
  return {
    text: 'mail.example.test is unreachable. Try again later.',
    retry: true,
    reauth: false,
    con: false,
    onRetry: vi.fn(),
    goCon: vi.fn(),
    ...over,
  };
}

function setup(rows: IdentityRow[], f: Partial<IdentityForm> = {}, over: Partial<IdentitiesValues> = {}) {
  const v: IdentitiesValues = {
    load: null,
    empty: false,
    emptyText: 'mail.example.test reports no sender address for this account.',
    rows,
    form: form(f),
    ...over,
  };
  const view = render(MailIdentities, v);
  return { view, v };
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

describe('email account › identities', () => {
  it('shows every identity as a read row with initials, name, address and suffix', () => {
    const { view } = setup([
      row(),
      row({
        id: 'i2',
        name: 'Support',
        email: 'support@example.test',
        ini: 'S',
        avBg: '#94c48d',
        avInk: '#13300f',
        sub: 'Reply-To: team@example.test · No signature',
      }),
    ]);
    const items = view.container.querySelectorAll('.item');
    expect(items).toHaveLength(2);
    for (const item of items) expect(item).not.toHaveClass('editing');
    const first = within(items[0] as HTMLElement);
    const av = first.getByText('MM');
    expect(av).toHaveStyle({ color: '#3a1b06' });
    expect(av.style.background).toBe('rgb(245, 160, 110)');
    expect(first.getByText('Jane Doe')).toHaveClass('name');
    expect(first.getByText('max@example.test')).toHaveClass('email');
    expect(first.getByText('With signature')).toHaveClass('sub');
    expect(view.getByText('Reply-To: team@example.test · No signature')).toBeInTheDocument();
    expect(view.getAllByRole('button', { name: 'Edit identity' })).toHaveLength(2);
    expect(view.queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      view.getByText('Set up new sender addresses on the mail server. They’ll appear here after the next sync.'),
    ).toHaveClass('note');
  });

  it('opens editing via the pencil with the tooltip "Edit"', async () => {
    const second = row({ id: 'i2', name: 'Support', email: 'support@example.test', ini: 'S' });
    const { view } = setup([row(), second]);
    const [, btn] = view.getAllByRole('button', { name: 'Edit identity' });
    expect(await tipOf(btn!)).toBe('Edit');
    await fireEvent.click(btn!);
    expect(second.edit).toHaveBeenCalledTimes(1);
  });

  it('shows the edited identity with fields, highlighted and without pencil', () => {
    const { view } = setup([row(), row({ id: 'i2', email: 'support@example.test', ini: 'S', editing: true })], {
      name: 'Support',
      replyTo: 'team@example.test',
      sig: 'Best regards',
    });
    const items = view.container.querySelectorAll('.item');
    expect(items[0]).not.toHaveClass('editing');
    expect(items[1]).toHaveClass('editing');
    const ed = within(items[1] as HTMLElement);
    expect(ed.getByText('S')).toBeInTheDocument();
    expect(ed.getByText('support@example.test')).toHaveClass('head-email');
    expect(ed.getByText('The address is set by the server.')).toBeInTheDocument();
    expect(ed.queryByRole('button', { name: 'Edit identity' })).not.toBeInTheDocument();
    expect(view.getAllByRole('button', { name: 'Edit identity' })).toHaveLength(1);

    const name = ed.getByRole('textbox', { name: 'Name' });
    expect(name).toHaveValue('Support');
    expect(name).toHaveAttribute('type', 'text');
    expect(name).toHaveAttribute('placeholder', 'Your name');
    const reply = ed.getByRole('textbox', { name: 'Reply-To (optional)' });
    expect(reply).toHaveValue('team@example.test');
    expect(reply).toHaveAttribute('type', 'email');
    expect(reply).toHaveAttribute('placeholder', 'name@example.com');
    expect(reply).toHaveAttribute('autocomplete', 'email');
    expect(reply).toHaveAttribute('spellcheck', 'false');
    const sig = ed.getByRole('textbox', { name: 'Signature' });
    expect(sig.tagName).toBe('TEXTAREA');
    expect(sig).toHaveValue('Best regards');
    expect(sig).toHaveAttribute('rows', '4');
    expect(sig).toHaveAttribute('placeholder', 'Added below new messages');
  });

  it('reports every input to name, reply address and signature', async () => {
    const { view, v } = setup([row({ editing: true })]);
    await fireEvent.input(view.getByRole('textbox', { name: 'Name' }), { target: { value: 'Jane D.' } });
    expect(v.form.onName).toHaveBeenCalledWith('Jane D.');
    await fireEvent.input(view.getByRole('textbox', { name: 'Reply-To (optional)' }), {
      target: { value: 'reply@example.test' },
    });
    expect(v.form.onReply).toHaveBeenCalledWith('reply@example.test');
    await fireEvent.input(view.getByRole('textbox', { name: 'Signature' }), { target: { value: 'Cheers' } });
    expect(v.form.onSig).toHaveBeenCalledWith('Cheers');
  });

  it('cancels and saves via the buttons', async () => {
    const { view, v } = setup([row({ editing: true })]);
    const save = view.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    await fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(v.form.cancel).toHaveBeenCalledTimes(1);
    await fireEvent.click(save);
    expect(v.form.save).toHaveBeenCalledTimes(1);
  });

  it('shows spinner and "Saving …" while saving, fields read-only', () => {
    const { view } = setup([row({ editing: true })], { saving: true, name: 'Jane' });
    const save = view.getByRole('button', { name: 'Saving …' });
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save.querySelector('.spin svg')).not.toBeNull();
    const cancel = view.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveAttribute('aria-disabled', 'true');
    for (const name of ['Name', 'Reply-To (optional)', 'Signature']) {
      expect(view.getByRole('textbox', { name })).toHaveAttribute('readonly');
    }
    expect(view.getByRole('textbox', { name: 'Name' })).toHaveValue('Jane');
  });

  it('shows "Save" without spinner and writable fields when not saving', () => {
    const { view } = setup([row({ editing: true })]);
    const save = view.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('aria-busy', 'false');
    expect(save.querySelector('.spin')).toBeNull();
    expect(view.getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-disabled', 'false');
    expect(view.getByRole('textbox', { name: 'Name' })).not.toHaveAttribute('readonly');
  });

  it('shows the card instead of list and hint when loading failed', async () => {
    const load = loadValues();
    const { view } = setup([], {}, { load });
    const card = view.getByRole('alert');
    expect(card).toHaveTextContent('Couldn’t load identities');
    expect(card).toHaveTextContent('mail.example.test is unreachable. Try again later.');
    expect(card.querySelector('.tile svg')).not.toBeNull();
    expect(view.queryByText(/Set up new sender addresses/)).toBeNull();
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Try again']);
    await fireEvent.click(within(card).getByRole('button', { name: 'Try again' }));
    expect(load.onRetry).toHaveBeenCalledTimes(1);
  });

  it('offers "Sign in again" or "Go to connection" per reason', async () => {
    const reauth = loadValues({ retry: false, reauth: true, text: 'Sign-in to mail.example.test required' });
    const first = setup([], {}, { load: reauth });
    const card = first.view.getByRole('alert');
    expect(
      within(card)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Sign in again']);
    await fireEvent.click(within(card).getByRole('button', { name: 'Sign in again' }));
    expect(reauth.goCon).toHaveBeenCalledTimes(1);
    first.view.unmount();

    const both = setup([], {}, { load: loadValues({ reauth: true }) });
    expect(
      within(both.view.getByRole('alert'))
        .getAllByRole('button')
        .map((b) => b.textContent?.trim()),
    ).toEqual(['Try again', 'Sign in again']);
    both.view.unmount();

    const con = loadValues({ retry: false, con: true });
    const { view } = setup([], {}, { load: con });
    await fireEvent.click(within(view.getByRole('alert')).getByRole('button', { name: 'Go to connection' }));
    expect(con.goCon).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state and the hint below it without an identity', () => {
    const { view } = setup([], {}, { empty: true });
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByText('No identities')).toBeInTheDocument();
    expect(view.getByText('mail.example.test reports no sender address for this account.')).toBeInTheDocument();
    expect(view.getByText(/Set up new sender addresses on the mail server/)).toBeInTheDocument();
    expect(view.queryByRole('button')).toBeNull();
  });
});
