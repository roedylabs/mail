import { fireEvent, render, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import type {
  RuleActValues,
  RuleCondValues,
  RuleEditorValues,
  RuleRow,
  RulesNote,
  RulesValues,
} from '#lib/rules-page.svelte.ts';
import MailRules from './MailRules.svelte';

const REDIR =
  'Your mail server forwards a message only once. If it matches several forwarding actions, not all of them go out.';

function row(i: number, name: string, over: Partial<RuleRow> = {}): RuleRow {
  return {
    id: `r${i}`,
    n: String(i),
    name,
    sum: `If sender contains "${name}": delete`,
    on: true,
    canUp: true,
    canDown: true,
    toggle: vi.fn(),
    up: vi.fn(),
    down: vi.fn(),
    edit: vi.fn(),
    ...over,
  };
}

function rows(): RuleRow[] {
  return [
    row(1, 'File invoices', { canUp: false }),
    row(2, 'Newsletter', { on: false }),
    row(3, 'Flag large attachments', { canDown: false }),
  ];
}

function note(over: Partial<RulesNote> = {}): RulesNote {
  return {
    kind: 'vacation',
    icon: 'ti-beach',
    warn: false,
    text: 'Your vacation reply is on, so forwarding and filter rules are paused.',
    isGo: true,
    isOn: false,
    act: 'Go to vacation reply',
    busy: false,
    fn: vi.fn(),
    ...over,
  };
}

function values(over: Partial<RulesValues> = {}): RulesValues {
  return {
    load: null,
    loadTitle: 'Couldn’t load the rules',
    noSieve: false,
    noSieveText:
      'mail.example.test doesn’t offer Sieve, so forwarding and filter rules can’t be set up for this account.',
    sieveOk: true,
    st: 'ours',
    notes: false,
    note: null,
    dmg: false,
    dmgText: 'The Sieve script for these rules was changed in another app.',
    fwdOn: false,
    fwdTo: '',
    fwdKeep: true,
    fwdSum: 'Off',
    fwdErr: '',
    onFwdTo: vi.fn(),
    onFwdCommit: vi.fn(),
    toggleFwd: vi.fn(),
    toggleKeep: vi.fn(),
    redirWarn: false,
    redirText: REDIR,
    rows: rows(),
    empty: false,
    has: true,
    ed: false,
    add: vi.fn(),
    sieve: 'require ["fileinto", "imap4flags", "copy"];',
    sieveOpen: false,
    sieveLabel: 'Show Sieve script',
    toggleSieve: vi.fn(),
    copySieve: vi.fn(),
    ...over,
  };
}

function cond(over: Partial<RuleCondValues> = {}): RuleCondValues {
  return {
    f: 'from',
    v: 'invoice@',
    hasV: true,
    hasUnit: false,
    ph: 'e.g. billing@',
    lead: 'If',
    canRm: false,
    onF: vi.fn(),
    onV: vi.fn(),
    rm: vi.fn(),
    ...over,
  };
}

function act(over: Partial<RuleActValues> = {}): RuleActValues {
  return {
    a: 'move',
    v: 'f2',
    isPick: true,
    isMail: false,
    pickOpen: false,
    pickLabel: 'Invoices',
    pickIcon: 'ti-folder',
    pickAria: 'Folder: Invoices',
    pickTitle: 'Folder',
    pickToggle: vi.fn(),
    pickKey: vi.fn(),
    pickKeyUp: vi.fn(),
    pickActive: 0,
    opts: [
      { id: 'f1', label: 'Archive', depth: 0, on: false, hi: false, onClick: vi.fn() },
      { id: 'f2', label: 'Invoices', depth: 1, on: true, hi: false, onClick: vi.fn() },
    ],
    lead: 'Then',
    canRm: false,
    onA: vi.fn(),
    onV: vi.fn(),
    rm: vi.fn(),
    ...over,
  };
}

function editor(over: Partial<RuleEditorValues> = {}): RuleEditorValues {
  return {
    title: 'New rule',
    name: '',
    onName: vi.fn(),
    matchOpts: [
      { value: 'all', label: 'All conditions', on: true, onClick: vi.fn() },
      { value: 'any', label: 'Any condition', on: false, onClick: vi.fn() },
    ],
    conds: [cond()],
    acts: [act()],
    addC: vi.fn(),
    addA: vi.fn(),
    redirWarn: false,
    redirText: REDIR,
    err: '',
    save: vi.fn(),
    cancel: vi.fn(),
    canDel: false,
    del: vi.fn(),
    pickClose: vi.fn(),
    ...over,
  };
}

function setup(over: Partial<RulesValues> = {}, re: RuleEditorValues | null = null, isMobile = false) {
  const v = values({ ed: re !== null, ...over });
  const view = render(MailRules, { ...v, re, isMobile });
  return { view, v };
}

describe('email account › rules', () => {
  it('moves focus to "Add rule" after the editor closes (desktop and mobile)', async () => {
    for (const isMobile of [false, true]) {
      const { view, v } = setup({}, editor(), isMobile);
      const name = view.getByRole('textbox', { name: 'Rule name' });
      name.focus();
      await view.rerender({ ...v, ed: false, re: null, isMobile });
      expect(document.activeElement).toBe(view.getByRole('button', { name: 'Add rule' }));
      view.unmount();
    }
  });

  it('shows the hint about the Sieve script at the top without the label "Suggestion", shorter on mobile', () => {
    const { view } = setup();
    expect(
      view.getByText('Rules are saved as a Sieve script on the mail server and also apply in other apps.'),
    ).toHaveClass('intro');
    expect(view.queryByText('Suggestion')).not.toBeInTheDocument();
    expect(view.queryByText(/Own suggestion/)).not.toBeInTheDocument();
    view.unmount();
    const mobile = setup({}, null, true);
    expect(mobile.view.getByText('Rules are stored as a Sieve script on the mail server.')).toBeInTheDocument();
  });

  it('shows only the empty state without Sieve', () => {
    const { view } = setup({ noSieve: true, sieveOk: false, has: false, rows: [] });
    expect(view.getByText('This mail server doesn’t support filter rules')).toHaveClass('nosieve-title');
    expect(view.getByText(/doesn’t offer Sieve/)).toBeInTheDocument();
    expect(view.queryByRole('heading')).toBeNull();
    expect(view.queryByRole('switch')).toBeNull();
    expect(view.queryByRole('button')).toBeNull();
  });

  it('shows no cards and no warning without notes', () => {
    const { view } = setup();
    expect(view.queryByRole('status')).toBeNull();
    expect(view.container.querySelector('.notes')).toBeNull();
  });

  it('shows the card with "Go to vacation reply" when the vacation notice is on', async () => {
    const n = note();
    const { view } = setup({ notes: true, note: n, st: 'vacation' });
    const card = view.getByRole('status');
    expect(card).toHaveTextContent(n.text);
    expect(card.querySelector('.note-icon')).not.toHaveClass('warn');
    expect(within(card).getAllByRole('button')).toHaveLength(1);
    await fireEvent.click(within(card).getByRole('button', { name: 'Go to vacation reply' }));
    expect(n.fn).toHaveBeenCalledTimes(1);
  });

  it('shows "Turn on" for a foreign script, with a spinner during the request', async () => {
    const n = note({
      kind: 'foreign',
      icon: 'ti-file-code',
      warn: true,
      text: 'The Sieve script "my-filters" from another app is active on the mail server.',
      isGo: false,
      isOn: true,
      act: 'Turn on',
    });
    const { view, v } = setup({ notes: true, note: n, st: 'foreign' });
    const card = view.getByRole('status');
    expect(card.querySelector('.note-icon')).toHaveClass('warn');
    const on = within(card).getByRole('button', { name: 'Turn on' });
    expect(on).toHaveAttribute('aria-busy', 'false');
    expect(on.querySelector('.spin')).toBeNull();
    expect(on.querySelector('svg')).not.toBeNull();
    await fireEvent.click(on);
    expect(n.fn).toHaveBeenCalledTimes(1);
    await view.rerender({ ...v, re: null, isMobile: false, note: { ...n, busy: true, act: 'Turning on …' } });
    const busy = view.getByRole('button', { name: 'Turning on …' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy.querySelector('.spin svg')).not.toBeNull();
  });

  it('shows the card "unreadable" below the card of the active script', () => {
    const { view } = setup({
      notes: true,
      note: note({ kind: 'none', icon: 'ti-filter-pause', warn: true, isGo: false, isOn: true, act: 'Turn on' }),
      dmg: true,
    });
    const cards = view.getAllByRole('status');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveClass('note');
    expect(cards[1]).toHaveClass('dmg');
    expect(cards[1]).toHaveTextContent('The Sieve script for these rules was changed in another app.');
  });

  it('shows forwarding turned off with target address and "Keep a copy" disabled', async () => {
    const { view, v } = setup();
    expect(view.getByRole('heading', { name: 'Forwarding' })).toBeInTheDocument();
    expect(view.getByText('Forward all messages')).toBeInTheDocument();
    expect(view.getByText('Off')).toBeInTheDocument();
    const tg = view.getByRole('switch', { name: 'Forwarding' });
    expect(tg).toHaveAttribute('aria-checked', 'false');
    expect(tg).not.toHaveClass('on');
    const keep = view.getByRole('switch', { name: 'Keep a copy in your mailbox' });
    expect(keep).toHaveAttribute('aria-checked', 'true');
    expect(keep).toHaveClass('on');
    // Disabled instead of just dimmed: the group including title and description counts as inactive.
    expect(keep).toHaveAttribute('aria-disabled', 'true');
    const row = view.container.querySelector('.keep');
    expect(row).toHaveClass('off');
    expect(row).toHaveAttribute('role', 'group');
    expect(row).toHaveAttribute('aria-disabled', 'true');
    await fireEvent.click(keep);
    expect(v.toggleKeep).not.toHaveBeenCalled();
    expect(view.getByText('Receives a copy of every new message')).toBeInTheDocument();
    expect(view.getByText('Otherwise, forwarded messages only arrive at the forwarding address')).toBeInTheDocument();
    const to = view.getByRole('textbox', { name: 'Forwarding address' });
    expect(to).toHaveAttribute('type', 'email');
    expect(to).toHaveAttribute('placeholder', 'name@example.com');
    expect(to).toHaveValue('');
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('reports toggle, input and commit of the target address', async () => {
    const { view, v } = setup({
      fwdOn: true,
      fwdTo: 'boss@example.com',
      fwdSum: 'All messages go to boss@example.com. A copy stays in your mailbox.',
    });
    const row = view.container.querySelector('.keep');
    expect(row).not.toHaveClass('off');
    expect(row).not.toHaveAttribute('aria-disabled');
    expect(view.getByRole('switch', { name: 'Keep a copy in your mailbox' })).not.toHaveAttribute('aria-disabled');
    const to = view.getByRole('textbox', { name: 'Forwarding address' });
    expect(to).toHaveValue('boss@example.com');
    await fireEvent.input(to, { target: { value: 'team@example.com' } });
    expect(v.onFwdTo).toHaveBeenCalledWith('team@example.com');
    expect(v.onFwdCommit).not.toHaveBeenCalled();
    await fireEvent.change(to);
    expect(v.onFwdCommit).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('switch', { name: 'Forwarding' }));
    expect(v.toggleFwd).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('switch', { name: 'Keep a copy in your mailbox' }));
    expect(v.toggleKeep).toHaveBeenCalledTimes(1);
  });

  it('shows an error of the target address at the field', () => {
    const { view } = setup({ fwdErr: 'Please enter a valid forwarding address first.' });
    expect(view.getByRole('alert')).toHaveTextContent('Please enter a valid forwarding address first.');
    expect(view.getByRole('textbox', { name: 'Forwarding address' })).toHaveClass('err');
  });

  it('shows forwarding on mobile without icon and descriptions, placeholder "Forward to"', () => {
    const { view } = setup({ fwdErr: 'Please enter a valid forwarding address first.' }, null, true);
    expect(view.container.querySelector('.fwd-tile')).toBeNull();
    expect(view.queryByText('Receives a copy of every new message')).toBeNull();
    expect(view.queryByText('Otherwise, forwarded messages only arrive at the forwarding address')).toBeNull();
    const to = view.getByRole('textbox', { name: 'Forwarding address' });
    expect(to).toHaveAttribute('placeholder', 'Forward to');
    expect(to).toHaveAttribute('autocapitalize', 'off');
    expect(view.getByRole('alert').querySelector('svg')).toBeNull();
  });

  it('shows the filter rules with number, summary, toggle and order', () => {
    const { view, v } = setup();
    expect(view.getByRole('heading', { name: 'Filter rules' })).toBeInTheDocument();
    expect(view.getByText('New messages are checked against the rules from top to bottom.')).toBeInTheDocument();
    expect(view.container.querySelectorAll('.list .sep')).toHaveLength(2);
    for (const r of v.rows) {
      expect(view.getByText(r.name)).toBeInTheDocument();
      expect(view.getByText(r.sum)).toBeInTheDocument();
      expect(view.getByRole('switch', { name: `${r.name} active` })).toHaveAttribute('aria-checked', String(r.on));
    }
    // Disabled rules stay fully opaque, the toggle shows the state:
    // same classes and no inline style as with enabled ones.
    const off = view.getByText('Newsletter').closest('.rule-text');
    const on = view.getByText('File invoices').closest('.rule-text');
    expect(off?.className).toBe(on?.className);
    expect(off).not.toHaveAttribute('style');
    expect([...view.container.querySelectorAll('.num')].map((n) => n.textContent)).toEqual(['1', '2', '3']);
    expect(view.getByRole('button', { name: 'Move File invoices up' })).toHaveAttribute('aria-disabled', 'true');
    expect(view.getByRole('button', { name: 'Move File invoices down' })).toHaveAttribute('aria-disabled', 'false');
    expect(view.getByRole('button', { name: 'Move Flag large attachments down' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(view.queryByRole('status')).toBeNull();
    expect(view.queryByText(/^No rules yet/)).toBeNull();
  });

  it('reports toggle, order and edit, without effect at the ends', async () => {
    const { view, v } = setup();
    const [first, second, last] = v.rows as [RuleRow, RuleRow, RuleRow];
    await fireEvent.click(view.getByRole('switch', { name: 'Newsletter active' }));
    expect(second.toggle).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('button', { name: 'Move Newsletter up' }));
    expect(second.up).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('button', { name: 'Move Newsletter down' }));
    expect(second.down).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('button', { name: 'Move File invoices up' }));
    expect(first.up).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'Move Flag large attachments down' }));
    expect(last.down).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'Edit Newsletter' }));
    expect(second.edit).toHaveBeenCalledTimes(1);
  });

  it('shows "Edit" as text and the summary below the name on mobile', async () => {
    const { view, v } = setup({}, null, true);
    const edit = view.getByRole('button', { name: 'Edit Newsletter' });
    expect(edit).toHaveTextContent('Edit');
    await fireEvent.click(edit);
    expect(v.rows[1]?.edit).toHaveBeenCalledTimes(1);
    expect(view.getByText('Newsletter')).not.toHaveClass('off');
    expect(view.getByText(v.rows[1]?.sum ?? '')).not.toHaveClass('off');
    expect(view.getByRole('button', { name: 'Move File invoices up' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows "Add rule" without an editor, in the head on desktop, below the list on mobile', async () => {
    const { view, v } = setup();
    const add = view.getByRole('button', { name: 'Add rule' });
    expect(add).toHaveClass('add');
    await fireEvent.click(add);
    expect(v.add).toHaveBeenCalledTimes(1);
    view.unmount();
    const m = setup({}, null, true);
    expect(m.view.getByRole('button', { name: 'Add rule' })).toHaveClass('m-add');
  });

  it('shows the empty state without rules, shorter on mobile', () => {
    const { view } = setup({ rows: [], has: false, empty: true });
    expect(view.getByText('No rules yet. Rules sort messages automatically as they arrive.')).toBeInTheDocument();
    expect(view.container.querySelector('.list')).toBeNull();
    view.unmount();
    const m = setup({ rows: [], has: false, empty: true }, null, true);
    expect(m.view.getByText('No rules yet.')).toBeInTheDocument();
  });

  it('warns below "Filter rules" about too many forwards', () => {
    const { view } = setup({ redirWarn: true });
    expect(view.getByRole('status')).toHaveTextContent(REDIR);
  });

  it('shows the Sieve script on request with "Copy"', async () => {
    const { view, v } = setup();
    const tg = view.getByRole('button', { name: 'Show Sieve script' });
    expect(tg).toHaveAttribute('aria-expanded', 'false');
    expect(view.container.querySelector('pre')).toBeNull();
    await fireEvent.click(tg);
    expect(v.toggleSieve).toHaveBeenCalledTimes(1);
    expect(
      view.getByText('Changes made to the Sieve script in other apps will be overwritten the next time you save.'),
    ).toBeInTheDocument();
    view.unmount();
    const open = setup({ sieveOpen: true, sieveLabel: 'Hide Sieve script' });
    const tgOpen = open.view.getByRole('button', { name: 'Hide Sieve script' });
    expect(tgOpen).toHaveAttribute('aria-expanded', 'true');
    expect(tgOpen).toHaveClass('open');
    expect(open.view.container.querySelector('pre')).toHaveTextContent(open.v.sieve);
    await fireEvent.click(open.view.getByRole('button', { name: 'Copy Sieve script' }));
    expect(open.v.copySieve).toHaveBeenCalledTimes(1);
  });

  it('shows the Sieve script on mobile with "Copy" as on desktop', async () => {
    const { view, v } = setup({ sieveOpen: true, sieveLabel: 'Hide Sieve script' }, null, true);
    expect(view.container.querySelector('pre')).toHaveTextContent(v.sieve);
    const copy = view.getByRole('button', { name: 'Copy Sieve script' });
    expect(copy).toHaveClass('copy');
    expect(copy.parentElement).toHaveClass('sieve');
    await fireEvent.click(copy);
    expect(v.copySieve).toHaveBeenCalledTimes(1);
  });
});

describe('email account › rules › rule editor (`re`)', () => {
  it('shows the editor in the page instead of "Add rule" and focuses the name', () => {
    const { view } = setup({}, editor());
    expect(view.queryByRole('button', { name: 'Add rule' })).toBeNull();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(view.getByText('New rule')).toHaveClass('ed-title');
    const name = view.getByRole('textbox', { name: 'Rule name' });
    expect(name).toHaveAttribute('placeholder', 'Rule name');
    expect(name).toHaveAttribute('maxlength', '60');
    expect(name).toHaveFocus();
    expect(view.getByText('Conditions')).toBeInTheDocument();
    expect(view.getByText('Actions')).toBeInTheDocument();
  });

  it('does not focus the name on mobile (no autoFocus)', () => {
    const { view } = setup({}, editor(), true);
    expect(view.getByRole('textbox', { name: 'Rule name' })).not.toHaveFocus();
  });

  it('reports name and match mode, the radio group with arrow keys', async () => {
    const re = editor();
    const { view } = setup({}, re);
    await fireEvent.input(view.getByRole('textbox', { name: 'Rule name' }), { target: { value: 'Invoices' } });
    expect(re.onName).toHaveBeenCalledWith('Invoices');
    const group = view.getByRole('radiogroup', { name: 'Match conditions' });
    const [all, any] = within(group).getAllByRole('radio') as [HTMLElement, HTMLElement];
    expect(all).toHaveAttribute('aria-checked', 'true');
    expect(all).toHaveClass('on');
    expect(any).toHaveAttribute('aria-checked', 'false');
    expect(all).toHaveAttribute('tabindex', '0');
    expect(any).toHaveAttribute('tabindex', '-1');
    await fireEvent.click(any);
    expect(re.matchOpts[1]?.onClick).toHaveBeenCalledTimes(1);
    await fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(re.matchOpts[1]?.onClick).toHaveBeenCalledTimes(2);
  });

  it('shows conditions with field, value, "MB" and remove', async () => {
    const size = cond({ f: 'size', v: '10', ph: '10', hasUnit: true, lead: 'and', canRm: true });
    const att = cond({ f: 'att', v: '', hasV: false, lead: 'and', canRm: true });
    const re = editor({ conds: [cond({ canRm: true }), size, att] });
    const { view } = setup({}, re);
    const fields = view.getAllByRole('combobox', { name: 'Field' });
    expect(fields.map((f) => (f as HTMLSelectElement).value)).toEqual(['from', 'size', 'att']);
    expect(
      within(fields[0] as HTMLElement)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Sender contains', 'Recipient contains', 'Subject contains', 'Has attachment', 'Larger than']);
    expect(view.getAllByRole('textbox', { name: 'Value' })).toHaveLength(2);
    expect(view.getByText('MB')).toHaveClass('unit');
    expect(view.getByText('If')).toHaveClass('lead');
    await fireEvent.change(fields[0] as HTMLElement, { target: { value: 'size' } });
    expect(re.conds[0]?.onF).toHaveBeenCalledWith('size');
    const value = view.getAllByRole('textbox', { name: 'Value' })[0] as HTMLElement;
    expect(value).toHaveAttribute('placeholder', 'e.g. billing@');
    await fireEvent.input(value, { target: { value: 'buchhaltung@' } });
    expect(re.conds[0]?.onV).toHaveBeenCalledWith('buchhaltung@');
    const rm = view.getAllByRole('button', { name: 'Remove condition' });
    expect(rm).toHaveLength(3);
    await fireEvent.click(rm[1] as HTMLElement);
    expect(size.rm).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('button', { name: 'Add condition' }));
    expect(re.addC).toHaveBeenCalledTimes(1);
  });

  it('shows actions with a picker for folder or tag and "Forward to"', async () => {
    const move = act({ pickOpen: true, canRm: true });
    const fwd = act({
      a: 'fwd',
      v: 'boss@example.com',
      isPick: false,
      isMail: true,
      opts: [],
      lead: 'and',
      canRm: true,
    });
    const re = editor({ acts: [move, fwd] });
    const { view } = setup({}, re);
    const kinds = view.getAllByRole('combobox', { name: 'Action' });
    expect(kinds.map((k) => (k as HTMLSelectElement).value)).toEqual(['move', 'fwd']);
    expect(
      within(kinds[0] as HTMLElement)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Move to folder', 'Add tag', 'Mark as read', 'Forward to', 'Delete']);
    await fireEvent.change(kinds[0] as HTMLElement, { target: { value: 'tag' } });
    expect(move.onA).toHaveBeenCalledWith('tag');
    const pick = view.getByRole('combobox', { name: 'Folder: Invoices' });
    expect(pick).toHaveAttribute('role', 'combobox');
    expect(pick).toHaveAttribute('aria-expanded', 'true');
    expect(pick).toHaveClass('open');
    // Frame `data-pop`: a click inside does not close via the layout.
    expect(pick.parentElement).toHaveAttribute('data-pop');
    await fireEvent.click(pick);
    expect(move.pickToggle).toHaveBeenCalledTimes(1);
    const list = view.getByRole('listbox', { name: 'Folder' });
    expect(list).toHaveClass('no-scrollbar');
    expect(list.parentElement).toBe(pick.parentElement);
    const opts = within(list).getAllByRole('option');
    expect(opts.map((o) => o.textContent)).toEqual(['Archive', 'Invoices']);
    expect(opts[1]).toHaveAttribute('aria-selected', 'true');
    expect(opts[1]).toHaveClass('on');
    expect(opts[1]?.style.getPropertyValue('--depth')).toBe('1');
    await fireEvent.click(opts[0] as HTMLElement);
    expect(move.opts[0]?.onClick).toHaveBeenCalledTimes(1);
    const mail = view.getByRole('textbox', { name: 'Forward to' });
    expect(mail).toHaveAttribute('type', 'email');
    expect(mail).toHaveValue('boss@example.com');
    await fireEvent.input(mail, { target: { value: 'team@example.com' } });
    expect(fwd.onV).toHaveBeenCalledWith('team@example.com');
    await fireEvent.click(view.getAllByRole('button', { name: 'Remove action' })[1] as HTMLElement);
    expect(fwd.rm).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('button', { name: 'Add action' }));
    expect(re.addA).toHaveBeenCalledTimes(1);
  });

  it('passes the keys of the target picker on at the button and marks the keyboard option', async () => {
    const tag = act({
      a: 'tag',
      v: 't2',
      pickOpen: true,
      pickLabel: 'Customer',
      pickIcon: 'ti-tag',
      pickAria: 'Tag: Customer',
      pickTitle: 'Tag',
      opts: [
        { id: 't1', label: 'Important', depth: 0, on: false, hi: true, onClick: vi.fn() },
        { id: 't2', label: 'Customer', depth: 0, on: true, hi: false, onClick: vi.fn() },
      ],
    });
    const { view } = setup({}, editor({ acts: [tag] }));
    const pick = view.getByRole('combobox', { name: 'Tag: Customer' });
    pick.focus();
    await fireEvent.keyDown(pick, { key: 'ArrowDown' });
    await fireEvent.keyDown(pick, { key: 'Enter' });
    expect(tag.pickKey).toHaveBeenCalledTimes(2);
    expect(tag.pickKey).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'Enter' }));
    await fireEvent.keyUp(pick, { key: ' ' });
    expect(tag.pickKeyUp).toHaveBeenCalledWith(expect.objectContaining({ key: ' ' }));
    // Focus stays at the button, the options are not a tab stop.
    expect(document.activeElement).toBe(pick);
    const [hi, cur] = within(view.getByRole('listbox', { name: 'Tag' })).getAllByRole('option');
    expect(hi).toHaveClass('hi');
    expect(hi).toHaveAttribute('data-hi', '1');
    expect(hi).toHaveAttribute('tabindex', '-1');
    expect(cur).not.toHaveClass('hi');
    expect(cur).toHaveAttribute('data-hi', '0');
    expect(cur).toHaveAttribute('aria-selected', 'true');
  });

  it('closes the target picker on mobile on a tap outside, on desktop via the layout', async () => {
    for (const isMobile of [true, false]) {
      const re = editor({ acts: [act({ pickOpen: true })] });
      const { view } = setup({}, re, isMobile);
      const pick = view.getByRole('combobox', { name: 'Folder: Invoices' });
      expect(pick).toHaveAttribute('role', 'combobox');
      const list = view.getByRole('listbox', { name: 'Folder' });
      // Nothing closes inside the picker.
      await fireEvent.pointerDown(within(list).getAllByRole('option')[0] as HTMLElement);
      await fireEvent.pointerDown(pick);
      expect(re.pickClose).not.toHaveBeenCalled();
      await fireEvent.pointerDown(view.getByRole('textbox', { name: 'Rule name' }));
      expect(re.pickClose).toHaveBeenCalledTimes(isMobile ? 1 : 0);
      // The keys go to the button on mobile too: there the combobox expands in the page.
      await fireEvent.keyDown(pick, { key: 'ArrowDown' });
      expect(re.acts[0]?.pickKey).toHaveBeenCalledTimes(1);
      view.unmount();
    }
    // When closed, a tap closes nothing.
    const closed = editor();
    const { view } = setup({}, closed, true);
    await fireEvent.pointerDown(view.getByRole('textbox', { name: 'Rule name' }));
    expect(closed.pickClose).not.toHaveBeenCalled();
  });

  it('shows the selected target in the list when opened by click, without a mark', () => {
    // List 260 px high, options 40 px each (jsdom measures nothing).
    const list = (el: HTMLElement) => el.getAttribute('role') === 'listbox';
    const index = (el: HTMLElement) => [...(el.parentElement?.children ?? [])].indexOf(el);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return list(this) ? 13 * 40 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return list(this) ? 260 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      return index(this) * 40;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => 40);
    const opts = Array.from({ length: 13 }, (_, i) => ({
      id: `f${i}`,
      label: `Folder ${i}`,
      depth: 0,
      on: i === 8,
      hi: false,
      onClick: vi.fn(),
    }));
    const { view } = setup({}, editor({ acts: [act({ pickOpen: true, opts })] }));
    const box = view.getByRole('listbox', { name: 'Folder' });
    expect(box.querySelector('.opt.hi')).toBeNull();
    // Position 9 (offsetTop 320) is below the visible part: the list scrolls to its end plus margin.
    expect(box.scrollTop).toBe(8 * 40 + 40 - 260 + 6);
    vi.restoreAllMocks();
  });

  it('shows the picker closed without a list', () => {
    const { view } = setup({}, editor());
    expect(view.getByRole('combobox', { name: 'Folder: Invoices' })).toHaveAttribute('aria-expanded', 'false');
    expect(view.queryByRole('listbox')).toBeNull();
    expect(view.queryByRole('button', { name: 'Remove action' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Remove condition' })).toBeNull();
  });

  it('names the list and the marked option at the target picker when open', async () => {
    const { view, v } = setup({}, editor());
    const pick = view.getByRole('combobox', { name: 'Folder: Invoices' });
    expect(pick).toHaveAttribute('aria-expanded', 'false');
    expect(pick).not.toHaveAttribute('aria-controls');
    expect(pick).not.toHaveAttribute('aria-activedescendant');

    // Open with the selected row marked (`pickActive`).
    await view.rerender({ ...v, re: editor({ acts: [act({ pickOpen: true, pickActive: 1 })] }), isMobile: false });
    const list = view.getByRole('listbox', { name: 'Folder' });
    expect(pick).toHaveAttribute('aria-expanded', 'true');
    expect(list.id).not.toBe('');
    expect(pick).toHaveAttribute('aria-controls', list.id);
    const [archive, invoices] = within(list).getAllByRole('option');
    expect(pick).toHaveAttribute('aria-activedescendant', invoices!.id);

    // After ↓ (wrapping) the next row.
    await view.rerender({ ...v, re: editor({ acts: [act({ pickOpen: true, pickActive: 0 })] }), isMobile: false });
    expect(pick).toHaveAttribute('aria-activedescendant', archive!.id);
    expect(archive!.id).not.toBe(invoices!.id);

    // Without targets there is no option the button could point to.
    await view.rerender({ ...v, re: editor({ acts: [act({ pickOpen: true, opts: [] })] }), isMobile: false });
    expect(pick).toHaveAttribute('aria-controls', view.getByRole('listbox', { name: 'Folder' }).id);
    expect(pick).not.toHaveAttribute('aria-activedescendant');
  });

  it('shows warning and error and saves, cancels or deletes', async () => {
    const re = editor({
      title: 'Edit rule',
      redirWarn: true,
      err: 'Please enter a name.',
      canDel: true,
    });
    const { view } = setup({}, re);
    expect(view.getByRole('status')).toHaveTextContent(REDIR);
    expect(view.getByRole('alert')).toHaveTextContent('Please enter a name.');
    await fireEvent.click(view.getByRole('button', { name: 'Delete' }));
    expect(re.del).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    expect(re.cancel).toHaveBeenCalledTimes(1);
    await fireEvent.click(view.getByRole('button', { name: 'Save' }));
    expect(re.save).toHaveBeenCalledTimes(1);
  });

  it('shows a new rule without "Clear", warning and error', () => {
    const { view } = setup({}, editor());
    expect(view.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(view.queryByRole('status')).toBeNull();
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('shows the editor on mobile with cards per condition and action, "Delete rule" as an icon', async () => {
    const re = editor({
      conds: [cond({ f: 'size', v: '10', ph: '10', hasUnit: true, canRm: true })],
      acts: [act({ pickOpen: true })],
      canDel: true,
    });
    const { view } = setup({}, re, true);
    expect(view.container.querySelectorAll('.m-item')).toHaveLength(2);
    expect(view.queryByText('Conditions')).toBeNull();
    expect(view.queryByText('MB')).toBeNull();
    const field = view.getByRole('combobox', { name: 'Field' });
    expect(within(field).getByRole('option', { name: 'Larger than (MB)' })).toBeInTheDocument();
    expect(view.getByRole('radiogroup', { name: 'Match conditions' })).toBeInTheDocument();
    expect(view.getByRole('listbox')).not.toHaveClass('no-scrollbar');
    const del = view.getByRole('button', { name: 'Delete rule' });
    expect(del.textContent).toBe('');
    await fireEvent.click(del);
    expect(re.del).toHaveBeenCalledTimes(1);
  });
});
