import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import NoticeBar from './NoticeBar.svelte';
import { ANN_TONES, bannersOf, type BannerInput } from '#lib/shell.ts';
import type { PublicBanner } from '#lib/state/session.svelte.ts';

const TEXTS = {
  staleTitle: 'Sign-in expired',
  staleAct: 'Sign in again',
  offlineTitle: 'Offline',
  offlineText: 'Changes will sync once you’re back online.',
  offlineAct: 'End simulation',
  failTitle: 'Not synced',
  retry: 'Try again',
  draftTitle: 'Two versions',
  draftAct: 'Show',
  maintTitle: 'Maintenance mode',
  maintText: 'Only administrators can use the app.',
  maintAct: 'Manage',
  mailTitle: 'System emails not set up',
  mailText: 'Invitations, confirmation links, and security alerts won’t be sent.',
  mailAct: 'Set up',
  more: 'Learn more',
};

/** Custom banner as served by `public/config`. */
const OWN: PublicBanner = {
  title: 'Maintenance on Saturday',
  text: 'The app is unavailable from 8 to 10 am.',
  link: 'https://example.com/status',
  linkLabel: '',
  tone: 'dark',
  icon: 'ti-calendar-event',
  closable: true,
  revision: 4,
};

function input(patch: Partial<BannerInput> = {}): BannerInput {
  return {
    offline: false,
    waiting: null,
    stuck: [],
    lost: null,
    doubled: null,
    openDoubled: () => {},
    closeDoubled: () => {},
    retryQueue: () => {},
    closeLost: () => {},
    offlineSimulated: false,
    endSimulation: () => {},
    staleText: null,
    openAccounts: () => {},
    isAdmin: true,
    maintenance: false,
    onMaintenancePage: false,
    systemMailOff: false,
    onMailPage: false,
    systemMailHidden: false,
    openMaintenance: () => {},
    openSystemMail: () => {},
    hideSystemMail: () => {},
    own: null,
    ownHidden: false,
    openLink: () => {},
    hideOwn: () => {},
    ...patch,
  };
}

describe('notice bar', () => {
  it('shows maintenance mode and system emails only to administrators', () => {
    const both = bannersOf(input({ maintenance: true, systemMailOff: true }), TEXTS);
    expect(both.map((b) => b.title)).toEqual(['Maintenance mode', 'System emails not set up']);
    expect(both[0]).toMatchObject({
      icon: 'ti-tool',
      act: 'Manage',
      hasAct: true,
      hasClose: false,
      tone: ANN_TONES.accent,
    });
    // "Set up" leads to Administration › Email, where it is not shown; closable until reload.
    expect(both[1]).toMatchObject({
      icon: 'ti-mail-off',
      act: 'Set up',
      hasAct: true,
      hasClose: true,
      tone: ANN_TONES.soft,
    });
    expect(bannersOf(input({ systemMailOff: true, onMailPage: true }), TEXTS)[0]?.hasAct).toBe(false);
    expect(bannersOf(input({ isAdmin: false, maintenance: true, systemMailOff: true }), TEXTS)).toEqual([]);
    expect(bannersOf(input({ systemMailOff: true, systemMailHidden: true }), TEXTS)).toEqual([]);
    expect(bannersOf(input({ maintenance: true, onMaintenancePage: true }), TEXTS)[0]?.hasAct).toBe(false);
  });

  it('shows "Offline" first, "End simulation" only in the simulation', async () => {
    const openAccounts = vi.fn();
    const stale = bannersOf(input({ staleText: 'a@example.com must sign in again.', openAccounts }), TEXTS);
    expect(stale.map((b) => [b.id, b.title, b.text, b.act])).toEqual([
      ['stale', 'Sign-in expired', 'a@example.com must sign in again.', 'Sign in again'],
    ]);
    stale[0]?.fn?.();
    expect(openAccounts).toHaveBeenCalled();
    const endSimulation = vi.fn();
    const real = bannersOf(input({ offline: true, maintenance: true }), TEXTS);
    expect(real.map((b) => b.id)).toEqual(['offline', 'maintenance']);
    expect(real[0]).toMatchObject({ icon: 'ti-wifi-off', title: 'Offline', hasAct: false, hasClose: false });

    const banners = bannersOf(input({ offline: true, offlineSimulated: true, endSimulation }), TEXTS);
    const { getByRole } = render(NoticeBar, { isMobile: false, banners });
    await fireEvent.click(getByRole('button', { name: 'End simulation' }));
    expect(endSimulation).toHaveBeenCalled();
  });

  it('shows "Offline" also without the administrator role', () => {
    expect(bannersOf(input({ isAdmin: false, offline: true }), TEXTS).map((b) => b.id)).toEqual(['offline']);
  });

  it('leads to maintenance and to email and closes the system mail banner', async () => {
    const openMaintenance = vi.fn();
    const openSystemMail = vi.fn();
    const hideSystemMail = vi.fn();
    const banners = bannersOf(
      input({ maintenance: true, systemMailOff: true, openMaintenance, openSystemMail, hideSystemMail }),
      TEXTS,
    );
    const { getAllByRole, getByRole, getByText } = render(NoticeBar, { isMobile: false, banners });
    expect(getAllByRole('status')).toHaveLength(2);
    expect(getByText('Only administrators can use the app.')).toBeInTheDocument();
    await fireEvent.click(getByRole('button', { name: 'Manage' }));
    expect(openMaintenance).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Set up' }));
    expect(openSystemMail).toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Close banner' }));
    expect(hideSystemMail).toHaveBeenCalled();
  });

  it('shows the custom banner to everyone after the administration banners', () => {
    const all = bannersOf(input({ isAdmin: false, own: OWN }), TEXTS);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: 'own',
      icon: 'ti-calendar-event',
      title: 'Maintenance on Saturday',
      text: 'The app is unavailable from 8 to 10 am.',
      act: 'Learn more',
      hasAct: true,
      hasClose: true,
      tone: ANN_TONES.dark,
    });
    expect(bannersOf(input({ maintenance: true, own: OWN }), TEXTS).map((b) => b.id)).toEqual(['maintenance', 'own']);
    expect(bannersOf(input({ own: OWN, ownHidden: true }), TEXTS)).toEqual([]);
    // No button without a link, not closable without ×; unknown values are ignored.
    const plain = bannersOf(
      input({ own: { ...OWN, link: '', linkLabel: 'Status', closable: false, tone: 'Neon', icon: 'ti-x-unknown' } }),
      TEXTS,
    )[0];
    expect(plain).toMatchObject({ act: 'Status', hasAct: false, hasClose: false, tone: ANN_TONES.accent });
    expect(plain?.icon).toBe('ti-speakerphone');
    expect(plain?.fn).toBeUndefined();
    expect(plain?.onClose).toBeUndefined();
    // Only `https://` with a dot in the host (`urlOk`): foreign schemes, http and addresses without a scheme open nothing.
    for (const link of ['javascript:alert(1)', 'http://example.com', 'example.com']) {
      expect(bannersOf(input({ own: { ...OWN, link } }), TEXTS)[0]?.hasAct).toBe(false);
    }
  });

  it('opens the link of the custom banner and remembers the revision on close', async () => {
    const openLink = vi.fn();
    const hideOwn = vi.fn();
    const banners = bannersOf(input({ own: { ...OWN, linkLabel: 'Status' }, openLink, hideOwn }), TEXTS);
    const { getByRole } = render(NoticeBar, { isMobile: false, banners });
    await fireEvent.click(getByRole('button', { name: 'Status' }));
    expect(openLink).toHaveBeenCalledWith('https://example.com/status');
    await fireEvent.click(getByRole('button', { name: 'Close banner' }));
    expect(hideOwn).toHaveBeenCalledWith(4);
  });

  it('shows only the title on mobile', () => {
    const banners = bannersOf(input({ maintenance: true }), TEXTS);
    const { queryByText, getByText } = render(NoticeBar, { isMobile: true, banners });
    expect(getByText('Maintenance mode')).toBeInTheDocument();
    expect(queryByText('Only administrators can use the app.')).toBeNull();
  });

  it('names the queue counter when offline, short on mobile', () => {
    const waiting = { text: '3 changes are waiting for the connection.', titleM: 'Offline · 3 waiting' };
    const banner = bannersOf(input({ offline: true, waiting }), TEXTS)[0];
    expect(banner).toMatchObject({
      id: 'offline',
      title: 'Offline',
      titleM: 'Offline · 3 waiting',
      text: '3 changes are waiting for the connection.',
    });
  });

  it('stays with the previous offline text without a queue, without its own mobile title', () => {
    const banner = bannersOf(input({ offline: true }), TEXTS)[0];
    expect(banner?.text).toBe('Changes will sync once you’re back online.');
    expect(banner?.titleM).toBeUndefined();
  });

  it('shows no `stuck` bars when offline: without a connection the offline bar explains everything', () => {
    const stuck = [{ host: 'mail.example.com', text: '2 changes are waiting.' }];
    expect(bannersOf(input({ offline: true, stuck }), TEXTS).map((b) => b.id)).toEqual(['offline']);
  });

  it('shows one bar per host with "Try again" when online', async () => {
    const retryQueue = vi.fn();
    const stuck = [
      { host: 'mail.example.com', text: '2 changes are waiting for mail.example.com.' },
      { host: 'post.example.com', text: '1 change is waiting for post.example.com.' },
    ];
    const banners = bannersOf(input({ stuck, retryQueue }), TEXTS);
    expect(banners.map((b) => b.id)).toEqual(['stuck:mail.example.com', 'stuck:post.example.com']);
    expect(banners[0]).toMatchObject({
      icon: 'ti-cloud-off',
      title: 'Not synced',
      text: '2 changes are waiting for mail.example.com.',
      act: 'Try again',
      hasAct: true,
      hasClose: false,
      tone: ANN_TONES.warning,
    });
    const { getAllByRole } = render(NoticeBar, { isMobile: false, banners });
    await fireEvent.click(getAllByRole('button', { name: 'Try again' })[1]!);
    expect(retryQueue).toHaveBeenCalledOnce();
  });

  it('shows `lost` online as offline, closable with `closeLost`', async () => {
    const closeLost = vi.fn();
    const lost = { text: '"Invoice" was not saved.', titleM: '1 not synced' };
    expect(bannersOf(input({ offline: true, lost }), TEXTS).map((b) => b.id)).toEqual(['offline', 'lost']);
    const banners = bannersOf(input({ lost, closeLost }), TEXTS);
    expect(banners).toHaveLength(1);
    expect(banners[0]).toMatchObject({
      id: 'lost',
      icon: 'ti-alert-circle',
      title: 'Not synced',
      titleM: '1 not synced',
      text: '"Invoice" was not saved.',
      hasAct: false,
      hasClose: true,
      tone: ANN_TONES.warning,
    });
    const { getByRole } = render(NoticeBar, { isMobile: false, banners });
    await fireEvent.click(getByRole('button', { name: 'Close banner' }));
    expect(closeLost).toHaveBeenCalledOnce();
  });

  it('shows `doubled` with "Show" and "Close" in the soft tone', async () => {
    const openDoubled = vi.fn();
    const closeDoubled = vi.fn();
    const doubled = { text: '"Invoice" was changed on another device.' };
    const banners = bannersOf(input({ doubled, openDoubled, closeDoubled }), TEXTS);
    expect(banners).toHaveLength(1);
    expect(banners[0]).toMatchObject({
      id: 'doubled',
      icon: 'ti-file-pencil',
      title: 'Two versions',
      text: doubled.text,
      act: 'Show',
      hasAct: true,
      hasClose: true,
      tone: ANN_TONES.soft,
    });
    const { getByRole } = render(NoticeBar, { isMobile: false, banners });
    await fireEvent.click(getByRole('button', { name: 'Show' }));
    expect(openDoubled).toHaveBeenCalledOnce();
    expect(closeDoubled).not.toHaveBeenCalled();
    await fireEvent.click(getByRole('button', { name: 'Close banner' }));
    expect(closeDoubled).toHaveBeenCalledOnce();
  });

  it('shows no bar "Two versions" without `doubled`', () => {
    expect(bannersOf(input(), TEXTS).map((b) => b.id)).toEqual([]);
  });

  it('sorts `doubled` after `lost` and before the administration banners, also offline', () => {
    const lost = { text: 'Discarded.', titleM: '1 discarded' };
    const doubled = { text: 'Two versions exist.' };
    expect(
      bannersOf(input({ offline: true, lost, doubled, maintenance: true, own: OWN }), TEXTS).map((b) => b.id),
    ).toEqual(['offline', 'lost', 'doubled', 'maintenance', 'own']);
  });

  it('shows `titleM` on mobile and `title` on desktop', () => {
    const banners = bannersOf(
      input({ offline: true, waiting: { text: '3 changes are waiting.', titleM: 'Offline · 3 waiting' } }),
      TEXTS,
    );
    const mobile = render(NoticeBar, { isMobile: true, banners });
    expect(mobile.getByText('Offline · 3 waiting')).toBeInTheDocument();
    expect(mobile.queryByText('Offline')).toBeNull();
    mobile.unmount();

    const desktop = render(NoticeBar, { isMobile: false, banners });
    expect(desktop.getByText('Offline')).toBeInTheDocument();
    expect(desktop.queryByText('Offline · 3 waiting')).toBeNull();
  });

  it('falls back to `title` without `titleM` on mobile', () => {
    const { getByText } = render(NoticeBar, { isMobile: true, banners: bannersOf(input({ offline: true }), TEXTS) });
    expect(getByText('Offline')).toBeInTheDocument();
  });
});
