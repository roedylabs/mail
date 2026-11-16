/**
 * Choice of the search filters: the sections of the filter panel (desktop)
 * and the rows with their subpages in the filter sheet (mobile). Pure:
 * filter, environment and senders come in, a choice goes out as a change to
 * `set`.
 */
import { MA_COLORS } from '@roedy/tokens';
import type { IconName } from '#lib/icons.ts';
import { avatarOf, initials } from '#lib/mail-list.ts';
import { m } from '#lib/paraglide/messages.js';
import { CAT_ICON, catLabel, norm } from '#lib/search.ts';
import {
  fieldLabel,
  parseFolderKey,
  SF_FIELDS,
  SF_STATES,
  SF_TIMES,
  STATE_ICON,
  stateLabel,
  timeLabel,
  type FilterEnv,
  type FilterPatch,
  type FolderKey,
  type SearchFilter,
  type SfField,
  type SfTime,
} from '#lib/search-filter.ts';

/** A choice in a section of the panel or on a subpage of the sheet. */
export interface FilterOption {
  key: string;
  label: string;
  on: boolean;
  icon?: IconName;
  /** Colour dot of an account or tag. */
  dot?: string;
  /** Avatar of a sender. */
  avatar?: { text: string; bg: string; ink: string };
  /** Address of a sender below the name. */
  email?: string;
  /** Depth for the indentation: subfolders, subtags. */
  depth: number;
  /** Tooltip with the path (custom folders, subtags). */
  tip?: string;
  /** Single choice: the subpage of the sheet closes afterwards. */
  closes: boolean;
  select: () => void;
}

export type DimKey = 'cats' | 'account' | 'folder' | 'tags' | 'st' | 'time' | 'from' | 'fields';

/** A filter with label, value and choices. */
export interface FilterDim {
  key: DimKey;
  label: string;
  icon: IconName;
  multi: boolean;
  /** Nothing chosen. */
  def: boolean;
  /** Chosen value in short form. */
  value: string;
  opts: FilterOption[];
}

/** Senders to choose from: contacts, most important first. */
export interface Sender {
  name: string;
  email: string;
}

export interface FilterInput {
  sf: SearchFilter;
  env: FilterEnv;
  senders: readonly Sender[];
  set: (patch: FilterPatch) => void;
}

/** Rows of the sheet with a subpage; status and time range sit there as chips. */
export const SHEET_DIMS: readonly DimKey[] = ['cats', 'account', 'folder', 'tags', 'from', 'fields'];

/** Steps of the time range in the panel, from short to any. */
export const TIME_STOPS: readonly SfTime[] = ['today', '7d', '30d', 'year', 'any'];

const FIELD_ICON: Record<SfField, IconName> = {
  s: 'ti-heading',
  from: 'ti-user',
  body: 'ti-align-left',
  att: 'ti-paperclip',
};

const timeIcon = (t: SfTime): IconName =>
  t === 'any' ? 'ti-infinity' : t === 'today' ? 'ti-calendar-event' : 'ti-calendar';

const toggle = <T>(list: readonly T[], value: T): T[] =>
  list.includes(value) ? list.filter((x) => x !== value) : [...list, value];

const dotOf = (color: number | undefined): string => (MA_COLORS[color ?? 0] ?? MA_COLORS[0])[1];

function option(key: string, label: string, on: boolean, select: () => void, extra: Partial<FilterOption> = {}) {
  return { key, label, on, depth: 0, closes: false, select, ...extra } satisfies FilterOption;
}

/** A folder of another account drops out when the account changes. */
function keepFolder(folder: FolderKey | null, account: string | null): FolderKey | null {
  const p = folder && parseFolderKey(folder);
  return p && 'account' in p && account && p.account !== account ? null : folder;
}

/** Custom folders, in the chosen account or in all. */
function customFolders({ sf, env }: FilterInput) {
  return env.folders.flatMap((f) => {
    const p = parseFolderKey(f.key);
    if (!p || !('account' in p) || (sf.account && p.account !== sf.account)) return [];
    const email = env.accounts.find((a) => a.id === p.account)?.email ?? p.account;
    return [{ ...f, path: f.path ?? [], email }];
  });
}

/** Senders whose name or address contains the input. */
function matchSenders(senders: readonly Sender[], query: string): Sender[] {
  const q = norm(query.trim());
  return q ? senders.filter((s) => norm(`${s.name} ${s.email}`).includes(q)) : [...senders];
}

function senderOption(s: Sender, on: boolean, select: () => void): FilterOption {
  const name = s.name || s.email;
  const [bg, ink] = avatarOf(name);
  return option(`from:${s.email}`, name, on, select, {
    avatar: { text: initials(name) || s.email.charAt(0).toUpperCase(), bg, ink },
    email: s.email,
    closes: true,
  });
}

const joinAnd = (labels: readonly string[]) => labels.join(' & ');

/** Filters with value and choices: category, account (only with several), folder, tags, status, time range, sender, "Search in". */
export function filterDims(input: FilterInput): FilterDim[] {
  const { sf, env, set } = input;
  const tagLabel = (id: string) => env.tags.find((t) => t.id === id)?.label ?? id;
  const folder = sf.folder ? env.folders.find((f) => f.key === sf.folder) : undefined;
  const account = sf.account ? env.accounts.find((a) => a.id === sf.account) : undefined;
  const from = sf.from.trim();
  const dims: FilterDim[] = [
    {
      key: 'cats',
      label: m.search_dim_cats(),
      icon: 'ti-world',
      multi: true,
      def: !sf.cats.length,
      value: !sf.cats.length
        ? m.search_any_cat()
        : sf.cats.length <= 2
          ? joinAnd(sf.cats.map(catLabel))
          : m.search_cats_n({ n: sf.cats.length }),
      opts: [
        option('', m.search_any_cat(), !sf.cats.length, () => set({ cats: [] }), { icon: 'ti-world' }),
        ...env.allowed.map((c) =>
          option(c, catLabel(c), sf.cats.includes(c), () => set((x) => ({ cats: toggle(x.cats, c) })), {
            icon: CAT_ICON[c],
          }),
        ),
      ],
    },
  ];
  if (env.accounts.length > 1)
    dims.push({
      key: 'account',
      label: m.search_dim_account(),
      icon: 'ti-mailbox',
      multi: false,
      def: !sf.account,
      value: account?.email ?? sf.account ?? m.search_any_account(),
      opts: [
        option('', m.search_any_account(), !sf.account, () => set({ account: null }), {
          icon: 'ti-mailbox',
          closes: true,
        }),
        ...env.accounts.map((a) =>
          option(
            a.id,
            a.email,
            sf.account === a.id,
            () => set((x) => ({ account: a.id, folder: keepFolder(x.folder, a.id) })),
            { dot: dotOf(a.color), closes: true },
          ),
        ),
      ],
    });
  dims.push(
    {
      key: 'folder',
      label: m.search_dim_folder(),
      icon: 'ti-folder',
      multi: false,
      def: !sf.folder,
      value: folder?.label ?? m.search_any_folder(),
      opts: [
        option('', m.search_any_folder(), !sf.folder, () => set({ folder: null }), {
          icon: 'ti-folders',
          closes: true,
        }),
        ...env.folders
          .filter((f) => f.key.startsWith('role:'))
          .map((f) =>
            option(f.key, f.label, sf.folder === f.key, () => set({ folder: f.key }), {
              icon: f.icon ?? 'ti-folder',
              closes: true,
            }),
          ),
        ...customFolders(input).map((f) =>
          option(f.key, f.label, sf.folder === f.key, () => set({ folder: f.key }), {
            icon: 'ti-folder',
            depth: f.path.length,
            closes: true,
          }),
        ),
      ],
    },
    {
      key: 'tags',
      label: m.search_dim_tags(),
      icon: 'ti-tag',
      multi: true,
      def: !sf.tags.length,
      value: !sf.tags.length
        ? m.search_any_tag()
        : sf.tags.length <= 2
          ? joinAnd(sf.tags.map(tagLabel))
          : m.search_tags_n({ n: sf.tags.length }),
      opts: [
        option('', m.search_any_tag(), !sf.tags.length, () => set({ tags: [] }), { icon: 'ti-tags' }),
        ...env.tags.map((t) =>
          option(t.id, t.label, sf.tags.includes(t.id), () => set((x) => ({ tags: toggle(x.tags, t.id) })), {
            dot: dotOf(t.color),
            depth: t.path?.length ?? 0,
          }),
        ),
      ],
    },
    {
      key: 'st',
      label: m.search_dim_st(),
      icon: 'ti-mail',
      multi: true,
      def: !sf.st.length,
      value: sf.st.length ? joinAnd(sf.st.map(stateLabel)) : m.search_any_state(),
      opts: [
        option('', m.search_any_state(), !sf.st.length, () => set({ st: [] }), { icon: 'ti-mails' }),
        ...SF_STATES.map((s) =>
          option(s, stateLabel(s), sf.st.includes(s), () => set((x) => ({ st: toggle(x.st, s) })), {
            icon: STATE_ICON[s],
          }),
        ),
      ],
    },
    {
      key: 'time',
      label: m.search_dim_time(),
      icon: 'ti-calendar',
      multi: false,
      def: sf.time === 'any',
      value: timeLabel(sf.time),
      opts: SF_TIMES.map((t) =>
        option(t, timeLabel(t), sf.time === t, () => set({ time: t }), { icon: timeIcon(t), closes: true }),
      ),
    },
    {
      key: 'from',
      label: m.search_dim_from(),
      icon: 'ti-user',
      multi: false,
      def: !from,
      value: from || m.search_any_from(),
      opts: [
        option('', m.search_any_from(), !from, () => set({ from: '' }), { icon: 'ti-users', closes: true }),
        ...matchSenders(input.senders, from)
          .slice(0, 6)
          .map((s) => senderOption(s, from.toLowerCase() === s.email.toLowerCase(), () => set({ from: s.email }))),
      ],
    },
    {
      key: 'fields',
      label: m.search_dim_fields(),
      icon: 'ti-list-search',
      multi: true,
      def: !sf.fields.length,
      value: sf.fields.length ? sf.fields.map(fieldLabel).join(', ') : m.search_any_field(),
      opts: [
        option('', m.search_any_field(), !sf.fields.length, () => set({ fields: [] }), { icon: 'ti-list-search' }),
        ...SF_FIELDS.map((f) =>
          option(
            f,
            fieldLabel(f),
            sf.fields.includes(f),
            () =>
              set((x) => {
                const next = toggle(x.fields, f);
                return { fields: next.length === SF_FIELDS.length ? [] : next };
              }),
            { icon: FIELD_ICON[f] },
          ),
        ),
      ],
    },
  );
  return dims;
}

/** Sections of the panel with their own "Reset". */
export type PanelSection = 'st' | 'time' | 'account' | 'folder' | 'tags' | 'from' | 'fields';

/** Chips of the filter panel; the pills show the categories there. */
export interface PanelGroups {
  /** Only with several accounts. */
  accounts: FilterOption[] | null;
  /** "All" and the mailboxes of the sidebar. */
  sysFolders: FilterOption[];
  /** Custom folders to expand. */
  customFolders: FilterOption[];
  /** Button "Custom folders": chosen folder or the label. */
  customButton: { label: string; on: boolean };
  /** Tags of the top level. */
  tags: FilterOption[];
  /** Subtags to expand. */
  subTags: FilterOption[];
  /** Button "Subtags". */
  subButton: { label: string; on: boolean };
  st: FilterOption[];
  /** Steps of the time range and the chosen one. */
  time: FilterOption[];
  timeIndex: number;
  /** "Search in": on as long as all or this field are chosen. */
  fields: FilterOption[];
  /** Senders for the input from two characters on. */
  fromSuggestions: FilterOption[];
  sections: Record<PanelSection, { on: boolean; clear: () => void }>;
}

export function panelGroups(input: FilterInput): PanelGroups {
  const { sf, env, set } = input;
  const custom = customFolders(input);
  const customSel = custom.find((f) => f.key === sf.folder);
  const subs = env.tags.filter((t) => (t.path?.length ?? 0) > 0);
  const subSel = subs.filter((t) => sf.tags.includes(t.id));
  const from = sf.from.trim();
  const query = norm(from);
  const timeIndex = TIME_STOPS.indexOf(sf.time);
  return {
    accounts:
      env.accounts.length > 1
        ? [
            option('', m.search_any_account(), !sf.account, () => set({ account: null })),
            ...env.accounts.map((a) =>
              option(
                a.id,
                a.email,
                sf.account === a.id,
                () =>
                  set((x) => {
                    const account = x.account === a.id ? null : a.id;
                    return { account, folder: keepFolder(x.folder, account) };
                  }),
                { dot: dotOf(a.color) },
              ),
            ),
          ]
        : null,
    sysFolders: [
      option('', m.search_all(), !sf.folder, () => set({ folder: null })),
      ...env.folders
        .filter((f) => f.key.startsWith('role:'))
        .map((f) =>
          option(
            f.key,
            f.label,
            sf.folder === f.key,
            () => set((x) => ({ folder: x.folder === f.key ? null : f.key })),
            {
              icon: f.icon ?? 'ti-folder',
            },
          ),
        ),
    ],
    customFolders: custom.map((f) =>
      option(f.key, f.label, sf.folder === f.key, () => set((x) => ({ folder: x.folder === f.key ? null : f.key })), {
        icon: 'ti-folder',
        tip: [f.email, ...f.path, f.label].join(' › '),
      }),
    ),
    customButton: { label: customSel?.label ?? m.search_custom_folders(), on: !!customSel },
    tags: env.tags
      .filter((t) => !t.path?.length)
      .map((t) =>
        option(t.id, t.label, sf.tags.includes(t.id), () => set((x) => ({ tags: toggle(x.tags, t.id) })), {
          dot: dotOf(t.color),
        }),
      ),
    subTags: subs.map((t) =>
      option(t.id, t.label, sf.tags.includes(t.id), () => set((x) => ({ tags: toggle(x.tags, t.id) })), {
        dot: dotOf(t.color),
        tip: [...(t.path ?? []), t.label].join(' › '),
      }),
    ),
    subButton: {
      label:
        subSel.length === 1
          ? subSel[0]!.label
          : subSel.length
            ? m.search_subtags_n({ n: subSel.length })
            : m.search_subtags(),
      on: subSel.length > 0,
    },
    st: SF_STATES.map((s) =>
      option(s, stateLabel(s), sf.st.includes(s), () => set((x) => ({ st: toggle(x.st, s) })), {
        icon: STATE_ICON[s],
      }),
    ),
    time: TIME_STOPS.map((t) => option(t, timeLabel(t), sf.time === t, () => set({ time: t }))),
    timeIndex: Math.max(0, timeIndex),
    fields: SF_FIELDS.map((f) => {
      const on = !sf.fields.length || sf.fields.includes(f);
      return option(
        f,
        fieldLabel(f),
        on,
        () =>
          set((x) => {
            const next = toggle(x.fields.length ? x.fields : SF_FIELDS, f);
            return { fields: !next.length || next.length === SF_FIELDS.length ? [] : next };
          }),
        { icon: on ? 'ti-check' : 'ti-plus' },
      );
    }),
    fromSuggestions:
      query.length >= 2
        ? matchSenders(input.senders, from)
            .filter((s) => s.email.toLowerCase() !== from.toLowerCase())
            .slice(0, 4)
            .map((s) => senderOption(s, false, () => set({ from: s.email })))
        : [],
    sections: {
      st: { on: sf.st.length > 0, clear: () => set({ st: [] }) },
      time: { on: sf.time !== 'any', clear: () => set({ time: 'any' }) },
      account: { on: !!sf.account, clear: () => set({ account: null }) },
      folder: { on: !!sf.folder, clear: () => set({ folder: null }) },
      tags: { on: sf.tags.length > 0, clear: () => set({ tags: [] }) },
      from: { on: !!from, clear: () => set({ from: '' }) },
      fields: { on: sf.fields.length > 0, clear: () => set({ fields: [] }) },
    },
  };
}
