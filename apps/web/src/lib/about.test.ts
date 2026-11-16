import { describe, expect, it, vi } from 'vitest';
import { aboutValues, browserOf, deviceOf, type AboutContext, type AboutInput } from './about.ts';
import type { Org } from './state/session.svelte.ts';

const NO_ORG: Org = {
  name: null,
  website: null,
  help: null,
  email: null,
  imprint: null,
  privacy: null,
  terms: null,
  source: null,
};

const ORG: Org = {
  name: 'Example Inc.',
  website: 'https://example.com',
  help: 'https://example.com/help',
  email: 'support@example.com',
  imprint: 'https://example.com/imprint',
  privacy: 'www.example.com/privacy/',
  terms: null,
  source: 'https://github.com/example/my-app',
};

const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0';

function setup(patch: Partial<AboutInput> = {}, copied = true) {
  const ctx = {
    scrollTo: vi.fn(),
    copy: vi.fn(() => Promise.resolve(copied)),
    notify: vi.fn(),
    openLicenses: vi.fn(),
  } satisfies AboutContext;
  const input: AboutInput = {
    appName: 'Roedy Mail',
    org: NO_ORG,
    update: null,
    build: { version: '0.6.0', sha: '7f3c2a1', date: new Date(2026, 9, 14, 12) },
    dateFmt: 'de',
    tz: 'Europe/Berlin',
    userAgent: FIREFOX,
    ...patch,
  };
  return { ctx, v: aboutValues(input, ctx) };
}

describe('About', () => {
  it('shows version, build, date and browser from the build info', () => {
    const { v } = setup();
    expect(v.appVersion).toBe('0.6.0');
    expect(v.aboutRows).toEqual([
      { k: 'Version', v: '0.6.0', sep: false },
      { k: 'Build', v: '7f3c2a1', sep: true },
      { k: 'Released', v: '14.10.2026', sep: true },
      { k: 'Browser', v: 'Firefox', sep: true },
    ]);
  });

  it('uses the date format of the settings for “Released”', () => {
    expect(setup({ dateFmt: 'iso' }).v.aboutRows[2]?.v).toBe('2026-10-14');
    expect(setup({ dateFmt: 'us' }).v.aboutRows[2]?.v).toBe('10/14/2026');
  });

  it('calculates “Released” in the time zone of the settings', () => {
    const build = { version: '0.6.0', sha: '7f3c2a1', date: new Date(Date.UTC(2026, 9, 14, 2)) };
    expect(setup({ build, tz: 'Europe/Berlin' }).v.aboutRows[2]?.v).toBe('14.10.2026');
    expect(setup({ build, tz: 'America/New_York' }).v.aboutRows[2]?.v).toBe('13.10.2026');
  });

  it('names “Unknown” without a commit and without a recognised browser', () => {
    const { v } = setup({ build: { version: '0.6.0', sha: '', date: new Date(2026, 9, 14) }, userAgent: 'curl/8' });
    expect(v.aboutRows.map((r) => r.v)).toEqual(['0.6.0', 'Unknown', '14.10.2026', 'Unknown']);
  });

  it('copies the system information and reports it only after success', async () => {
    const { v, ctx } = setup();
    await v.copySys();
    expect(ctx.copy).toHaveBeenCalledWith(
      'Roedy Mail 0.6.0 (Build 7f3c2a1)\nBrowser: Firefox\nTime zone: Europe/Berlin',
    );
    expect(ctx.notify).toHaveBeenCalledWith('System information copied');

    const failed = setup({}, false);
    await failed.v.copySys();
    expect(failed.ctx.notify).not.toHaveBeenCalled();
  });

  it('shows the chip after `update` from `public/config`', () => {
    expect(setup({ update: { available: false, latest: '0.6.0' } }).v).toMatchObject({
      upShowChip: true,
      upChipIcon: 'ti-circle-check',
      upChipText: 'Up to date',
    });
    expect(setup({ update: { available: true, latest: '0.7.0' } }).v).toMatchObject({
      upShowChip: true,
      upChipIcon: 'ti-cloud-download',
      upChipText: 'Update to 0.7.0 available',
    });
  });

  it('shows only version and licenses with the main components without organisation details', () => {
    const { v, ctx } = setup();
    expect(v.hasOrg).toBe(false);
    expect(v.hasSupport).toBe(false);
    expect(v.hasLegal).toBe(false);
    expect(v.upShowChip).toBe(false);
    expect(v.aboutTabs.map((t) => t.label)).toEqual(['Version', 'Licenses']);
    v.aboutTabs[1]?.onClick();
    expect(ctx.scrollTo).toHaveBeenCalledWith('licenses');
    expect(v.licLinks.map((l) => [l.label, l.sub, l.tag, l.icon])).toEqual([
      ['Svelte', 'User interface', 'MIT', 'ti-brand-svelte'],
      ['Tabler Icons', 'Icons', 'MIT', 'ti-icons'],
      ['Nunito Sans', 'Font', 'OFL-1.1', 'ti-typography'],
      ['Young Serif', 'Font', 'OFL-1.1', 'ti-typography'],
      ['Rust/axum', 'Server', 'MIT/Apache-2.0', 'ti-brand-rust'],
      ['SQLite', 'Database', 'Public Domain', 'ti-database'],
    ]);
    expect(v.licLinks.every((l) => l.hasTag && l.href.startsWith('https://'))).toBe(true);
  });

  it('opens “All licenses” via the last row', () => {
    const { v, ctx } = setup();
    expect(v.licRow).toMatchObject({ label: 'All licenses', sub: 'Web app and server, with license texts' });
    v.licRow.open();
    expect(ctx.openLicenses).toHaveBeenCalledOnce();
  });

  it('builds support, legal and source code from the organisation details', () => {
    const { v, ctx } = setup({ org: ORG });
    expect(v.aboutTabs.map((t) => t.label)).toEqual(['Version', 'Support', 'Legal', 'Licenses']);
    v.aboutTabs[2]?.onClick();
    expect(ctx.scrollTo).toHaveBeenCalledWith('legal');
    expect(v.supportLinks).toEqual([
      {
        label: 'Help center',
        icon: 'ti-help-circle',
        sub: 'example.com/help',
        href: 'https://example.com/help',
        tag: '',
        hasTag: false,
      },
      {
        label: 'Contact support',
        icon: 'ti-mail',
        sub: 'support@example.com',
        href: 'mailto:support@example.com',
        tag: '',
        hasTag: false,
      },
    ]);
    // Without terms of use only two rows; an address without a scheme counts as https.
    expect(v.legalLinks.map((l) => [l.label, l.sub, l.href])).toEqual([
      ['Legal notice', 'example.com/imprint', 'https://example.com/imprint'],
      ['Privacy policy', 'example.com/privacy', 'https://www.example.com/privacy/'],
    ]);
    expect(v.licLinks[0]).toEqual({
      label: 'Source code',
      icon: 'ti-code',
      sub: 'github.com/example/my-app',
      href: 'https://github.com/example/my-app',
      tag: '',
      hasTag: false,
    });
    expect(v.licLinks).toHaveLength(7);
    expect(v).toMatchObject({
      hasOrg: true,
      orgName: 'Example Inc.',
      orgHasLink: true,
      orgNoLink: false,
      orgHref: 'https://example.com/',
    });
  });

  it('shows the name of the organisation without a link when there is no website', () => {
    const { v } = setup({ org: { ...NO_ORG, name: 'Example Inc.' } });
    expect(v).toMatchObject({ hasOrg: true, orgHasLink: false, orgNoLink: true, orgHref: undefined });
  });

  it('leaves out addresses with a foreign scheme and invalid email addresses', () => {
    const { v } = setup({
      org: {
        ...NO_ORG,
        name: 'Example Inc.',
        website: 'javascript:alert(1)',
        help: 'data:text/html,hello',
        email: 'support@example.com?subject=x',
        imprint: 'ftp://example.com/imprint',
        source: '  ',
      },
    });
    expect(v.orgHasLink).toBe(false);
    expect(v.hasSupport).toBe(false);
    expect(v.hasLegal).toBe(false);
    expect(v.licLinks[0]?.label).toBe('Svelte');
    expect(setup({ org: { ...NO_ORG, email: 'sup\u0007port@example.com' } }).v.hasSupport).toBe(false);
  });
});

describe('deviceOf', () => {
  it.each([
    ['Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36 Edg/140.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15', 'Safari on macOS'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile Safari/604.1', 'Safari on iPhone'],
    ['Mozilla/5.0 (Linux; Android 15) Chrome/140.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) Chrome/140.0 Safari/537.36', 'Chrome on ChromeOS'],
    ['Unknown (Linux)', 'Browser on Linux'],
    ['Firefox/140.0', 'Firefox'],
    ['', 'Unknown device'],
  ])('recognises %s', (ua, device) => {
    expect(deviceOf(ua)).toBe(device);
  });
});

describe('browserOf', () => {
  it('recognises Edge, Firefox, Chrome and Safari by user agent', () => {
    const chrome =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
    expect(browserOf(`${chrome} Edg/140.0`)).toBe('Edge');
    expect(browserOf(FIREFOX)).toBe('Firefox');
    expect(browserOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) FxiOS/140.0 Safari/605.1')).toBe(
      'Firefox',
    );
    expect(browserOf(chrome)).toBe('Chrome');
    expect(browserOf('Mozilla/5.0 (iPhone) CriOS/140.0 Mobile Safari/604.1')).toBe('Chrome');
    expect(browserOf('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toBe('Safari');
    expect(browserOf('')).toBeNull();
  });
});
