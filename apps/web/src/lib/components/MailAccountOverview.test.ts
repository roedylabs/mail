import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MA_COLORS } from '@roedy/tokens';
import { hideTooltip, TIP_DELAY, TIP_FADE } from '#lib/actions/tooltip.ts';
import type { OverviewValues, StorageNote, StorageValues } from '#lib/mail-account.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import MailAccountOverview from './MailAccountOverview.svelte';

const STORAGE: StorageValues = {
  quota: '2.4 GB of 10 GB used',
  usedT: '2,4 GB',
  totalT: '10 GB',
  freeT: '7.6 GB free',
  pctT: '24 %',
  pctN: 24,
  quotaW: '24%',
  full: false,
};

const NO_LIMIT: StorageNote = {
  noLimit: true,
  busy: false,
  title: 'No limit',
  text: 'mail.example.test reports no storage limit for this account.',
};

function values(over: Partial<OverviewValues> = {}): OverviewValues {
  return {
    kind: 'ok',
    st: 'Connected',
    needsAuth: false,
    email: 'max@example.test',
    letter: 'M',
    chip: '#94c48d',
    chipInk: '#13300f',
    last: 'Checked 2 min ago',
    stSub: 'Checked 2 min ago',
    blocked: false,
    reauth: false,
    okAuth: true,
    asOf: '',
    busy: false,
    checkLabel: 'Check connection',
    rot: 0,
    check: vi.fn(),
    goCon: vi.fn(),
    storage: STORAGE,
    storageNote: null,
    colors: MA_COLORS.map(([name, base, ink], i) => ({ name, base, ink, on: i === 1, onClick: vi.fn() })),
    isDefault: false,
    notDefault: true,
    makeDefault: vi.fn(),
    ...over,
  };
}

function setup(over: Partial<OverviewValues> = {}, isMobile = false) {
  const v = values(over);
  const view = render(MailAccountOverview, { ...v, isMobile });
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

describe('email account › overview', () => {
  it('shows status, last check and "Check connection" when connected', async () => {
    const { view, v } = setup();
    const st = view.getByText('Connected');
    expect(st).not.toHaveClass('auth');
    expect(st).not.toHaveClass('busy');
    expect(view.getByText('Checked 2 min ago')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument();
    const btn = view.getByRole('button', { name: 'Check connection' });
    expect(btn).toHaveAttribute('aria-busy', 'false');
    await fireEvent.click(btn);
    expect(v.check).toHaveBeenCalledTimes(1);
  });

  it('spins the icon and disables "Check connection" during the check', async () => {
    const { view, v } = setup({ kind: 'busy', st: 'Checking …', busy: true, checkLabel: 'Checking', rot: 720 });
    expect(view.getByText('Checking …')).toHaveClass('busy');
    const btn = view.getByRole('button', { name: 'Checking' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn.querySelector('.rot')).toHaveStyle({ transform: 'rotate(720deg)' });
    await fireEvent.click(btn);
    expect(v.check).not.toHaveBeenCalled();
  });

  it('offers "Sign in again" instead of the check when the sign-in expired', async () => {
    const { view, v } = setup({
      kind: 'auth',
      st: 'Sign-in required',
      needsAuth: true,
      reauth: true,
      okAuth: false,
      last: 'Last checked 3 hours ago',
      stSub: 'Last checked 3 hours ago',
    });
    expect(view.getByText('Sign-in required')).toHaveClass('auth');
    expect(view.getByText('Last checked 3 hours ago')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Check connection' })).not.toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Sign in again' }));
    expect(v.goCon).toHaveBeenCalledTimes(1);
  });

  it('leads "Go to connection" with a blocked server and names the time of the last check', async () => {
    const { view, v } = setup({
      kind: 'blocked',
      st: 'Server blocked',
      needsAuth: true,
      blocked: true,
      reauth: false,
      okAuth: false,
      stSub: 'mail.s1.test is no longer an approved server.',
      asOf: 'Last checked 3 hours ago',
    });
    expect(view.getByText('Server blocked')).toHaveClass('blocked');
    expect(view.getByText('mail.s1.test is no longer an approved server.')).toHaveClass('last');
    expect(view.getByText('Last checked 3 hours ago')).toHaveClass('as-of');
    expect(view.queryByRole('button', { name: 'Sign in again' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Check connection' })).toBeNull();
    await fireEvent.click(view.getByRole('button', { name: 'Go to connection' }));
    expect(v.goCon).toHaveBeenCalledTimes(1);
  });

  it('shows the tile in the account color and "Not checked yet"', () => {
    const { view } = setup({ last: 'Not checked yet', stSub: 'Not checked yet' });
    const chip = view.container.querySelector<HTMLElement>('.chip');
    expect(chip?.style.background).toBe('rgb(148, 196, 141)');
    expect(chip).toHaveStyle({ color: '#13300f' });
    expect(view.getByText('Not checked yet')).toHaveClass('last');
  });

  it('shows the storage with bar, free space and share', () => {
    const { view } = setup();
    expect(view.getByRole('heading', { level: 2, name: 'Storage' })).toBeInTheDocument();
    expect(view.getByText('2,4 GB')).toBeInTheDocument();
    expect(view.getByText('7.6 GB free')).toBeInTheDocument();
    expect(view.getByText('2.4 GB of 10 GB used · 24 %')).toBeInTheDocument();
    const bar = view.getByRole('progressbar', { name: 'Storage' });
    expect(bar).toHaveAttribute('aria-valuenow', '24');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    const fill = bar.firstElementChild;
    expect(fill).toHaveStyle({ width: '24%' });
    expect(fill).not.toHaveClass('full');
  });

  it('colors the bar red from 90 %', () => {
    const { view } = setup({ storage: { ...STORAGE, pctN: 95, pctT: '95 %', quotaW: '95%', full: true } });
    expect(view.getByRole('progressbar').firstElementChild).toHaveClass('full');
  });

  it('shows "No limit" without numbers and bar without a limit', () => {
    const { view } = setup({ storage: null, storageNote: NO_LIMIT });
    expect(view.getByRole('heading', { level: 2, name: 'Storage' })).toBeInTheDocument();
    const title = view.getByText('No limit');
    expect(title).toHaveClass('limit');
    expect(view.getByText('mail.example.test reports no storage limit for this account.')).toBeInTheDocument();
    expect(view.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(view.queryByText('7.6 GB free')).not.toBeInTheDocument();
    expect(title.closest('[aria-live]')).toHaveAttribute('aria-live', 'polite');
    expect(title.parentElement).toHaveAttribute('aria-busy', 'false');
  });

  it('shows "Checking …" with a placeholder bar during the first check', () => {
    const { view } = setup({
      storage: null,
      storageNote: {
        noLimit: false,
        busy: true,
        title: 'Checking …',
        text: 'Reading storage usage from mail.example.test.',
      },
    });
    const title = view.getByText('Checking …');
    expect(title).not.toHaveClass('limit');
    expect(title.parentElement).toHaveAttribute('aria-busy', 'true');
    const bar = view.getByRole('progressbar', { name: 'Checking storage' });
    expect(bar).toHaveClass('shim');
    expect(bar).not.toHaveAttribute('aria-valuenow');
    expect(view.getByText('Reading storage usage from mail.example.test.')).toBeInTheDocument();
  });

  it('shows "Not checked yet" without a bar without a check', () => {
    const { view } = setup({
      storage: null,
      storageNote: {
        noLimit: false,
        busy: false,
        title: 'Not checked yet',
        text: '"Check connection" reads storage usage from mail.example.test.',
      },
    });
    const title = view.getByText('Not checked yet');
    expect(title).not.toHaveClass('limit');
    expect(title.parentElement).toHaveAttribute('aria-busy', 'false');
    expect(view.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(view.getByText('"Check connection" reads storage usage from mail.example.test.')).toBeInTheDocument();
  });

  it('shows the colors as a choice with ring and check mark at the selected one and selects', async () => {
    const { view, v } = setup();
    expect(view.getByText('Color')).toBeInTheDocument();
    expect(view.getByText('Marks the account in folders and messages')).toBeInTheDocument();
    const group = view.getByRole('radiogroup', { name: 'Color' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Apricot',
      'Sage',
      'Lilac',
      'Sky',
      'Rose',
      'Honey',
    ]);
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
      'false',
      'false',
    ]);
    const [first, second] = radios;
    expect(second).toHaveClass('on');
    expect(first).not.toHaveClass('on');
    expect(first?.style.getPropertyValue('--sw-base')).toBe('#f5a06e');
    expect(first?.style.getPropertyValue('--sw-ink')).toBe('#3a1b06');
    await fireEvent.click(within(group).getByRole('radio', { name: 'Sky' }));
    expect(v.colors[3]?.onClick).toHaveBeenCalledTimes(1);
    expect(v.colors[1]?.onClick).not.toHaveBeenCalled();
  });

  it('shows the color name as a tooltip on desktop only', async () => {
    const desk = setup();
    expect(await tipOf(desk.view.getByRole('radio', { name: 'Rose' }))).toBe('Rose');
    desk.view.unmount();
    const mob = setup({}, true);
    expect(await tipOf(mob.view.getByRole('radio', { name: 'Rose' }))).toBeUndefined();
  });

  it('offers "Set as default" as long as the account is not the default', async () => {
    const { view, v } = setup();
    expect(view.getByText('Default account')).toBeInTheDocument();
    expect(view.getByText('Preselected when you compose')).toBeInTheDocument();
    expect(view.queryByText('Default')).not.toBeInTheDocument();
    await fireEvent.click(view.getByRole('button', { name: 'Set as default' }));
    expect(v.makeDefault).toHaveBeenCalledTimes(1);
  });

  it('shows the badge "Default" without a button on the default account', () => {
    const { view } = setup({ isDefault: true, notDefault: false });
    expect(view.getByText('Default')).toBeInTheDocument();
    expect(view.queryByRole('button', { name: 'Set as default' })).not.toBeInTheDocument();
  });
});
