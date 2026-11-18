import { createEvent, fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hideTooltip, TIP_DELAY, TIP_FADE, tooltips } from '#lib/actions/tooltip.ts';
import type { IconName } from '#lib/icons.ts';
import { M_TAB_PAD_B } from '#lib/shell.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import type {
  AttachmentValues,
  ChipValues,
  ComposeActions,
  ComposeValues,
  Field,
  FieldValues,
  FromOption,
  FromValues,
  LaterOption,
  LaterValues,
  SuggestionValues,
} from '#lib/state/compose.svelte.ts';
import ComposeView from './ComposeView.svelte';

const ACT = [
  'close',
  'discard',
  'send',
  'addFiles',
  'removeAttachment',
  'retryAttachment',
  'later',
  'pickLater',
  'setLater',
  'plan',
  'toggleFrom',
  'closeMenu',
  'pickFrom',
  'input',
  'commit',
  'remove',
  'removeLast',
  'moveSuggestion',
  'pickSuggestion',
  'focus',
  'blur',
  'showCc',
  'setSubject',
  'setText',
  'toggleSig',
  'toggleQuote',
] as const satisfies readonly (keyof ComposeActions)[];

function actions(): ComposeActions {
  return Object.fromEntries(ACT.map((k) => [k, vi.fn()])) as unknown as ComposeActions;
}

const chip = (key: string, label: string, title: string, letter: string, patch: Partial<ChipValues> = {}) =>
  ({
    key,
    label,
    title,
    letter,
    avBg: '#f5a06e',
    avInk: '#3a1b06',
    bad: false,
    rmLabel: `Remove ${label}`,
    ...patch,
  }) satisfies ChipValues;

const field = (key: Field, label: string, patch: Partial<FieldValues> = {}) =>
  ({
    key,
    label,
    val: '',
    auto: false,
    ph: key === 'to' ? 'Name or email address' : '',
    err: false,
    showToggle: false,
    chips: [],
    hasSug: false,
    sug: [],
    ...patch,
  }) satisfies FieldValues;

const sug = (key: string, name: string, email: string, letter: string, on = false) =>
  ({ key, name, email, letter, avBg: '#f5a06e', avInk: '#3a1b06', on }) satisfies SuggestionValues;

// List "Suggestions" below "To" after the input "to": the first selected, the second without a name.
const SUG = [
  sug('anna.baker@example.com', 'Anna Baker', 'anna.baker@example.com', 'AB', true),
  sug('anna@example.org', 'anna@example.org', '', 'A'),
];

/** New email with input in "To" and suggestions (position of the selected one as `on`). */
const suggesting = (on = 0, patch: Partial<FieldValues> = {}) =>
  values({
    fields: [
      field('to', 'To', {
        val: 'an',
        showToggle: true,
        hasSug: true,
        sug: SUG.map((x, i) => ({ ...x, on: i === on })),
        ...patch,
      }),
    ],
  });

const att = (key: string, name: string, icon: IconName, sub: string, up = false, failed = false) =>
  ({
    key,
    name,
    icon,
    sub,
    up,
    failed,
    retryLabel: `Upload ${name} again`,
    rmLabel: `Remove ${name}`,
  }) satisfies AttachmentValues;

const ATTS = [
  att('a1', 'Proposal_2026.pdf', 'ti-file-type-pdf', '240 KB'),
  att('a2', 'homepage.png', 'ti-cloud-upload', 'Uploading …', true),
];

const pdf = () => new File(['%PDF'], 'Proposal_2026.pdf', { type: 'application/pdf' });
const png = () => new File(['png'], 'homepage.png', { type: 'image/png' });

const opt = (key: string, name: string, email: string, letter: string, on = false) =>
  ({ key, name, email, letter, bg: '#94c48d', ink: '#13300f', on }) satisfies FromOption;

const SINGLE: FromValues = {
  name: 'Account One',
  email: 'account1@example.com',
  letter: 'AO',
  bg: '#94c48d',
  ink: '#13300f',
  open: false,
  multi: false,
  stale: false,
  opts: [opt('a1/', 'Account One', 'account1@example.com', 'AO', true)],
};

const MULTI: FromValues = {
  ...SINGLE,
  multi: true,
  opts: [
    opt('a1/i1', 'Account One', 'account1@example.com', 'AO', true),
    opt('a1/i2', 'Sales', 'sales@example.com', 'S'),
    opt('a2/', 'account2@example.org', 'account2@example.org', 'A'),
  ],
};

const lopt = (key: LaterOption['key'], label: string, icon: IconName, sub: string, dis = false) =>
  ({ key, label, icon, sub, dis }) satisfies LaterOption;

// Popover "Send later" closed, limit 7 days, field empty.
const LATER: LaterValues = {
  open: false,
  dis: false,
  tip: '',
  opts: [
    lopt('morning', 'Tomorrow morning', 'ti-sunrise', 'Tomorrow, 08:00'),
    lopt('afternoon', 'Tomorrow afternoon', 'ti-sun', 'Tomorrow, 13:00'),
    lopt('monday', 'Monday morning', 'ti-calendar-week', 'Monday, 08:00'),
  ],
  val: '',
  min: '2026-11-01T22:46',
  max: '2026-11-08T22:44',
  hasHint: false,
  hintText: '',
  invalid: false,
  showLimit: true,
  limitText: 'Up to 7 days ahead',
  tzShow: false,
  tzText: 'Time zone: Tokyo, Seoul (GMT+9)',
  btnDis: true,
};

/** Popover open (`anyMenu` applies then as well). */
const later = (patch: Partial<LaterValues> = {}) =>
  values({ later: { ...LATER, open: true, ...patch }, anyMenu: true });

// New email without recipients: focus in "To", one identity, no signature.
function values(patch: Partial<ComposeValues> = {}): ComposeValues {
  return {
    title: 'New email',
    backLabel: 'Inbox',
    discardLabel: 'Discard',
    status: '',
    statusM: '',
    hasStatus: false,
    statusIcon: 'ti-cloud-check',
    sendOff: false,
    from: SINGLE,
    fields: [field('to', 'To', { auto: true, showToggle: true })],
    anyMenu: false,
    subj: '',
    text: '',
    taAuto: false,
    ph: 'Write a message …',
    sig: '',
    sigShow: false,
    sigAdd: false,
    atts: [],
    hasAtts: false,
    attTitle: '0 attachments',
    hasQuote: false,
    quoteHead: '',
    quoteParas: [],
    quoteOpen: false,
    quoteExp: 'false',
    quoteChevT: 'none',
    later: LATER,
    ...patch,
  };
}

/** Reply with a quote of the original, collapsed or expanded. */
function quoted(open: boolean, patch: Partial<ComposeValues> = {}): ComposeValues {
  return draft({
    title: 'Reply',
    hasQuote: true,
    quoteHead: 'On Wednesday, October 28, 2026, 18:55, Anna Baker wrote:',
    quoteParas: [{ t: 'Hi Jane,' }, { t: 'attached is the draft.\nBy Friday?' }, { t: 'Best regards\nAnna' }],
    quoteOpen: open,
    quoteExp: open ? 'true' : 'false',
    quoteChevT: open ? 'rotate(180deg)' : 'none',
    ...patch,
  });
}

/** Hidden file input (`cm.fileRef`). */
const fileInput = (container: HTMLElement) => container.querySelector<HTMLInputElement>('input[type="file"]')!;

// Saved draft with Cc/Bcc, an invalid address and a signature.
function draft(patch: Partial<ComposeValues> = {}): ComposeValues {
  return values({
    title: 'Draft',
    discardLabel: 'Delete draft',
    status: 'Saved at 10:42',
    statusM: 'Saved at 10:42',
    hasStatus: true,
    fields: [
      field('to', 'To', {
        chips: [
          chip('0/anna.baker@example.com', 'Anna Baker', 'Anna Baker <anna.baker@example.com>', 'AB'),
          chip('1/anna@', 'anna@', 'anna@', '!', { bad: true }),
        ],
      }),
      field('cc', 'Cc', { chips: [chip('0/bernd@example.com', 'bernd@example.com', 'bernd@example.com', 'B')] }),
      field('bcc', 'Bcc'),
    ],
    subj: 'Feedback on the start page',
    text: 'Hi Anna,\n\nthe drafts look good.',
    taAuto: true,
    sig: 'Best regards\nAccount One',
    sigShow: true,
    ...patch,
  });
}

describe('compose', () => {
  afterEach(() => {
    hideTooltip();
    // The fake clock runs ahead of the real one: otherwise the tooltip controller would stay "warm".
    tooltips.hiddenAt = 0;
    ui.reset();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows head, fields and footer of a new email on desktop', async () => {
    const act = actions();
    const { getByRole, getByText, queryByRole, queryByText, container } = render(ComposeView, {
      cm: values(),
      act,
      isMobile: false,
    });
    expect(getByRole('toolbar', { name: 'New email' })).toBeInTheDocument();
    expect(getByRole('heading', { level: 1, name: 'New email' })).toBeInTheDocument();
    expect(container.querySelector('.status')).toBeNull();

    const back = getByRole('button', { name: 'Inbox' });
    expect(back.querySelector('svg')).toHaveClass('tabler-icon-arrow-left');
    await fireEvent.click(back);
    expect(act.close).toHaveBeenCalledOnce();
    const discard = getByRole('button', { name: 'Discard' });
    expect(discard.querySelector('svg')).toHaveClass('tabler-icon-trash');
    await fireEvent.click(discard);
    expect(act.discard).toHaveBeenCalledOnce();

    // One identity: only the row, no menu.
    expect(getByText('From')).toHaveClass('lbl');
    expect(queryByRole('button', { name: /Account One/ })).toBeNull();
    const one = container.querySelector('.from-one')!;
    expect(one.querySelector('strong')).toHaveTextContent('Account One');
    expect(one.querySelector('.f-mail')).toHaveTextContent('· account1@example.com');
    expect(one.querySelector('.f-av')).toHaveAttribute(
      'style',
      'background: rgb(148, 196, 141); color: rgb(19, 48, 15);',
    );
    expect(queryByText('Sign-in required')).toBeNull();

    const to = getByRole('combobox', { name: 'To' });
    expect(to).toHaveFocus();
    expect(to).toHaveAttribute('type', 'text');
    expect(to).toHaveAttribute('inputmode', 'email');
    expect(to).toHaveAttribute('autocomplete', 'off');
    expect(to).toHaveAttribute('autocapitalize', 'none');
    expect(to).toHaveAttribute('spellcheck', 'false');
    expect(to).not.toHaveAttribute('enterkeyhint');
    expect(to).toHaveAttribute('placeholder', 'Name or email address');
    expect(to).toHaveValue('');
    expect(queryByRole('combobox', { name: 'Cc' })).toBeNull();
    expect(queryByRole('combobox', { name: 'Bcc' })).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Cc/Bcc' }));
    expect(act.showCc).toHaveBeenCalledOnce();

    const subj = getByRole('textbox', { name: 'Subject' });
    expect(subj).toHaveAttribute('placeholder', 'What’s it about?');
    expect(subj).toHaveAttribute('maxlength', '250');
    const text = getByRole('textbox', { name: 'Message' });
    expect(text.tagName).toBe('TEXTAREA');
    expect(text).toHaveAttribute('placeholder', 'Write a message …');
    expect(text).not.toHaveFocus();
    expect(queryByRole('button', { name: /Signature/ })).toBeNull();
    expect(queryByRole('listbox')).toBeNull();
    expect(container.querySelector('.shield')).toBeNull();
    expect(container.querySelector('.atts')).toBeNull();
    expect(container.querySelector('.drop')).toBeNull();

    const send = getByRole('button', { name: 'Send' });
    expect(send.querySelector('svg')).toHaveClass('tabler-icon-send');
    await fireEvent.click(send);
    expect(act.send).toHaveBeenCalledOnce();
    await fireEvent.click(getByRole('button', { name: 'Send later' }));
    expect(act.later).toHaveBeenCalledOnce();
    const pick = vi.spyOn(fileInput(container), 'click');
    const attach = getByRole('button', { name: 'Attach' });
    expect(attach.querySelector('svg')).toHaveClass('tabler-icon-paperclip');
    await fireEvent.click(attach);
    expect(pick).toHaveBeenCalledOnce();
    expect(act.addFiles).not.toHaveBeenCalled();
    expect(getByText('Ctrl + Enter to send')).toHaveClass('hint');
  });

  it('shows ⌘ instead of Ctrl in tooltip and hint on macOS', async () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' });
    const { getByRole, getByText } = render(ComposeView, { cm: draft(), act: actions(), isMobile: false });
    expect(getByText('⌘ + Enter to send')).toHaveClass('hint');

    vi.useFakeTimers();
    await fireEvent.pointerEnter(getByRole('button', { name: 'Send' }), { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text).toBe('Send (⌘ + Enter)');
    await fireEvent.pointerLeave(getByRole('button', { name: 'Send' }), { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);
  });

  it('shows status, chips, Cc/Bcc and signature of a draft', async () => {
    const act = actions();
    const { getByRole, getByText, queryByRole, rerender, container } = render(ComposeView, {
      cm: draft(),
      act,
      isMobile: false,
    });
    expect(getByRole('heading', { level: 1, name: 'Draft' })).toBeInTheDocument();
    expect(getByRole('button', { name: 'Delete draft' })).toBeInTheDocument();
    const status = getByText('Saved at 10:42');
    expect(status).toHaveClass('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.querySelector('svg')).toHaveClass('tabler-icon-cloud-check');

    const to = getByRole('combobox', { name: 'To' });
    const chips = [...to.closest('.field')!.querySelectorAll<HTMLElement>('.chip')];
    expect(chips.map((c) => c.querySelector('.c-label')!.textContent)).toEqual(['Anna Baker', 'anna@']);
    expect(chips.map((c) => c.title)).toEqual(['Anna Baker <anna.baker@example.com>', 'anna@']);
    expect(chips[0]).not.toHaveClass('bad');
    expect(chips[0]!.querySelector('.av')).toHaveTextContent('AB');
    expect(chips[0]!.querySelector('.av')).toHaveAttribute(
      'style',
      'background: rgb(245, 160, 110); color: rgb(58, 27, 6);',
    );
    // Invalid address: red, avatar with "!" in the colors of the class instead of the values.
    expect(chips[1]).toHaveClass('bad');
    expect(chips[1]!.querySelector('.av')).toHaveTextContent('!');
    expect(chips[1]!.querySelector('.av')).not.toHaveAttribute('style');
    await fireEvent.click(getByRole('button', { name: 'Remove anna@' }));
    expect(act.remove).toHaveBeenCalledWith('to', 1);

    const cc = getByRole('combobox', { name: 'Cc' });
    expect(cc).toHaveAttribute('placeholder', '');
    expect(cc.closest('.field')!.querySelector('.c-label')).toHaveTextContent('bernd@example.com');
    await fireEvent.click(getByRole('button', { name: 'Remove bernd@example.com' }));
    expect(act.remove).toHaveBeenLastCalledWith('cc', 0);
    expect(getByRole('combobox', { name: 'Bcc' })).toBeInTheDocument();
    expect(queryByRole('button', { name: 'Cc/Bcc' })).toBeNull();

    // "To" has recipients: focus in the text.
    expect(to).not.toHaveFocus();
    const text = getByRole('textbox', { name: 'Message' });
    expect(text).toHaveFocus();
    expect(text).toHaveValue('Hi Anna,\n\nthe drafts look good.');
    expect(getByRole('textbox', { name: 'Subject' })).toHaveValue('Feedback on the start page');

    expect(container.querySelector('.sig-text')!.textContent).toBe('Best regards\nAccount One');
    expect(queryByRole('button', { name: 'Insert signature' })).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Remove signature' }));
    expect(act.toggleSig).toHaveBeenCalledOnce();

    await rerender({ cm: draft({ status: 'Saving …', statusIcon: 'ti-cloud-upload' }) });
    expect(getByText('Saving …').querySelector('svg')).toHaveClass('tabler-icon-cloud-upload');
  });

  it('marks a missing "To"', () => {
    const { getByRole, getByText } = render(ComposeView, {
      cm: values({ fields: [field('to', 'To', { err: true, ph: 'Add a recipient', showToggle: true })] }),
      act: actions(),
      isMobile: false,
    });
    expect(getByText('To')).toHaveClass('lbl', 'err');
    expect(getByRole('combobox', { name: 'To' })).toHaveAttribute('placeholder', 'Add a recipient');
  });

  it('offers "Insert signature" after removal', async () => {
    const act = actions();
    const { getByRole, container } = render(ComposeView, {
      cm: values({ sig: 'Best regards', sigAdd: true }),
      act,
      isMobile: false,
    });
    expect(container.querySelector('.sig')).toBeNull();
    const add = getByRole('button', { name: 'Insert signature' });
    expect(add.querySelector('svg')).toHaveClass('tabler-icon-signature');
    await fireEvent.click(add);
    expect(act.toggleSig).toHaveBeenCalledOnce();
  });

  it('shows the quote after the signature collapsed and expands it on click', async () => {
    const act = actions();
    const { getByRole, container, rerender } = render(ComposeView, { cm: quoted(false), act, isMobile: false });
    expect(getByRole('heading', { level: 1, name: 'Reply' })).toBeInTheDocument();
    const quote = container.querySelector<HTMLElement>('.quote')!;
    expect(quote.previousElementSibling).toHaveClass('sig');
    expect(quote.nextElementSibling).toBeNull();
    const head = getByRole('button', { name: /^On Wednesday, October 28, 2026, 18:55, Anna Baker wrote:$/ });
    expect(head).toHaveClass('q-head');
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(head.querySelector('.q-ico svg')).toHaveClass('tabler-icon-quote');
    const chev = head.querySelector<HTMLElement>('.q-chev')!;
    expect(chev.querySelector('svg')).toHaveClass('tabler-icon-chevron-down');
    expect(chev.style.transform).toBe('none');
    expect(container.querySelector('.q-body')).toBeNull();
    await fireEvent.click(head);
    expect(act.toggleQuote).toHaveBeenCalledOnce();

    await rerender({ cm: quoted(true) });
    expect(head).toHaveAttribute('aria-expanded', 'true');
    expect(chev.style.transform).toBe('rotate(180deg)');
    const paras = [...container.querySelectorAll('.q-body p')].map((p) => p.textContent);
    expect(paras).toEqual(['Hi Jane,', 'attached is the draft.\nBy Friday?', 'Best regards\nAnna']);
    await fireEvent.click(head);
    expect(act.toggleQuote).toHaveBeenCalledTimes(2);
    expect(act.toggleSig).not.toHaveBeenCalled();
  });

  it('shows the quote after "Insert signature", none without a quote', async () => {
    const { container, rerender } = render(ComposeView, {
      cm: quoted(false, { sigShow: false, sigAdd: true }),
      act: actions(),
      isMobile: false,
    });
    expect(container.querySelector('.quote')!.previousElementSibling).toHaveClass('sig-add');
    await rerender({ cm: draft() });
    expect(container.querySelector('.quote')).toBeNull();
  });

  it('shows the quote between signature and attachments on mobile', async () => {
    const act = actions();
    const { getByRole, container } = render(ComposeView, {
      cm: quoted(true, { atts: ATTS, hasAtts: true, attTitle: '2 attachments' }),
      act,
      isMobile: true,
    });
    const quote = container.querySelector<HTMLElement>('.m-extra > .quote')!;
    expect(quote.previousElementSibling).toHaveClass('sig');
    expect(quote.nextElementSibling).toHaveClass('atts');
    const head = getByRole('button', { name: /Anna Baker wrote:$/ });
    expect(head).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelectorAll('.q-body p')).toHaveLength(3);
    await fireEvent.click(head);
    expect(act.toggleQuote).toHaveBeenCalledOnce();
  });

  it('takes recipients via keyboard', async () => {
    const act = actions();
    const cm = draft({ taAuto: false });
    const { getByRole } = render(ComposeView, { cm, act, isMobile: false });
    const to = getByRole('combobox', { name: 'To' }) as HTMLInputElement;

    await fireEvent.focus(to);
    expect(act.focus).toHaveBeenCalledWith('to');
    await fireEvent.input(to, { target: { value: 'bernd' } });
    expect(act.input).toHaveBeenCalledWith('to', 'bernd');
    // Like a controlled field: afterwards the state's value applies (here unchanged empty).
    await tick();
    expect(to).toHaveValue('');

    to.value = 'bernd';
    expect(await fireEvent.keyDown(to, { key: 'Enter' })).toBe(false);
    expect(act.commit).toHaveBeenCalledWith('to');
    // Tab takes the input, but lets focus move on.
    expect(await fireEvent.keyDown(to, { key: 'Tab' })).toBe(true);
    expect(act.commit).toHaveBeenCalledTimes(2);
    expect(await fireEvent.keyDown(to, { key: 'Enter', isComposing: true })).toBe(true);
    expect(await fireEvent.keyDown(to, { key: 'Backspace' })).toBe(true);
    expect(act.commit).toHaveBeenCalledTimes(2);
    expect(act.removeLast).not.toHaveBeenCalled();

    expect(await fireEvent.keyDown(to, { key: 'Enter', ctrlKey: true })).toBe(false);
    expect(await fireEvent.keyDown(to, { key: 'Enter', metaKey: true })).toBe(false);
    expect(act.send).toHaveBeenCalledTimes(2);
    expect(act.commit).toHaveBeenCalledTimes(2);

    to.value = '';
    await fireEvent.keyDown(to, { key: 'Tab' });
    expect(act.commit).toHaveBeenCalledTimes(2);
    await fireEvent.keyDown(to, { key: 'Backspace' });
    expect(act.removeLast).toHaveBeenCalledWith('to');
    // Without chips nothing to remove.
    await fireEvent.keyDown(getByRole('combobox', { name: 'Bcc' }), { key: 'Backspace' });
    expect(act.removeLast).toHaveBeenCalledOnce();

    // Without suggestions ↓ and ↑ stay with the browser.
    expect(await fireEvent.keyDown(to, { key: 'ArrowDown' })).toBe(true);
    expect(await fireEvent.keyDown(to, { key: 'ArrowUp' })).toBe(true);
    expect(act.moveSuggestion).not.toHaveBeenCalled();
    expect(act.pickSuggestion).not.toHaveBeenCalled();

    await fireEvent.blur(to);
    expect(act.blur).toHaveBeenCalledWith('to');
  });

  it('shows suggestions below the field as a combobox', async () => {
    const act = actions();
    const { getByRole, getAllByRole, queryByRole, rerender, container } = render(ComposeView, {
      cm: suggesting(),
      act,
      isMobile: false,
    });
    const to = getByRole('combobox', { name: 'To' });
    const list = getByRole('listbox', { name: 'Suggestions' });
    expect(list).toHaveClass('sug');
    expect(to.closest('.field')).toContainElement(list);
    expect(to).toHaveAttribute('aria-autocomplete', 'list');
    expect(to).toHaveAttribute('aria-expanded', 'true');
    expect(to).toHaveAttribute('aria-controls', list.id);

    const opts = getAllByRole('option');
    expect(opts).toHaveLength(2);
    const [first, second] = opts as [HTMLElement, HTMLElement];
    expect(first).toHaveAccessibleName('Anna Baker anna.baker@example.com');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveClass('on');
    expect(first).toHaveAttribute('tabindex', '-1');
    expect(first.querySelector('.s-name')).toHaveTextContent('Anna Baker');
    expect(first.querySelector('.s-mail')).toHaveTextContent('anna.baker@example.com');
    const av = first.querySelector('.s-av')!;
    expect(av).toHaveTextContent('AB');
    expect(av).toHaveAttribute('aria-hidden', 'true');
    expect(av).toHaveAttribute('style', 'background: rgb(245, 160, 110); color: rgb(58, 27, 6);');
    // Without a name the address appears only once.
    expect(second).toHaveAccessibleName('anna@example.org');
    expect(second).toHaveAttribute('aria-selected', 'false');
    expect(second).not.toHaveClass('on');
    expect(second.querySelector('.s-mail')).toBeNull();
    expect(second.querySelector('.s-av')).toHaveTextContent('A');
    expect(to).toHaveAttribute('aria-activedescendant', first.id);

    // ↓ selects the next one: the active option moves with `on`.
    await rerender({ cm: suggesting(1) });
    expect(second).toHaveAttribute('aria-selected', 'true');
    expect(to).toHaveAttribute('aria-activedescendant', second.id);

    // Ids unique per field and entry.
    await rerender({
      cm: values({
        fields: [
          field('to', 'To', { val: 'an', hasSug: true, sug: SUG }),
          field('cc', 'Cc', { val: 'an', hasSug: true, sug: SUG.map((x) => ({ ...x, on: false })) }),
        ],
      }),
    });
    const ids = [...container.querySelectorAll('[role="listbox"], [role="option"]')].map((el) => el.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(ids.every(Boolean)).toBe(true);
    // Without a selected suggestion no active option.
    expect(getByRole('combobox', { name: 'Cc' })).not.toHaveAttribute('aria-activedescendant');

    await rerender({ cm: values({ fields: [field('to', 'To', { val: 'xyz' })] }) });
    expect(queryByRole('listbox')).toBeNull();
    expect(to).toHaveAttribute('aria-expanded', 'false');
    expect(to).not.toHaveAttribute('aria-controls');
    expect(to).not.toHaveAttribute('aria-activedescendant');
  });

  it('takes a suggestion via mouse without focus leaving the field', async () => {
    const act = actions();
    const { getByRole, getAllByRole } = render(ComposeView, { cm: suggesting(), act, isMobile: false });
    const to = getByRole('combobox', { name: 'To' });
    to.focus();
    const opt = getAllByRole('option')[1]!;
    expect(await fireEvent.mouseDown(opt)).toBe(false);
    expect(act.pickSuggestion).toHaveBeenCalledExactlyOnceWith('to', 1);
    expect(to).toHaveFocus();
    expect(act.blur).not.toHaveBeenCalled();
    // Only the press takes it (`onPick`), the mouse click afterwards not again.
    await fireEvent.click(opt, { detail: 1 });
    expect(act.pickSuggestion).toHaveBeenCalledOnce();
    // The edge of the list keeps focus in the field as well.
    expect(await fireEvent.mouseDown(getByRole('listbox', { name: 'Suggestions' }))).toBe(false);
    expect(to).toHaveFocus();
    // A click without a mouse (screen reader, `detail` 0) takes it.
    await fireEvent.click(getAllByRole('option')[0]!);
    expect(act.pickSuggestion).toHaveBeenLastCalledWith('to', 0);
  });

  it('selects and takes suggestions via keyboard', async () => {
    const act = actions();
    const { getByRole } = render(ComposeView, { cm: suggesting(), act, isMobile: false });
    const to = getByRole('combobox', { name: 'To' }) as HTMLInputElement;
    to.value = 'an';

    expect(await fireEvent.keyDown(to, { key: 'ArrowDown' })).toBe(false);
    expect(act.moveSuggestion).toHaveBeenLastCalledWith('to', 1);
    expect(await fireEvent.keyDown(to, { key: 'ArrowUp' })).toBe(false);
    expect(act.moveSuggestion).toHaveBeenLastCalledWith('to', -1);
    expect(act.moveSuggestion).toHaveBeenCalledTimes(2);

    // Enter and Tab take the selected suggestion, not the input; Tab stays in the field.
    expect(await fireEvent.keyDown(to, { key: 'Enter' })).toBe(false);
    expect(act.pickSuggestion).toHaveBeenLastCalledWith('to');
    expect(await fireEvent.keyDown(to, { key: 'Tab' })).toBe(false);
    expect(act.pickSuggestion).toHaveBeenCalledTimes(2);
    expect(act.pickSuggestion).toHaveBeenLastCalledWith('to');
    expect(act.commit).not.toHaveBeenCalled();

    // Ctrl/⌘ + Enter still sends.
    expect(await fireEvent.keyDown(to, { key: 'Enter', ctrlKey: true })).toBe(false);
    expect(await fireEvent.keyDown(to, { key: 'Enter', metaKey: true })).toBe(false);
    expect(act.send).toHaveBeenCalledTimes(2);
    expect(act.pickSuggestion).toHaveBeenCalledTimes(2);

    // Tab without input calls nothing and lets focus move on.
    to.value = '  ';
    expect(await fireEvent.keyDown(to, { key: 'Tab' })).toBe(true);
    expect(act.pickSuggestion).toHaveBeenCalledTimes(2);
    expect(act.commit).not.toHaveBeenCalled();
    // Nothing during composition (IME).
    expect(await fireEvent.keyDown(to, { key: 'ArrowDown', isComposing: true })).toBe(true);
    expect(act.moveSuggestion).toHaveBeenCalledTimes(2);
  });

  it('shows the suggestions below the field on mobile', async () => {
    const act = actions();
    const { getByRole, getAllByRole, container } = render(ComposeView, { cm: suggesting(), act, isMobile: true });
    const list = getByRole('listbox', { name: 'Suggestions' });
    expect(container.querySelector('.mob')).toContainElement(list);
    expect(getByRole('combobox', { name: 'To' })).toHaveAttribute('type', 'email');
    expect(getAllByRole('option')).toHaveLength(2);
    expect(await fireEvent.mouseDown(getAllByRole('option')[0]!)).toBe(false);
    expect(act.pickSuggestion).toHaveBeenCalledExactlyOnceWith('to', 0);
  });

  it('focuses the input on a click in the row', async () => {
    const act = actions();
    const { getByRole } = render(ComposeView, { cm: draft({ taAuto: false }), act, isMobile: false });
    const to = getByRole('combobox', { name: 'To' });
    const row = to.closest('.field')!;
    expect(row).toHaveAttribute('role', 'presentation');
    expect(to).not.toHaveFocus();
    expect(await fireEvent.mouseDown(row.querySelector('.lbl')!)).toBe(false);
    expect(to).toHaveFocus();

    to.blur();
    expect(await fireEvent.mouseDown(getByRole('button', { name: 'Remove Anna Baker' }))).toBe(true);
    expect(to).not.toHaveFocus();
    expect(await fireEvent.mouseDown(row)).toBe(false);
    expect(to).toHaveFocus();
  });

  it('jumps from the subject into the text and sends with Ctrl + Enter', async () => {
    const act = actions();
    const { getByRole } = render(ComposeView, { cm: draft({ taAuto: false }), act, isMobile: false });
    const subj = getByRole('textbox', { name: 'Subject' });
    const text = getByRole('textbox', { name: 'Message' });

    await fireEvent.input(subj, { target: { value: 'New subject' } });
    expect(act.setSubject).toHaveBeenCalledWith('New subject');
    expect(await fireEvent.keyDown(subj, { key: 'a' })).toBe(true);
    expect(await fireEvent.keyDown(subj, { key: 'Enter' })).toBe(false);
    expect(text).toHaveFocus();
    expect(act.send).not.toHaveBeenCalled();
    expect(await fireEvent.keyDown(subj, { key: 'Enter', ctrlKey: true })).toBe(false);
    expect(act.send).toHaveBeenCalledOnce();

    await fireEvent.input(text, { target: { value: 'Hello' } });
    expect(act.setText).toHaveBeenCalledWith('Hello');
    // Enter alone is a line break.
    expect(await fireEvent.keyDown(text, { key: 'Enter' })).toBe(true);
    expect(act.send).toHaveBeenCalledOnce();
    expect(await fireEvent.keyDown(text, { key: 'Enter', metaKey: true })).toBe(false);
    expect(act.send).toHaveBeenCalledTimes(2);
  });

  it('chooses with several identities in the "Send as" menu', async () => {
    const act = actions();
    const { getByRole, getAllByRole, queryByRole, rerender, container } = render(ComposeView, {
      cm: values({ from: MULTI }),
      act,
      isMobile: false,
    });
    const btn = getByRole('button', { name: /Account One/ });
    expect(btn).toHaveAttribute('aria-haspopup', 'listbox');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn.querySelector('.f-chev svg')).toHaveClass('tabler-icon-chevron-down');
    expect(btn.querySelector('.f-av')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.from-one')).toBeNull();
    expect(queryByRole('listbox')).toBeNull();
    await fireEvent.click(btn);
    expect(act.toggleFrom).toHaveBeenCalledOnce();

    await rerender({ cm: values({ from: { ...MULTI, open: true }, anyMenu: true }) });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const list = getByRole('listbox', { name: 'Send as' });
    expect(list.querySelector('.menu-head')).toHaveTextContent('Send as');
    const options = getAllByRole('option');
    expect(options.map((o) => o.querySelector('.o-name')!.textContent)).toEqual([
      'Account One',
      'Sales',
      'account2@example.org',
    ]);
    expect(options.map((o) => o.querySelector('.o-mail')!.textContent)).toEqual([
      'account1@example.com',
      'sales@example.com',
      'account2@example.org',
    ]);
    expect(options.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(options[0]).toHaveClass('on');
    expect(options[1]).not.toHaveClass('on');
    expect(options[1]!.querySelector('.o-av')).toHaveTextContent('S');
    expect(options[1]!.querySelector('.o-av')).toHaveAttribute(
      'style',
      'background: rgb(148, 196, 141); color: rgb(19, 48, 15);',
    );

    await fireEvent.click(options[1]!);
    expect(act.pickFrom).toHaveBeenCalledWith('a1/i2');
    await fireEvent.mouseDown(container.querySelector('.shield')!);
    expect(act.closeMenu).toHaveBeenCalledOnce();
  });

  it('reports "Sign-in required" on desktop', () => {
    const { getByText } = render(ComposeView, {
      cm: values({ from: { ...SINGLE, stale: true } }),
      act: actions(),
      isMobile: false,
    });
    const stale = getByText('Sign-in required');
    expect(stale).toHaveClass('stale');
    expect(stale.querySelector('svg')).toHaveClass('tabler-icon-alert-circle');
  });

  it('opens the popover "Send later" above the button on desktop', async () => {
    const act = actions();
    const { getByRole, queryByRole, rerender, container } = render(ComposeView, {
      cm: values(),
      act,
      isMobile: false,
    });
    const btn = getByRole('button', { name: 'Send later' });
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-disabled', 'false');
    expect(btn).not.toHaveClass('open');
    expect(btn).not.toHaveClass('dis');
    expect(btn.querySelector('svg')).toHaveClass('tabler-icon-clock');
    expect(queryByRole('dialog')).toBeNull();

    await rerender({ cm: later() });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).toHaveClass('open');
    const pop = getByRole('dialog', { name: 'Send later' });
    expect(container.querySelector('.later-wrap')).toContainElement(pop);
    expect(pop.querySelector('.menu-head')).toHaveTextContent('Send later');
    const opts = Array.from(pop.querySelectorAll('.l-opt'));
    expect(opts.map((o) => o.querySelector('.l-label')!.textContent)).toEqual([
      'Tomorrow morning',
      'Tomorrow afternoon',
      'Monday morning',
    ]);
    expect(opts.map((o) => o.querySelector('.l-sub')!.textContent)).toEqual([
      'Tomorrow, 08:00',
      'Tomorrow, 13:00',
      'Monday, 08:00',
    ]);
    expect(opts[0]!.querySelector('.l-ico svg')).toHaveClass('tabler-icon-sunrise');
    expect(opts[1]!.querySelector('.l-ico svg')).toHaveClass('tabler-icon-sun');
    expect(opts[2]!.querySelector('.l-ico svg')).toHaveClass('tabler-icon-calendar-week');
    expect(opts.map((o) => o.getAttribute('aria-disabled'))).toEqual(['false', 'false', 'false']);
    await fireEvent.click(opts[0]!);
    expect(act.pickLater).toHaveBeenCalledWith('morning');

    const field = within(pop).getByLabelText('Date and time');
    expect(field).toHaveAttribute('id', 'cmp-later');
    expect(field).toHaveAttribute('type', 'datetime-local');
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('min', '2026-11-01T22:46');
    expect(field).toHaveAttribute('max', '2026-11-08T22:44');
    expect(field).toHaveAttribute('aria-invalid', 'false');
    expect(field).toHaveAttribute('aria-describedby', 'cmp-later-hint');
    expect(field).toHaveAccessibleDescription('Up to 7 days ahead');
    expect(container.querySelector('#cmp-later-hint')).toHaveClass('l-note');
    expect(within(pop).queryByRole('alert')).toBeNull();
    expect(within(pop).queryByText(/Time zone/)).toBeNull();
    await fireEvent.input(field, { target: { value: '2026-11-02T08:00' } });
    expect(act.setLater).toHaveBeenCalledWith('2026-11-02T08:00');

    // Without a time "Schedule" is disabled, but stays focusable; on desktop next to the field.
    const go = within(pop).getByRole('button', { name: 'Schedule' });
    expect(go.parentElement).toHaveClass('l-row');
    expect(go).toHaveAttribute('aria-disabled', 'true');
    expect(go).toHaveClass('dis');
    expect(go).not.toBeDisabled();
    await fireEvent.click(go);
    expect(act.plan).not.toHaveBeenCalled();

    await rerender({ cm: later({ val: '2026-11-02T08:00', btnDis: false }) });
    expect(field).toHaveValue('2026-11-02T08:00');
    expect(go).toHaveAttribute('aria-disabled', 'false');
    expect(go).not.toHaveClass('dis');
    await fireEvent.click(go);
    expect(act.plan).toHaveBeenCalledOnce();

    await fireEvent.mouseDown(container.querySelector('.shield')!);
    expect(act.closeMenu).toHaveBeenCalledOnce();
  });

  it('shows the hint instead of the limit, the time zone and disabled presets in the popover', async () => {
    const act = actions();
    const { getByRole, queryByText } = render(ComposeView, {
      cm: later({
        opts: [
          LATER.opts[0]!,
          LATER.opts[1]!,
          lopt('monday', 'Monday morning', 'ti-calendar-week', 'More than 7 days ahead', true),
        ],
        val: '2026-11-10T08:00',
        hasHint: true,
        hintText: 'Please choose a time no more than 7 days ahead.',
        invalid: true,
        showLimit: false,
        tzShow: true,
      }),
      act,
      isMobile: false,
    });
    const pop = getByRole('dialog', { name: 'Send later' });
    const monday = within(pop).getByRole('button', { name: /Monday morning/ });
    expect(monday).toHaveAttribute('aria-disabled', 'true');
    expect(monday).toHaveClass('dis');
    expect(monday).not.toBeDisabled();
    expect(monday.querySelector('.l-sub')).toHaveTextContent('More than 7 days ahead');
    await fireEvent.click(monday);
    expect(act.pickLater).not.toHaveBeenCalled();

    const hint = within(pop).getByRole('alert');
    expect(hint).toHaveTextContent('Please choose a time no more than 7 days ahead.');
    expect(hint).toHaveAttribute('id', 'cmp-later-hint');
    expect(hint).toHaveClass('l-hint');
    expect(queryByText('Up to 7 days ahead')).toBeNull();
    const field = within(pop).getByLabelText('Date and time');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Please choose a time no more than 7 days ahead.');
    const tz = within(pop).getByText('Time zone: Tokyo, Seoul (GMT+9)');
    expect(tz).toHaveClass('l-note');
    expect(hint.nextElementSibling).toBe(tz);
    expect(within(pop).getByRole('button', { name: 'Schedule' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('disables "Send later" without scheduled sending, with a tooltip', async () => {
    const act = actions();
    const tip = 'Your mail server doesn’t support scheduled sending';
    const { getByRole, queryByRole } = render(ComposeView, {
      cm: values({ later: { ...LATER, dis: true, tip } }),
      act,
      isMobile: false,
    });
    const btn = getByRole('button', { name: 'Send later' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveClass('dis');
    expect(btn).not.toBeDisabled();

    vi.useFakeTimers();
    await fireEvent.pointerEnter(btn, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text).toBe(tip);
    await fireEvent.pointerLeave(btn, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);

    // The state decides (a toast on mobile), the component calls anyway.
    await fireEvent.click(btn);
    expect(act.later).toHaveBeenCalledOnce();
    expect(queryByRole('dialog')).toBeNull();
  });

  it('shows `status` on desktop, the shorter `statusM` on mobile', () => {
    const cm = draft({
      status: 'Saved offline at 10:42',
      statusM: 'Saved locally',
      statusIcon: 'ti-cloud-off',
    });
    const desktop = render(ComposeView, { cm, act: actions(), isMobile: false });
    const status = desktop.getByText('Saved offline at 10:42');
    expect(status.querySelector('svg')).toHaveClass('tabler-icon-cloud-off');
    expect(desktop.queryByText('Saved locally')).toBeNull();
    desktop.unmount();

    const mobile = render(ComposeView, { cm, act: actions(), isMobile: true });
    expect(mobile.container.querySelector('.m-status')).toHaveTextContent(/^Saved locally$/);
    expect(mobile.queryByText('Saved offline at 10:42')).toBeNull();
  });

  it('visibly disables "Send" without a connection, the state still decides', async () => {
    const act = actions();
    const { getByRole, rerender } = render(ComposeView, { cm: draft({ sendOff: true }), act, isMobile: false });
    const send = getByRole('button', { name: 'Send' });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).toHaveClass('off');
    // Stays focusable like "Send later" (`aria-disabled`, not `disabled`).
    expect(send).not.toBeDisabled();

    vi.useFakeTimers();
    await fireEvent.pointerEnter(send, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text).toBe('Not available offline. Your draft is saved.');
    await fireEvent.pointerLeave(send, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);

    await fireEvent.click(send);
    expect(act.send).toHaveBeenCalledOnce();

    await rerender({ cm: draft() });
    expect(send).toHaveAttribute('aria-disabled', 'false');
    expect(send).not.toHaveClass('off');
    await fireEvent.pointerEnter(send, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text).toMatch(/^Send \(/);
    await fireEvent.pointerLeave(send, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);
  });

  it('disables "Send" on mobile too with `aria-disabled`', async () => {
    const act = actions();
    const { getByRole, rerender } = render(ComposeView, { cm: draft({ sendOff: true }), act, isMobile: true });
    const send = getByRole('button', { name: 'Send' });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).toHaveClass('off');
    await fireEvent.click(send);
    expect(act.send).toHaveBeenCalledOnce();
    await rerender({ cm: draft() });
    expect(send).toHaveAttribute('aria-disabled', 'false');
  });

  it('shows the actions in the head and the fields in the card on mobile', async () => {
    const act = actions();
    const { getByRole, getByText, queryByRole, queryByText, rerender, container } = render(ComposeView, {
      cm: draft({ from: { ...MULTI, stale: true } }),
      act,
      isMobile: true,
    });
    expect(container.querySelector('.cmp')).toHaveClass('mob');
    // On mobile the whole page is the main landmark, the title its heading.
    expect(getByRole('main')).toHaveClass('cmp');
    expect(getByRole('heading', { level: 1 })).toHaveClass('m-title');
    expect(queryByRole('toolbar')).toBeNull();
    expect(container.querySelector('.m-title')).toHaveTextContent('Draft');
    expect(container.querySelector('.m-status')).toHaveTextContent('Saved at 10:42');
    expect(queryByText('Ctrl + Enter to send')).toBeNull();

    await fireEvent.click(getByRole('button', { name: 'Close' }));
    expect(act.close).toHaveBeenCalledOnce();
    const pick = vi.spyOn(fileInput(container), 'click');
    await fireEvent.click(getByRole('button', { name: 'Add attachment' }));
    expect(pick).toHaveBeenCalledOnce();
    await fireEvent.click(getByRole('button', { name: 'Send later' }));
    expect(act.later).toHaveBeenCalledOnce();
    await fireEvent.click(getByRole('button', { name: 'Send' }));
    expect(act.send).toHaveBeenCalledOnce();

    const card = container.querySelector('.m-card') as HTMLElement;
    expect(card).toHaveClass('m-card', 'no-scrollbar');
    expect(card.style.marginBottom).toBe(M_TAB_PAD_B);
    expect(getByText('Sign-in required for this account.')).toHaveClass('stale-row');
    expect(card.querySelector('.f-name')).toHaveTextContent('Account One');
    expect(card.querySelector('.f-chev')).not.toBeNull();

    const to = getByRole('combobox', { name: 'To' });
    expect(to).toHaveAttribute('type', 'email');
    expect(to).toHaveAttribute('enterkeyhint', 'next');
    expect(getByRole('textbox', { name: 'Subject' })).toHaveAttribute('enterkeyhint', 'next');
    expect(getByRole('textbox', { name: 'Message' })).toHaveFocus();
    expect(card.querySelector('.sig-text')!.textContent).toBe('Best regards\nAccount One');

    // "Delete draft" stands as text below the content on mobile.
    const discard = getByRole('button', { name: 'Delete draft' });
    expect(card).toContainElement(discard);
    await fireEvent.click(discard);
    expect(act.discard).toHaveBeenCalledOnce();

    // On mobile the row opens the menu even with one identity, just without an arrow.
    await rerender({ cm: draft({ from: { ...SINGLE, open: true }, anyMenu: true }) });
    expect(queryByText('Sign-in required for this account.')).toBeNull();
    const btn = getByRole('button', { name: /Account One/ });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn.querySelector('.f-chev')).toBeNull();
    await fireEvent.click(btn);
    expect(act.toggleFrom).toHaveBeenCalledOnce();
    expect(getByRole('listbox', { name: 'Send as' })).toBeInTheDocument();
    await fireEvent.click(getByRole('option', { name: /Account One/ }));
    expect(act.pickFrom).toHaveBeenCalledWith('a1/');
    await fireEvent.mouseDown(container.querySelector('.shield')!);
    expect(act.closeMenu).toHaveBeenCalledOnce();
  });

  it('shows the popover "Send later" below the top bar on mobile', async () => {
    const act = actions();
    const { getByRole, queryByRole, rerender, container } = render(ComposeView, {
      cm: values(),
      act,
      isMobile: true,
    });
    const btn = getByRole('button', { name: 'Send later' });
    expect(btn).toHaveClass('m-icon');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-disabled', 'false');
    expect(btn).not.toHaveClass('dis');
    expect(queryByRole('dialog')).toBeNull();

    await rerender({ cm: later({ val: '2026-11-02T08:00', btnDis: false, tzShow: true }) });
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    const pop = getByRole('dialog', { name: 'Send later' });
    expect(container.querySelector('.m-top')).toContainElement(pop);
    expect(container.querySelector('.later-wrap')).toBeNull();
    await fireEvent.click(within(pop).getByRole('button', { name: /Tomorrow afternoon/ }));
    expect(act.pickLater).toHaveBeenCalledWith('afternoon');

    const field = within(pop).getByLabelText('Date and time');
    expect(field).toHaveAttribute('id', 'cmp-later-m');
    expect(field).toHaveAttribute('aria-describedby', 'cmp-later-m-hint');
    expect(field).toHaveAccessibleDescription('Up to 7 days ahead');
    expect(field).toHaveValue('2026-11-02T08:00');
    await fireEvent.input(field, { target: { value: '2026-11-03T09:30' } });
    expect(act.setLater).toHaveBeenCalledWith('2026-11-03T09:30');

    // "Schedule" as a wide button below the limit and time zone.
    expect(pop.querySelector('.l-row')).toBeNull();
    const form = pop.querySelector('.l-form')!;
    expect(Array.from(form.children, (c) => c.classList[0])).toEqual(['l-lbl', 'l-in', 'l-note', 'l-note', 'l-go']);
    const go = within(pop).getByRole('button', { name: 'Schedule' });
    expect(go).toHaveAttribute('aria-disabled', 'false');
    await fireEvent.click(go);
    expect(act.plan).toHaveBeenCalledOnce();
    await fireEvent.mouseDown(container.querySelector('.shield')!);
    expect(act.closeMenu).toHaveBeenCalledOnce();

    // Disabled: dimmed, but operable (the state shows the hint as a toast).
    await rerender({
      cm: values({ later: { ...LATER, dis: true, tip: 'Your mail server doesn’t support scheduled sending' } }),
    });
    expect(queryByRole('dialog')).toBeNull();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).toHaveClass('dis');
    await fireEvent.click(btn);
    expect(act.later).toHaveBeenCalledOnce();
  });

  it('focuses "To" of a new email on mobile', () => {
    const { getByRole } = render(ComposeView, { cm: values(), act: actions(), isMobile: true });
    expect(getByRole('combobox', { name: 'To' })).toHaveFocus();
    expect(getByRole('textbox', { name: 'Message' })).not.toHaveFocus();
  });

  it('focuses the text of a draft without scrolling, so heading and fields stay in view', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    try {
      for (const isMobile of [false, true]) {
        focus.mockClear();
        const { getByRole, unmount } = render(ComposeView, { cm: draft(), act: actions(), isMobile });
        const text = getByRole('textbox', { name: 'Message' });
        expect(text).toHaveFocus();
        expect(focus.mock.contexts).toEqual([text]);
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        unmount();
      }
      // "To" of a new email sits at the top and keeps the plain focus.
      focus.mockClear();
      const { getByRole } = render(ComposeView, { cm: values(), act: actions(), isMobile: false });
      expect(focus.mock.contexts).toEqual([getByRole('combobox', { name: 'To' })]);
      expect(focus).toHaveBeenCalledWith();
    } finally {
      focus.mockRestore();
    }
  });

  it('shows the attachments as tiles after the signature on desktop', async () => {
    const act = actions();
    const { getByRole, queryByRole, getByText, container } = render(ComposeView, {
      cm: draft({ atts: ATTS, hasAtts: true, attTitle: '2 attachments' }),
      act,
      isMobile: false,
    });
    const atts = container.querySelector('.atts')!;
    expect(container.querySelector('.wrap')).toContainElement(atts as HTMLElement);
    expect(container.querySelector('.sig')!.compareDocumentPosition(atts) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(getByText('2 attachments')).toHaveClass('att-title');

    const tiles = [...atts.querySelectorAll<HTMLElement>('.att-list > .att')];
    expect(tiles.map((t) => t.querySelector('.att-name')!.textContent)).toEqual(['Proposal_2026.pdf', 'homepage.png']);
    expect(tiles.map((t) => t.querySelector('.att-sub')!.textContent)).toEqual(['240 KB', 'Uploading …']);
    expect(tiles[0]!.querySelector('.att-ico svg')).toHaveClass('tabler-icon-file-type-pdf');
    expect(tiles[1]!.querySelector('.att-ico svg')).toHaveClass('tabler-icon-cloud-upload');
    // Dimmed while uploading (`op` 0.6).
    expect(tiles[0]).not.toHaveClass('up');
    expect(tiles[1]).toHaveClass('up');

    expect(queryByRole('button', { name: /Upload .* again/ })).toBeNull();
    const rm = getByRole('button', { name: 'Remove homepage.png' });
    expect(rm.querySelector('svg')).toHaveClass('tabler-icon-x');
    await fireEvent.click(rm);
    expect(act.removeAttachment).toHaveBeenCalledWith('a2');
    await fireEvent.click(getByRole('button', { name: 'Remove Proposal_2026.pdf' }));
    expect(act.removeAttachment).toHaveBeenLastCalledWith('a1');

    vi.useFakeTimers();
    await fireEvent.pointerEnter(rm, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text).toBe('Remove');
    await fireEvent.pointerLeave(rm, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);
  });

  it.each([false, true])('shows a failed tile with "Try again" before "×" (mobile: %s)', async (isMobile) => {
    const act = actions();
    const { getByRole, container } = render(ComposeView, {
      cm: draft({
        atts: [att('a3', 'Report.pdf', 'ti-alert-circle', 'Upload failed', false, true)],
        hasAtts: true,
        attTitle: '1 attachment',
      }),
      act,
      isMobile,
    });
    const tile = container.querySelector<HTMLElement>('.att')!;
    expect(tile).toHaveClass('failed');
    expect(tile).not.toHaveClass('up');
    expect(tile.querySelector('.att-ico svg')).toHaveClass('tabler-icon-alert-circle');
    expect(tile.querySelector('.att-sub')).toHaveTextContent('Upload failed');
    expect(tile.querySelector('.att-sub')).toHaveAttribute('aria-live', 'polite');
    const retry = getByRole('button', { name: 'Upload Report.pdf again' });
    const rm = getByRole('button', { name: 'Remove Report.pdf' });
    expect(retry.querySelector('svg')).toHaveClass('tabler-icon-refresh');
    expect(retry.compareDocumentPosition(rm) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await fireEvent.click(retry);
    expect(act.retryAttachment).toHaveBeenCalledExactlyOnceWith('a3');
    expect(act.removeAttachment).not.toHaveBeenCalled();

    // Tooltip on desktop only.
    vi.useFakeTimers();
    await fireEvent.pointerEnter(retry, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip?.text ?? null).toBe(isMobile ? null : 'Try again');
    await fireEvent.pointerLeave(retry, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_FADE + TIP_DELAY);
  });

  it('attaches chosen files and clears the file input', async () => {
    const act = actions();
    const { container } = render(ComposeView, { cm: values(), act, isMobile: false });
    const input = fileInput(container);
    expect(input).toHaveClass('file-in');
    expect(input).toHaveAttribute('multiple');
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input).toHaveAttribute('aria-hidden', 'true');

    // Empty afterwards, so that the same file can be chosen again.
    const setValue = vi.fn();
    Object.defineProperty(input, 'value', { configurable: true, get: () => '', set: setValue });
    const files = [pdf(), png()];
    await fireEvent.change(input, { target: { files } });
    expect(act.addFiles).toHaveBeenCalledExactlyOnceWith(files);
    expect(setValue).toHaveBeenCalledExactlyOnceWith('');
  });

  it('accepts dropped files on desktop', async () => {
    const act = actions();
    const { container } = render(ComposeView, { cm: values(), act, isMobile: false });
    const page = container.querySelector<HTMLElement>('.cmp.desk')!;
    expect(page).toHaveAttribute('role', 'presentation');
    const child = container.querySelector<HTMLElement>('.wrap')!;
    const files = [pdf()];
    const dt = { types: ['Files'], files };

    /** dragleave with a target (jsdom has no DragEvent with `relatedTarget`). */
    const leave = async (to: Element | null) => {
      const ev = createEvent.dragLeave(page, { dataTransfer: dt });
      Object.defineProperty(ev, 'relatedTarget', { value: to });
      await fireEvent(page, ev);
    };

    expect(await fireEvent.dragEnter(page, { dataTransfer: dt })).toBe(false);
    const drop = container.querySelector('.drop')!;
    expect(page).toContainElement(drop as HTMLElement);
    expect(drop).toHaveTextContent('Drop files here to attach');
    expect(drop.querySelector('svg')).toHaveClass('tabler-icon-paperclip');

    // Switch to a child element: dragenter there before dragleave here, the overlay stays.
    await fireEvent.dragEnter(child, { dataTransfer: dt });
    await leave(child);
    expect(container.querySelector('.drop')).not.toBeNull();
    expect(await fireEvent.dragOver(child, { dataTransfer: dt })).toBe(false);

    expect(await fireEvent.drop(child, { dataTransfer: dt })).toBe(false);
    expect(act.addFiles).toHaveBeenCalledExactlyOnceWith(files);
    expect(container.querySelector('.drop')).toBeNull();

    // Leaving the page (no target) ends dragging, even if the counter drifted.
    await fireEvent.dragEnter(page, { dataTransfer: dt });
    await fireEvent.dragEnter(child, { dataTransfer: dt });
    await leave(null);
    expect(container.querySelector('.drop')).toBeNull();
    // Cancelling is based on the content: dragover shows the overlay again, a drop never opens the file in the tab.
    expect(await fireEvent.dragOver(page, { dataTransfer: dt })).toBe(false);
    expect(container.querySelector('.drop')).not.toBeNull();
    await leave(null);
    expect(await fireEvent.drop(page, { dataTransfer: dt })).toBe(false);
    expect(act.addFiles).toHaveBeenCalledTimes(2);
  });

  it('leaves dragged text with the browser without an overlay', async () => {
    const act = actions();
    const { container } = render(ComposeView, { cm: values(), act, isMobile: false });
    const page = container.querySelector<HTMLElement>('.cmp.desk')!;
    const dt = { types: ['text/plain'], files: [] };
    expect(await fireEvent.dragEnter(page, { dataTransfer: dt })).toBe(true);
    expect(container.querySelector('.drop')).toBeNull();
    expect(await fireEvent.dragOver(page, { dataTransfer: dt })).toBe(true);
    expect(await fireEvent.drop(page, { dataTransfer: dt })).toBe(true);
    expect(act.addFiles).not.toHaveBeenCalled();
  });

  it('shows the attachments as a list before "Discard" on mobile, without dropping', async () => {
    const act = actions();
    const { getByRole, getByText, container } = render(ComposeView, {
      cm: draft({ atts: ATTS.slice(0, 1), hasAtts: true, attTitle: '1 attachment' }),
      act,
      isMobile: true,
    });
    const extra = container.querySelector<HTMLElement>('.m-extra')!;
    const atts = extra.querySelector('.atts')!;
    expect(atts).not.toBeNull();
    const discard = getByRole('button', { name: 'Delete draft' });
    expect(atts.compareDocumentPosition(discard) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(getByText('1 attachment')).toHaveClass('att-title');
    expect(atts.querySelector('.att-name')).toHaveTextContent('Proposal_2026.pdf');
    expect(atts.querySelector('.att-sub')).toHaveTextContent('240 KB');

    const rm = getByRole('button', { name: 'Remove Proposal_2026.pdf' });
    await fireEvent.click(rm);
    expect(act.removeAttachment).toHaveBeenCalledWith('a1');
    // No tooltip on mobile.
    vi.useFakeTimers();
    await fireEvent.pointerEnter(rm, { pointerType: 'mouse' });
    vi.advanceTimersByTime(TIP_DELAY);
    expect(ui.tip).toBeNull();

    const files = [png()];
    await fireEvent.change(fileInput(container), { target: { files } });
    expect(act.addFiles).toHaveBeenCalledExactlyOnceWith(files);

    const page = container.querySelector<HTMLElement>('.cmp.mob')!;
    expect(page).not.toHaveAttribute('role');
    expect(await fireEvent.dragEnter(page, { dataTransfer: { types: ['Files'], files } })).toBe(true);
    expect(container.querySelector('.drop')).toBeNull();
  });
});
