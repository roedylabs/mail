/**
 * Values of the Settings › About page: version with build, date and browser
 * (`aboutRows`), system information to copy (`copySys`), support, legal and
 * licenses as links (`supportLinks`, `legalLinks`, `licLinks`) and the section
 * tabs.
 *
 * Version, build and date come from the build info (`#lib/build-info.ts`) like
 * the version in the settings navigation, the links from `org` of
 * `public/config` (Administration › Organisation; address checks in
 * `#lib/links.ts`). "Licenses" shows the main components (`LIBS`) and below
 * them the row "All licenses" (`licRow`), which opens the dialog with the full
 * list from `licenses.json` (`#lib/licenses.svelte.ts`). The chip (`upShowChip`)
 * follows `update` from `public/config`.
 */
import { formatBuildDate } from '#lib/build-info.ts';
import type { IconName } from '#lib/icons.ts';
import { isAddress, linkHref, shortHref } from '#lib/links.ts';
import { m } from '#lib/paraglide/messages.js';
import type { Org, PublicUpdate } from '#lib/state/session.svelte.ts';

export type AboutSection = 'version' | 'support' | 'legal' | 'licenses';

/** Row of support, legal and licenses. */
export interface AboutLink {
  label: string;
  icon: IconName;
  /** Short address or role of the component. */
  sub: string;
  href: string;
  /** License of the component (only in `licLinks`). */
  tag: string;
  hasTag: boolean;
}

/** Main components; `licRow` opens the full list. */
const LIBS: { name: string; role: () => string; icon: IconName; lic: string; href: string }[] = [
  { name: 'Svelte', role: m.about_role_ui, icon: 'ti-brand-svelte', lic: 'MIT', href: 'https://svelte.dev' },
  { name: 'Tabler Icons', role: m.about_role_icons, icon: 'ti-icons', lic: 'MIT', href: 'https://tabler.io/icons' },
  {
    name: 'Nunito Sans',
    role: m.about_role_font,
    icon: 'ti-typography',
    lic: 'OFL-1.1',
    href: 'https://fonts.google.com/specimen/Nunito+Sans',
  },
  {
    name: 'Young Serif',
    role: m.about_role_font,
    icon: 'ti-typography',
    lic: 'OFL-1.1',
    href: 'https://fonts.google.com/specimen/Young+Serif',
  },
  {
    name: 'Rust/axum',
    role: m.about_role_server,
    icon: 'ti-brand-rust',
    lic: 'MIT/Apache-2.0',
    href: 'https://github.com/tokio-rs/axum',
  },
  { name: 'SQLite', role: m.about_role_db, icon: 'ti-database', lic: 'Public Domain', href: 'https://sqlite.org' },
];

export interface AboutInput {
  appName: string;
  /** `org` from `public/config`; `null` while it is not loaded. */
  org: Org | null;
  /** `update` from `public/config`; `null` = no chip. */
  update: PublicUpdate | null;
  build: { version: string; sha: string; date: Date };
  /** Date format of the settings (`dateFmt`) for "Released". */
  dateFmt: string;
  /** Time zone of the settings (`tzCur`, `displayZone()`) for "Released" and the system information. */
  tz: string;
  userAgent: string;
}

export interface AboutContext {
  scrollTo: (section: AboutSection) => void;
  /** To the clipboard (`copyText`); `false` if it did not work. */
  copy: (text: string) => Promise<boolean>;
  notify: (text: string) => void;
  /** "All licenses": dialog on desktop, sheet on mobile (`LicenseDialogState.show`). */
  openLicenses: () => void;
}

export interface AboutValues {
  appVersion: string;
  aboutTabs: { label: string; onClick: () => void }[];
  hasOrg: boolean;
  orgName: string;
  orgHasLink: boolean;
  orgNoLink: boolean;
  orgHref: string | undefined;
  upShowChip: boolean;
  upChipIcon: IconName;
  upChipText: string;
  aboutRows: { k: string; v: string; sep: boolean }[];
  copySys: () => Promise<void>;
  supportLinks: AboutLink[];
  hasSupport: boolean;
  legalLinks: AboutLink[];
  hasLegal: boolean;
  licLinks: AboutLink[];
  /** Last row of the licenses, without a count (the list only loads when opened). */
  licRow: { label: string; sub: string; open: () => void };
}

/** Browser from the user agent; `null` if none is recognised. */
export function browserOf(ua: string): string | null {
  if (/Edg(A|iOS)?\//.test(ua)) return 'Edge';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\/|Chromium\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return null;
}

/** Operating system from the user agent; `null` if none is recognised. */
function osOf(ua: string): string | null {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/CrOS/.test(ua)) return 'ChromeOS';
  if (/Mac/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  return /Linux/.test(ua) ? 'Linux' : null;
}

/** Device as shown in the system information: "Firefox on Linux". */
export function deviceOf(ua: string): string {
  const browser = browserOf(ua);
  const os = osOf(ua);
  if (os) return m.dev_device({ browser: browser ?? m.dev_device_browser(), os });
  return browser ?? m.dev_device_unknown();
}

/** Link row; none without a (valid) address. */
function link(label: string, icon: IconName, value: string | null): AboutLink | null {
  const href = value ? linkHref(value) : null;
  return href ? { label, icon, sub: shortHref(value!), href, tag: '', hasTag: false } : null;
}

export function aboutValues(input: AboutInput, ctx: AboutContext): AboutValues {
  const { build, org, update } = input;
  const email = org?.email?.trim() ?? '';
  const supportLinks = [
    link(m.about_help(), 'ti-help-circle', org?.help ?? null),
    isAddress(email)
      ? { label: m.about_contact(), icon: 'ti-mail', sub: email, href: `mailto:${email}`, tag: '', hasTag: false }
      : null,
  ].filter((l): l is AboutLink => l !== null);
  const legalLinks = [
    link(m.about_imprint(), 'ti-id', org?.imprint ?? null),
    link(m.about_privacy(), 'ti-lock', org?.privacy ?? null),
    link(m.about_terms(), 'ti-file-text', org?.terms ?? null),
  ].filter((l): l is AboutLink => l !== null);
  const source = link(m.about_source(), 'ti-code', org?.source ?? null);
  const licLinks = [
    ...(source ? [source] : []),
    ...LIBS.map((l) => ({ label: l.name, icon: l.icon, sub: l.role(), href: l.href, tag: l.lic, hasTag: true })),
  ];

  const orgName = org?.name?.trim() ?? '';
  const orgHref = orgName && org?.website ? (linkHref(org.website) ?? undefined) : undefined;
  const sha = build.sha || m.about_unknown();
  const browser = browserOf(input.userAgent) ?? m.about_unknown();
  // Support and legal only with links.
  const sections: [AboutSection, string, boolean][] = [
    ['version', m.about_version(), true],
    ['support', m.about_tab_support(), supportLinks.length > 0],
    ['legal', m.about_tab_legal(), legalLinks.length > 0],
    ['licenses', m.about_tab_licenses(), true],
  ];
  const rows: [string, string][] = [
    [m.about_version(), build.version],
    [m.about_build(), sha],
    [m.about_released(), formatBuildDate(build.date, input.dateFmt, input.tz)],
    [m.about_browser(), browser],
  ];

  return {
    appVersion: build.version,
    aboutTabs: sections
      .filter(([, , shown]) => shown)
      .map(([section, label]) => ({ label, onClick: () => ctx.scrollTo(section) })),
    hasOrg: !!orgName,
    orgName,
    orgHasLink: !!orgHref,
    orgNoLink: !orgHref,
    orgHref,
    upShowChip: !!update,
    upChipIcon: update?.available ? 'ti-cloud-download' : 'ti-circle-check',
    upChipText: update?.available ? m.about_update_available({ version: update.latest }) : m.about_up_to_date(),
    aboutRows: rows.map(([k, v], i) => ({ k, v, sep: i > 0 })),
    copySys: async () => {
      const text = m.about_sys_text({ app: input.appName, version: build.version, build: sha, browser, tz: input.tz });
      if (await ctx.copy(text)) ctx.notify(m.about_sys_copied());
    },
    supportLinks,
    hasSupport: supportLinks.length > 0,
    legalLinks,
    hasLegal: legalLinks.length > 0,
    licLinks,
    licRow: { label: m.lic_row(), sub: m.lic_row_sub(), open: ctx.openLicenses },
  };
}
