/**
 * Administration › Users against the users API: list from `GET users` (users
 * and invitations), search, filter, sorting, selection with bulk actions
 * (`users/bulk`), inviting (`POST invites`) with a result notice and "Copy
 * link" (`GET invites/:id/link`), actions per row.
 *
 * Role, lock and unlock change the display immediately and go to the server
 * with undo only after the toast expires (`ui.toasts.defer`). Removing,
 * withdrawing an invitation and "Reset multi-factor" do the same after the
 * confirmation; leaving the page sends them immediately. If one fails, the
 * row returns with the error toast. Errors without a text of their own show
 * the generic error toast and reload the list. Local changes the server does
 * not know yet also apply to reloaded lists until their call is through.
 *
 * The list stays for the session (`keptUsers`): a reopened page shows it at
 * once and loads again in the background; if that fails, the list stays with
 * the toast "Couldn’t update the list.".
 */
import { AV } from '@roedy/tokens';
import { SvelteSet } from 'svelte/reactivity';
import { ago } from '#lib/ago.ts';
import { ApiError, api, fieldsOf, isApiError, retryAfter } from '#lib/api.ts';
import { copyPending } from '#lib/clipboard.svelte.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import { isEmail } from '#lib/email.ts';
import { failText, loadFailText, timeZoneOf } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import type { KeyInput } from '#lib/keys.ts';
import { nameError, nameErrorText, normalizeName } from '#lib/name.ts';
import { m } from '#lib/paraglide/messages.js';
import { pickList, type SelectValues } from '#lib/select.ts';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { Kept } from '#lib/state/kept.ts';
import { initialsOf, session } from '#lib/state/session.svelte.ts';
import { Loading, ui } from '#lib/state/ui.svelte.ts';
import type { DeferredAction } from '#lib/undo.ts';
import { waitText } from '#lib/wait.ts';
import { intlLocale } from '#lib/locale.ts';

/** At most this many addresses at once (`POST invites`). */
export const MAX_INVITES = 50;

export type Role = 'admin' | 'user';
export type UserStatus = 'active' | 'locked' | 'invited';
export type UsersFilter = 'all' | UserStatus;
export type SortKey = 'name' | 'role' | 'status';
export type ListStatus = 'loading' | 'ready' | 'failed';

/** Entry of `GET users` (`api::users::user_json` or `invite_json`). */
export interface ListedUser {
  id: string;
  status: UserStatus;
  /** Display name; for invitations only if it was in the form. */
  name: string | null;
  email: string;
  username?: string | null;
  role: Role;
  /** Confirmed authenticator app. */
  mfa: boolean;
  last_seen_at?: string | null;
  created_at: string;
  invited_by?: { id: string; name: string | null } | null;
  /** Last successful sending; empty = "Not sent". */
  mail_sent_at?: string | null;
  expires_at?: string;
  expired?: boolean;
}

/** Response of `POST invites`. */
interface CreatedInvites {
  invites: { id: string; email: string; sent: boolean }[];
  system_mail: boolean;
}

/** Form "Invite people". */
interface InviteForm {
  /** Counts up per opened form: responses only apply to their form. */
  id: number;
  /** Text in the field, not yet a chip. */
  email: string;
  name: string;
  list: string[];
  role: Role;
  focus: boolean;
  busy: boolean;
  /** Name error of the server (`fields.name`) until the name changes. */
  nameErr: 'too_long' | 'invalid' | null;
}

/** Result after "Send invitation" if not all mails went out. */
interface InviteResult {
  ids: string[];
  n: number;
  /** No system mail: invitations only created. */
  off: boolean;
}

/** Roles (order = sorting "Role"). */
const ROLES: readonly Role[] = ['admin', 'user'];
const STATUS_ORDER: Record<UserStatus, number> = { active: 0, invited: 1, locked: 2 };
const FILTERS: readonly UsersFilter[] = ['all', 'active', 'invited', 'locked'];
/** Fields that actions of the list change. */
type RowPatch = Partial<Pick<ListedUser, 'role' | 'status' | 'mfa'>>;

/** Local change the server does not know yet (toast running or call on its way). */
interface Overlay {
  ids: readonly string[];
  /** Changed fields; without: rows removed. */
  patch?: RowPatch;
  /** The rows without this change (as the server still knows them). */
  undo: (rows: ListedUser[]) => ListedUser[];
}

/** Lifting a local change: revert it or, if the server knows it, settle it. */
interface Change {
  revert: () => void;
  settle: () => void;
}

/** Separators between addresses in the field (comma, semicolon, whitespace). */
const SEP = /[\s,;]+/;

const roleLabel = (r: Role) => (r === 'admin' ? m.users_role_admin() : m.users_role_user());
const roleDesc = (r: Role) => (r === 'admin' ? m.users_role_admin_desc() : m.users_role_user_desc());
const roleIcon = (r: Role): IconName => (r === 'admin' ? 'ti-crown' : 'ti-user');
const statusLabel = (s: UserStatus) =>
  s === 'active' ? m.users_status_active() : s === 'invited' ? m.users_status_invited() : m.users_status_locked();

/** Shown name: name, otherwise the address. */
export const displayName = (u: ListedUser) => u.name || u.email;
const people = (n: number) => (n === 1 ? m.users_people_one() : m.users_people_many({ n }));

/** Point in time of the row: for invitations the last sending, for users the last activity. */
function atOf(u: ListedUser): number {
  const iso = u.status === 'invited' ? (u.mail_sent_at ?? u.created_at) : (u.last_seen_at ?? u.created_at);
  return Date.parse(iso) || 0;
}

/** Fixed colour per address (so it does not shift when a row is removed). */
function avatarOf(email: string): readonly [string, string] {
  let h = 7;
  for (const ch of email.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AV[h % AV.length] ?? AV[0];
}

function splitAddresses(value: string): string[] {
  return value.split(SEP).filter(Boolean);
}

/** Append addresses, duplicates regardless of case only once. */
function addAddresses(list: readonly string[], tokens: readonly string[]): string[] {
  const out = [...list];
  for (const raw of tokens) {
    const t = raw.trim();
    if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

type ChipKind = 'ok' | 'bad' | 'dup';

/** Key in a field (`#lib/keys.ts`). */
export type { KeyInput };

/** List of the last open page of the session. */
export const keptUsers = new Kept<ListedUser[]>();

export class UsersPage {
  rows = $state<ListedUser[]>([]);
  status = $state<ListStatus>('loading');
  /** Reason the first load failed (text of the card). */
  failure = $state('');
  /** Skeleton only after the skeleton delay. */
  readonly loading = new Loading();

  q = $state('');
  filter = $state<UsersFilter>('all');
  sort = $state<SortKey>('name');
  dir = $state<1 | -1>(1);
  /** Expanded row. */
  open = $state<string | null>(null);
  selected = $state<string[]>([]);
  invite = $state<InviteForm | null>(null);
  result = $state<InviteResult | null>(null);
  /** "Resend" failed. */
  sendFail = $state<string | null>(null);
  /** Marked role of the select list "Change role" (arrow keys). */
  roleHi = $state<number | null>(null);
  /** Rows with a running request (resend, extend, link). */
  readonly busy = new SvelteSet<string>();
  /** Lock of "Send invitation" after 429 (`invites.mail`); the wait time runs along. */
  readonly inviteLock = new Countdown<'invite'>();

  /** Addresses reported by the server as taken or invalid (lower case), per form. */
  readonly #taken = new SvelteSet<string>();
  readonly #invalid = new SvelteSet<string>();
  #overlays: Overlay[] = [];
  #seq = 0;
  #formId = 0;
  #disposed = false;
  /** Last removal or multi-factor reset with undo: leaving the page sends it immediately. */
  #final: DeferredAction | null = null;
  /** Reopened with the kept list: the next load reports a failure only as "Couldn’t update the list.". */
  #reopened = false;
  readonly #keep = keptUsers.keeper();

  constructor() {
    const kept = keptUsers.value;
    if (!kept) return;
    this.rows = kept;
    this.status = 'ready';
    this.#reopened = true;
  }

  me = $derived(session.user?.id ?? null);
  /** System emails set up (from `auth/me`). */
  hasMail = $derived(session.user?.system_mail_configured !== false);

  /** Hits of the search. */
  matched = $derived.by(() => {
    const q = this.q.trim().toLocaleLowerCase(intlLocale());
    if (!q) return this.rows;
    return this.rows.filter(
      (u) =>
        (u.name ?? '').toLocaleLowerCase(intlLocale()).includes(q) ||
        u.email.toLocaleLowerCase(intlLocale()).includes(q),
    );
  });

  /** Visible rows: filter and sorting. */
  list = $derived.by(() => {
    const byName = (a: ListedUser, b: ListedUser) => displayName(a).localeCompare(displayName(b), intlLocale());
    const cmp: Record<SortKey, (a: ListedUser, b: ListedUser) => number> = {
      name: byName,
      role: (a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role),
      status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || atOf(b) - atOf(a),
    };
    return this.matched
      .filter((u) => this.filter === 'all' || u.status === this.filter)
      .sort((a, b) => cmp[this.sort](a, b) * this.dir || byName(a, b));
  });

  /** Selectable: visible and not the own account (`pickable`). */
  pickable = $derived(this.list.filter((u) => u.id !== this.me));
  /** Selected and visible. */
  chosen = $derived(this.pickable.filter((u) => this.selected.includes(u.id)));

  /** All addresses of the list (`known`), lower case. */
  #known = $derived(this.rows.map((u) => u.email.toLowerCase()));

  /** Addresses in the form including the text in the field. */
  inviteCount = $derived(this.invite ? addAddresses(this.invite.list, [this.invite.email]).length : 0);

  /** Addresses marked red; locks "Send invitation". */
  chipError = $derived.by(() => {
    const bad = (this.invite?.list ?? []).filter((e) => this.chipKind(e) !== 'ok');
    const first = bad[0];
    if (first === undefined) return '';
    if (bad.length > 1) return m.users_invite_err_many({ n: bad.length });
    return this.chipKind(first) === 'dup'
      ? m.users_invite_err_taken({ email: first })
      : m.users_invite_err_invalid({ email: first });
  });

  /**
   * Message below the form: more than 50 addresses, lock (429), name (only
   * with one address), addresses marked red; locks "Send invitation".
   */
  inviteError = $derived.by(() => {
    const form = this.invite;
    if (!form) return '';
    if (this.inviteCount > MAX_INVITES) return m.users_invite_err_max({ n: MAX_INVITES });
    if (this.inviteLock.active('invite')) return m.error_limit({ wait: waitText(this.inviteLock.left('invite')) });
    const name = this.inviteCount <= 1 ? form.nameErr || nameError(form.name) : '';
    if (name) return nameErrorText(name);
    return this.chipError;
  });

  chipKind(email: string): ChipKind {
    const key = email.toLowerCase();
    if (!isEmail(email) || this.#invalid.has(key)) return 'bad';
    return this.#known.includes(key) || this.#taken.has(key) ? 'dup' : 'ok';
  }

  /** Loads the list; after the first load it stays as it is on an error. */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    const reopened = this.#reopened;
    this.#reopened = false;
    let changes = keptUsers.changes;
    try {
      // After a removal the left page sent on leaving: otherwise the response could still contain the user.
      const { users } = await this.loading.run(
        keptUsers.after(() => {
          changes = keptUsers.changes;
          return api<{ users: ListedUser[] }>('GET', 'users');
        }),
      );
      if (seq !== this.#seq || this.#disposed) return;
      // Confirmed in the meantime (e.g. removed): the list is older, so reload.
      if (changes !== keptUsers.changes) {
        this.#reopened = reopened;
        void this.load();
        return;
      }
      this.rows = this.#overlaid(users);
      this.status = 'ready';
      const ids = users.map((u) => u.id);
      this.selected = this.selected.filter((id) => ids.includes(id));
      if (this.open && !ids.includes(this.open)) this.open = null;
    } catch (error) {
      if (seq !== this.#seq || this.#disposed) return;
      // Without a session or role: reload the account, the layout then shows the sign-in or "Access denied".
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        void session.refreshUser().catch(() => {});
      }
      if (this.status !== 'ready') {
        this.failure = loadFailText(error);
        this.status = 'failed';
      } else {
        ui.toasts.error(reopened ? m.error_list() : failText(error, m.error_list()));
      }
    }
  }

  /** Loaded list with the local changes the server does not know yet. */
  #overlaid(users: ListedUser[]): ListedUser[] {
    let rows = users;
    for (const o of this.#overlays) {
      const { patch } = o;
      rows = patch
        ? rows.map((u) => (o.ids.includes(u.id) ? { ...u, ...patch } : u))
        : rows.filter((u) => !o.ids.includes(u.id));
    }
    return rows;
  }

  /** Local change until the server knows it (`settle`) or rejects it (`revert`). */
  #change(o: Overlay): Change {
    this.#overlays.push(o);
    const lift = () => {
      this.#overlays = this.#overlays.filter((x) => x !== o);
    };
    return {
      settle: () => {
        lift();
        keptUsers.changed();
      },
      revert: () => {
        lift();
        this.rows = o.undo(this.rows);
      },
    };
  }

  /** "Try again" of the card: skeleton again until the response. */
  async retry(): Promise<void> {
    this.status = 'loading';
    await this.load();
  }

  /**
   * Leave the page: keep the list as the server knows it (without local changes
   * still on their way, which may yet fail); late responses and errors after a
   * toast expires load nothing any more. A removal or multi-factor reset still
   * waiting in the toast goes out immediately; the toast closes with its undo.
   */
  dispose(): void {
    if (this.status === 'ready' && !this.#disposed) {
      const rows = this.#overlays.reduceRight((list, o) => o.undo(list), $state.snapshot(this.rows));
      this.#keep(rows);
    }
    this.#disposed = true;
    this.inviteLock.stop();
    // With `keepalive`: the tab may be closed right after.
    if (ui.toasts.waiting(this.#final)) void ui.toasts.flush(true);
    this.#final = null;
  }

  // Search, filter, sorting, selection

  setQuery(value: string): void {
    this.q = value;
  }

  setFilter(filter: UsersFilter): void {
    this.filter = filter;
  }

  /** Reset filter and search. */
  resetFilter(): void {
    this.q = '';
    this.filter = 'all';
  }

  /** Sort by column; the same column again reverses the direction. */
  sortBy(key: SortKey): void {
    this.dir = this.sort === key ? (this.dir === 1 ? -1 : 1) : 1;
    this.sort = key;
  }

  toggleOpen(id: string): void {
    this.open = this.open === id ? null : id;
    this.sendFail = null;
    ui.closeMenu();
  }

  toggleSelect(id: string): void {
    if (id === this.me) return;
    this.selected = this.selected.includes(id) ? this.selected.filter((x) => x !== id) : [...this.selected, id];
  }

  /** Select all visible ones or, if all are already selected, none. */
  toggleAll(): void {
    const all = this.chosen.length > 0 && this.chosen.length === this.pickable.length;
    this.selected = all ? [] : this.pickable.map((u) => u.id);
  }

  clearSelection(): void {
    this.selected = [];
    ui.closeMenu();
  }

  // Inviting

  openInvite(): void {
    const id = ++this.#formId;
    this.invite = { id, email: '', name: '', list: [], role: 'user', focus: false, busy: false, nameErr: null };
    // What the server reported as taken may have changed since (e.g. a discarded email change).
    this.#taken.clear();
    this.#invalid.clear();
    this.open = null;
    this.selected = [];
    this.result = null;
  }

  closeInvite(): void {
    this.invite = null;
  }

  #setForm(patch: Partial<InviteForm>): void {
    if (this.invite) this.invite = { ...this.invite, ...patch };
  }

  /** Input in the address field: separators make chips. */
  inviteInput(value: string): void {
    const form = this.invite;
    if (!form) return;
    if (!SEP.test(value)) {
      this.#setForm({ email: value });
      return;
    }
    const parts = value.split(SEP);
    const last = /[\s,;]$/.test(value) ? '' : (parts.pop() ?? '');
    this.#setForm({ list: addAddresses(form.list, parts), email: last });
  }

  /** Take over the text in the field as a chip. */
  #commitText(): void {
    const form = this.invite;
    if (form) this.#setForm({ list: addAddresses(form.list, splitAddresses(form.email)), email: '' });
  }

  /** Enter takes over or sends, backspace in the empty field removes the last chip, Escape closes. */
  inviteKey(event: KeyInput): void {
    const form = this.invite;
    if (!form) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (form.email.trim()) this.#commitText();
      else void this.sendInvites();
    } else if (event.key === 'Backspace' && !form.email && form.list.length) {
      this.#setForm({ list: form.list.slice(0, -1) });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.closeInvite();
    }
  }

  inviteFocus(): void {
    this.#setForm({ focus: true });
  }

  inviteBlur(): void {
    this.#commitText();
    this.#setForm({ focus: false });
  }

  inviteName(value: string): void {
    this.#setForm({ name: value, nameErr: null });
  }

  inviteRole(role: Role): void {
    this.#setForm({ role });
  }

  removeChip(email: string): void {
    const form = this.invite;
    if (form) this.#setForm({ list: form.list.filter((e) => e !== email) });
  }

  /** "Send invitation" or without system mail "Create invitation". */
  async sendInvites(): Promise<void> {
    const form = this.invite;
    if (!form || form.busy) return;
    const list = addAddresses(form.list, splitAddresses(form.email));
    this.#setForm({ list, email: '' });
    if (!list.length || this.inviteError) return;
    const name = list.length === 1 ? normalizeName(form.name) : '';
    this.#setForm({ busy: true });
    // If the form was closed (and reopened) in the meantime, the response does not apply to the new one.
    const current = () => this.invite?.id === form.id;
    try {
      const res = await api<CreatedInvites>('POST', 'invites', {
        emails: list,
        role: form.role,
        ...(name ? { name } : {}),
      });
      // Also for a page already left: a reopened page's load may be older.
      keptUsers.changed();
      if (this.#disposed) return;
      const unsent = res.invites.filter((i) => !i.sent).map((i) => i.id);
      if (current()) this.invite = null;
      this.filter = 'all';
      this.result = unsent.length ? { ids: unsent, n: list.length, off: !res.system_mail } : null;
      if (!unsent.length) {
        ui.toasts.show(list.length === 1 ? m.users_invite_sent() : m.users_invite_sent_many({ n: list.length }));
      }
      // A system mail removed or newly set up in the meantime: otherwise notice and banner would be wrong.
      if (res.system_mail !== this.hasMail) void session.refreshUser().catch(() => {});
      await this.load();
    } catch (error) {
      if (this.#disposed) return;
      if (!current()) {
        this.#failed(error);
        return;
      }
      this.#setForm({ busy: false });
      this.#inviteFailed(error, list);
    }
  }

  #inviteFailed(error: unknown, list: readonly string[]): void {
    if (isApiError(error, 422, 'invalid')) {
      let known = false;
      const fields = fieldsOf(error);
      for (const [path, detail] of Object.entries(fields)) {
        const i = /^emails\.(\d+)$/.exec(path)?.[1];
        const email = i === undefined ? undefined : list[Number(i)];
        if (email === undefined) continue;
        known = true;
        (detail.code === 'taken' ? this.#taken : this.#invalid).add(email.toLowerCase());
      }
      const name = fields.name?.code;
      if (name === 'too_long' || name === 'invalid') {
        known = true;
        this.#setForm({ nameErr: name });
      }
      // The form already checks more than 50 addresses; if the server counts differently, the same text.
      if (fields.emails?.code === 'too_many') ui.toasts.error(m.users_invite_err_max({ n: MAX_INVITES }));
      else if (!known) ui.toasts.error(m.error_act());
      return;
    }
    if (isApiError(error, 429)) {
      this.inviteLock.start('invite', retryAfter(error));
      return;
    }
    this.#failed(error);
  }

  closeResult(): void {
    this.result = null;
  }

  // Actions per row

  /**
   * Action failed: error toast with the text of the place (without a
   * connection "No connection. …"), reload the list; without a session or
   * role reload the account. After leaving the page nothing, except for
   * `late` the error toast (an action sent when leaving).
   */
  #failed(error: unknown, text: string = m.error_act(), late = false): void {
    if (this.#disposed && !late) return;
    if (isApiError(error, 429)) {
      ui.toasts.error(m.error_limit({ wait: waitText(retryAfter(error)) }));
      return;
    }
    ui.toasts.error(failText(error, text));
    if (this.#disposed) return;
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      void session.refreshUser().catch(() => {});
      return;
    }
    void this.load();
  }

  /**
   * Change fields of some rows until the server knows them (`settle`) or they
   * are reverted – then only exactly these fields of these rows.
   */
  #patch(ids: readonly string[], patch: RowPatch): Change {
    const before = this.rows
      .filter((u) => ids.includes(u.id))
      .map((u) => ({ id: u.id, role: u.role, status: u.status, mfa: u.mfa }));
    this.rows = this.rows.map((u) => (ids.includes(u.id) ? { ...u, ...patch } : u));
    const undo = (rows: ListedUser[]) =>
      rows.map((u) => {
        const prev = before.find((b) => b.id === u.id);
        if (!prev) return u;
        const back: Partial<ListedUser> = {};
        for (const key of Object.keys(patch) as (keyof RowPatch)[]) {
          (back as Record<string, unknown>)[key] = prev[key];
        }
        return { ...u, ...back };
      });
    return this.#change({ ids, patch, undo });
  }

  /** Remove rows (remove, withdraw) until the response; `revert` after undo or if the server rejects. */
  #drop(ids: readonly string[]): Change {
    const rows = this.rows;
    this.rows = rows.filter((u) => !ids.includes(u.id));
    this.selected = this.selected.filter((id) => !ids.includes(id));
    if (this.open && ids.includes(this.open)) this.open = null;
    const undo = (now: ListedUser[]) => {
      const known = now.map((u) => u.id);
      return [...now, ...rows.filter((u) => ids.includes(u.id) && !known.includes(u.id))];
    };
    return this.#change({ ids, undo });
  }

  /**
   * Removal or multi-factor reset after the confirmation, with undo: the call
   * goes out when the toast expires or immediately when leaving the page
   * (`dispose`). If it fails, the rows return (`restore`: also selection and
   * expanded row) and the error toast appears.
   */
  #deferFinal(
    text: string,
    change: Change,
    call: (keepalive: boolean) => Promise<unknown>,
    restore?: () => void,
  ): void {
    const action: DeferredAction = {
      text,
      revert: change.revert,
      commit: async (keepalive) => {
        const sending = call(keepalive);
        if (this.#disposed) keptUsers.track(sending);
        await sending;
        change.settle();
      },
      onError: (error) => {
        if (!this.#disposed) restore?.();
        this.#failed(error, m.error_act(), true);
      },
    };
    this.#final = action;
    ui.toasts.defer(action);
  }

  /** Selection and expanded row before a removal, for a failed call (the row only if no other one was opened since). */
  #restorer(ids: readonly string[]): () => void {
    const selected = this.selected.filter((id) => ids.includes(id));
    const open = this.open !== null && ids.includes(this.open) ? this.open : null;
    return () => {
      const known = this.rows.map((u) => u.id);
      this.selected = [...this.selected, ...selected.filter((id) => known.includes(id) && !this.selected.includes(id))];
      if (open !== null && this.open === null && known.includes(open)) this.open = open;
    };
  }

  /** Role in the expanded row, with undo. */
  setRole(u: ListedUser, role: Role): void {
    if (u.id === this.me || u.role === role) return;
    const change = this.#patch([u.id], { role });
    const path = u.status === 'invited' ? `invites/${u.id}` : `users/${u.id}`;
    ui.toasts.defer({
      text: m.users_role_changed(),
      revert: change.revert,
      commit: async (keepalive) => {
        await api('PATCH', path, { role }, { keepalive });
        change.settle();
      },
      onError: (error) => this.#failed(error, m.users_role_failed()),
    });
  }

  /** "Suspend" with confirmation; afterwards with undo. */
  lock(u: ListedUser): void {
    const name = displayName(u);
    ui.ask({
      title: m.users_lock_title({ who: name }),
      text: m.users_lock_text({ name }),
      icon: 'ti-lock',
      ok: m.users_lock(),
      danger: true,
      run: () => this.#setStatus([u], 'locked', m.users_locked({ who: name }), false),
    });
  }

  unlock(u: ListedUser): void {
    this.#setStatus([u], 'active', m.users_unlocked({ who: displayName(u) }), false);
  }

  /** Lock or unlock with undo; the selection via `users/bulk`, a single row via its resource. */
  #setStatus(list: readonly ListedUser[], status: 'active' | 'locked', text: string, bulk: boolean): void {
    const ids = list.map((u) => u.id);
    const change = this.#patch(ids, { status });
    const action = status === 'locked' ? 'lock' : 'unlock';
    ui.toasts.defer({
      text,
      revert: change.revert,
      commit: async (keepalive) => {
        await (bulk
          ? api('POST', 'users/bulk', { action, ids }, { keepalive })
          : api('POST', `users/${ids.join()}/${action}`, undefined, { keepalive }));
        change.settle();
      },
      onError: (error) => {
        const many = ids.length > 1;
        const fail =
          status === 'locked'
            ? many
              ? m.users_lock_failed_many()
              : m.users_lock_failed()
            : many
              ? m.users_unlock_failed_many()
              : m.users_unlock_failed();
        this.#failed(error, fail);
      },
    });
  }

  /** "Remove" or "Revoke invitation" after confirmation, with undo. */
  remove(u: ListedUser): void {
    const name = displayName(u);
    const invited = u.status === 'invited';
    ui.ask({
      title: invited ? m.users_revoke_title() : m.users_remove_title({ who: name }),
      text: invited ? m.users_revoke_text({ email: u.email }) : m.users_remove_text({ name, app: session.appName }),
      icon: 'ti-user-minus',
      ok: invited ? m.users_revoke_ok() : m.users_remove(),
      danger: true,
      run: () => {
        const restore = this.#restorer([u.id]);
        const change = this.#drop([u.id]);
        const path = invited ? `invites/${u.id}` : `users/${u.id}`;
        this.#deferFinal(
          invited ? m.users_revoked() : m.users_removed({ who: name }),
          change,
          (keepalive) => api('DELETE', path, undefined, { keepalive }),
          restore,
        );
      },
    });
  }

  /** "Reset multi-factor" after confirmation, with undo. */
  resetMfa(u: ListedUser): void {
    const name = displayName(u);
    ui.ask({
      title: m.users_mfa_title({ name }),
      text: m.users_mfa_text({ name }),
      icon: 'ti-shield-off',
      ok: m.users_mfa_ok(),
      danger: true,
      run: () => {
        const change = this.#patch([u.id], { mfa: false });
        this.#deferFinal(m.users_mfa_done({ name }), change, (keepalive) =>
          api('POST', `users/${u.id}/reset-mfa`, undefined, { keepalive }),
        );
      },
    });
  }

  /** "Resend": the same link; if sending fails, a message in the row. */
  async resend(u: ListedUser): Promise<void> {
    if (this.busy.has(u.id)) return;
    this.busy.add(u.id);
    try {
      const res = await api<{ invite: ListedUser | null }>('POST', `invites/${u.id}/resend`);
      // Also for a page already left: a reopened page's load may be older.
      keptUsers.changed();
      if (this.#disposed) return;
      const now = res.invite;
      if (now) this.rows = this.rows.map((r) => (r.id === u.id ? now : r));
      if (this.sendFail === u.id) this.sendFail = null;
      ui.toasts.show(m.users_resent());
    } catch (error) {
      if (isApiError(error, 502, 'mail_failed')) this.sendFail = u.id;
      else this.#failed(error);
    } finally {
      this.busy.delete(u.id);
    }
  }

  /**
   * "Extend" an expired invitation: seven
   * days with the same link, without mail and without confirmation.
   */
  async extend(u: ListedUser): Promise<void> {
    if (this.busy.has(u.id)) return;
    this.busy.add(u.id);
    try {
      const res = await api<{ invite: ListedUser | null }>('POST', `invites/${u.id}/renew`);
      // Also for a page already left: a reopened page's load may be older.
      keptUsers.changed();
      if (this.#disposed) return;
      const now = res.invite;
      if (now) this.rows = this.rows.map((r) => (r.id === u.id ? now : r));
      // A failed "Resend" before no longer applies: the invitation is valid again.
      if (this.sendFail === u.id) this.sendFail = null;
      const until = now?.expires_at ?? null;
      ui.toasts.show(m.users_extended({ date: until ? dayMonth(Date.parse(until)) : '' }));
    } catch (error) {
      this.#failed(error);
    } finally {
      this.busy.delete(u.id);
    }
  }

  /**
   * "Copy link": the link from the mail, even if it never went out. The
   * link is requested within the click gesture, otherwise
   * Safari refuses the clipboard.
   */
  async copyLink(u: Pick<ListedUser, 'id'>): Promise<void> {
    const link = api<{ url: string }>('GET', `invites/${u.id}/link`).then(({ url }) =>
      // Without a public address the backend only names the path.
      url.startsWith('/') ? `${location.origin}${url}` : url,
    );
    try {
      if (await copyPending(link)) ui.toasts.show(m.users_link_copied());
      else ui.toasts.error(m.error_copy());
    } catch (error) {
      this.#failed(error);
    }
  }

  // Bulk actions of the selection

  /** Role for the selection; only rows with another role change. */
  bulkRole(role: Role): void {
    ui.closeMenu();
    this.roleHi = null;
    const list = this.chosen.filter((u) => u.role !== role);
    if (!list.length) return;
    const ids = list.map((u) => u.id);
    const change = this.#patch(ids, { role });
    ui.toasts.defer({
      text: list.length === 1 ? m.users_role_changed() : m.users_role_changed_for({ who: people(list.length) }),
      revert: change.revert,
      commit: async (keepalive) => {
        await api('POST', 'users/bulk', { action: 'role', ids, role }, { keepalive });
        change.settle();
      },
      onError: (error) => this.#failed(error, m.users_role_failed()),
    });
  }

  bulkLock(): void {
    const list = this.chosen.filter((u) => u.status === 'active');
    const [one] = list;
    if (!one) return;
    const who = list.length === 1 ? displayName(one) : people(list.length);
    ui.ask({
      title: m.users_lock_title({ who }),
      text: list.length === 1 ? m.users_bulk_lock_text_one({ name: displayName(one) }) : m.users_bulk_lock_text_many(),
      icon: 'ti-lock',
      ok: m.users_lock(),
      danger: true,
      run: () => this.#setStatus(list, 'locked', m.users_locked({ who }), true),
    });
  }

  bulkUnlock(): void {
    const list = this.chosen.filter((u) => u.status === 'locked');
    const [one] = list;
    if (!one) return;
    const who = list.length === 1 ? displayName(one) : people(list.length);
    this.#setStatus(list, 'active', m.users_unlocked({ who }), true);
  }

  /** Remove the selection or withdraw invitations after confirmation, with undo. */
  bulkRemove(): void {
    const list = this.chosen;
    const [one] = list;
    if (!one) return;
    const single = list.length === 1;
    const invited = single && one.status === 'invited';
    const who = single ? displayName(one) : people(list.length);
    ui.ask({
      title: invited ? m.users_revoke_title() : m.users_remove_title({ who }),
      text: single
        ? invited
          ? m.users_revoke_text({ email: one.email })
          : m.users_remove_text({ name: who, app: session.appName })
        : m.users_bulk_remove_text({ app: session.appName }),
      icon: 'ti-user-minus',
      ok: invited ? m.users_revoke_ok() : m.users_remove(),
      danger: true,
      run: () => {
        const ids = list.map((u) => u.id);
        const restore = this.#restorer(ids);
        const change = this.#drop(ids);
        this.#deferFinal(
          m.users_removed({ who }),
          change,
          (keepalive) => api('POST', 'users/bulk', { action: 'remove', ids }, { keepalive }),
          restore,
        );
      },
    });
  }
}

// Values of the page

/** Role as a card. */
export interface RoleCard {
  label: string;
  desc: string;
  icon: IconName;
  on: boolean;
  /** Own account: not changeable. */
  dis: boolean;
  onClick: () => void;
}

export interface Chip {
  label: string;
  /** Invalid or taken: red with icon. */
  bad: boolean;
  tip: string | undefined;
  rmLabel: string;
  remove: () => void;
}

export interface Pill {
  label: string;
  n: number;
  on: boolean;
  onClick: () => void;
}

export interface SortHead {
  label: string;
  aria: string;
  on: boolean;
  /** Descending (arrow rotated). */
  desc: boolean;
  onClick: () => void;
}

/** Select list "Change role" without a value on the button. */
export type RolePick = Omit<SelectValues, 'label' | 'disabled'>;

export interface UserRow {
  id: string;
  name: string;
  email: string;
  sub: string;
  initials: string;
  /** Avatar: background and text colour. */
  av: readonly [string, string];
  isMe: boolean;
  notMe: boolean;
  online: boolean;
  role: string;
  roleIcon: IconName;
  mfa: boolean;
  st: string;
  status: UserStatus;
  /** Invitation expired: status "Expired" in `--danger`. */
  expired: boolean;
  isLockedSt: boolean;
  notLockedSt: boolean;
  last: string;
  lastLong: string;
  sel: boolean;
  isSel: boolean;
  notSel: boolean;
  ckLabel: string;
  open: boolean;
  sendErr: boolean;
  noSendErr: boolean;
  canResend: boolean;
  /** "Copy link": valid invitations; expired ones only after "Extend" or "Resend". */
  canCopy: boolean;
  /** "Extend": only expired invitations, with and without system emails. */
  canExtend: boolean;
  /** Valid invitation: row "Valid until ‹date›". */
  hasValid: boolean;
  validUntil: string;
  hasSendNote: boolean;
  sendNote: string;
  roles: RoleCard[];
  isInvited: boolean;
  isActive: boolean;
  isLocked: boolean;
  removeLabel: string;
  canMfaReset: boolean;
  /** Request running (resend). */
  busy: boolean;
  togSel: () => void;
  toggle: () => void;
  editMe: () => void;
  copyLink: () => void;
  resend: () => void;
  extend: () => void;
  lock: () => void;
  unlock: () => void;
  mfaReset: () => void;
  remove: () => void;
}

export interface InviteResultValues {
  show: boolean;
  /** Without system mail (`ti-mail-off`, calm colours), otherwise a warning. */
  off: boolean;
  icon: IconName;
  title: string;
  text: string;
  rows: { id: string; email: string; copy: () => void }[];
  close: () => void;
}

export interface UsersValues {
  uQ: string;
  uHasQ: boolean;
  onUQ: (value: string) => void;
  clearUQ: () => void;
  uNoMail: boolean;
  uHasMail: boolean;
  /** "Set up email": Administration › Email. */
  uNoMailGo: () => void;
  inviteOpen: boolean;
  inviteClosed: boolean;
  openInvite: () => void;
  invEmail: string;
  invName: string;
  invNameDis: boolean;
  invNamePh: string;
  invNamePhM: string;
  invPh: string;
  invChips: Chip[];
  invFocus: boolean;
  invRoles: RoleCard[];
  invErr: string;
  hasInvErr: boolean;
  invBtn: { dis: boolean };
  invBusy: boolean;
  invSendLabel: string;
  invSendShort: string;
  onInvEmail: (value: string) => void;
  onInvName: (value: string) => void;
  invKey: (event: KeyInput) => void;
  invNameKey: (event: KeyInput) => void;
  onInvFocus: () => void;
  onInvBlur: () => void;
  invSend: () => void;
  invCancel: () => void;
  invRes: InviteResultValues;
  uPills: Pill[];
  uSelOn: boolean;
  uSelOff: boolean;
  uSelText: string;
  uSelClear: () => void;
  selBulkRole: RolePick;
  uBulkCanLock: boolean;
  uBulkCanUnlock: boolean;
  uBulkLock: () => void;
  uBulkUnlock: () => void;
  uBulkRemove: () => void;
  uHasRows: boolean;
  uAllCk: { on: boolean | 'mixed'; label: string; icon: IconName; vis: number; onClick: () => void };
  uHdName: SortHead;
  uHdRole: SortHead;
  uHdStatus: SortHead;
  uRows: UserRow[];
  uEmpty: boolean;
  uEmptyText: string;
  uCanReset: boolean;
  uReset: () => void;
}

export interface UsersContext {
  /** "Edit your account": to Account › Profile. */
  editMe: () => void;
  /** "Set up email": to Administration › Email. */
  setupMail: () => void;
}

function roleCards(current: Role, disabled: boolean, choose: (role: Role) => void): RoleCard[] {
  return ROLES.map((r) => ({
    label: roleLabel(r),
    desc: roleDesc(r),
    icon: roleIcon(r),
    on: r === current,
    dis: disabled,
    onClick: () => choose(r),
  }));
}

/** Day and month in words ("2 November") in the time zone of the settings. */
function dayMonth(t: number): string {
  return new Date(t).toLocaleDateString(intlLocale(), {
    day: 'numeric',
    month: 'long',
    timeZone: timeZoneOf(prefs.values),
  });
}

/** Expiry of an invitation in ms; expired as soon as it has passed (`expired` of the API only applies on loading). */
function expiryOf(u: ListedUser): number | null {
  return u.status === 'invited' && u.expires_at ? Date.parse(u.expires_at) : null;
}

function sendNoteOf(p: UsersPage, u: ListedUser, sendErr: boolean, expired: boolean): string {
  if (u.status !== 'invited') return '';
  if (expired && p.sendFail !== u.id) return p.hasMail ? m.users_note_expired() : m.users_note_expired_off();
  if (!p.hasMail && sendErr) return m.users_note_off();
  if (p.sendFail === u.id) return m.users_note_resend_failed();
  return sendErr ? m.users_note_failed() : '';
}

function rowValues(p: UsersPage, u: ListedUser, ctx: UsersContext, now: number): UserRow {
  const isMe = u.id === p.me;
  const name = displayName(u);
  const sel = !isMe && p.selected.includes(u.id);
  const open = p.open === u.id;
  const invited = u.status === 'invited';
  const sendErr = invited && !u.mail_sent_at;
  const when = ago(atOf(u), now);
  const exp = expiryOf(u);
  const expired = invited && (exp === null ? !!u.expired : exp <= now);
  const until = exp === null ? '' : dayMonth(exp);
  return {
    id: u.id,
    name,
    email: u.email,
    sub: u.name ? u.email : m.users_pending(),
    initials: initialsOf(name),
    av: avatarOf(u.email),
    isMe,
    notMe: !isMe,
    online: isMe,
    role: roleLabel(u.role),
    roleIcon: roleIcon(u.role),
    mfa: u.mfa,
    st: expired ? m.users_expired() : statusLabel(u.status),
    status: u.status,
    expired,
    isLockedSt: u.status === 'locked',
    notLockedSt: u.status !== 'locked',
    last: isMe
      ? m.users_last_now()
      : expired
        ? m.users_expired_on({ date: until })
        : u.status === 'locked'
          ? m.users_last_locked({ ago: when })
          : when,
    lastLong: isMe
      ? m.users_last_now_long()
      : expired
        ? m.users_expired_long({ date: until })
        : invited
          ? m.users_invited_long({ ago: when })
          : m.users_last_long({ ago: when }),
    sel,
    isSel: sel,
    notSel: !sel,
    ckLabel: isMe ? m.users_check_me() : sel ? m.users_check_deselect({ name }) : m.users_check_select({ name }),
    open,
    sendErr,
    noSendErr: !sendErr,
    canResend: invited && p.hasMail,
    canCopy: invited && !expired,
    canExtend: expired,
    hasValid: invited && !expired && until !== '',
    validUntil: invited && !expired && until !== '' ? m.users_valid_until({ date: until }) : '',
    hasSendNote: invited && (expired || sendErr || p.sendFail === u.id),
    sendNote: sendNoteOf(p, u, sendErr, expired),
    roles: open ? roleCards(u.role, isMe, (r) => p.setRole(u, r)) : [],
    isInvited: invited,
    isActive: u.status === 'active' && !isMe,
    isLocked: u.status === 'locked',
    removeLabel: invited ? m.users_revoke() : m.users_remove(),
    canMfaReset: u.mfa && !isMe && !invited,
    busy: p.busy.has(u.id),
    togSel: () => p.toggleSelect(u.id),
    toggle: () => p.toggleOpen(u.id),
    editMe: ctx.editMe,
    copyLink: () => void p.copyLink(u),
    resend: () => void p.resend(u),
    extend: () => void p.extend(u),
    lock: () => p.lock(u),
    unlock: () => p.unlock(u),
    mfaReset: () => p.resetMfa(u),
    remove: () => p.remove(u),
  };
}

function inviteResult(p: UsersPage): InviteResultValues {
  const r = p.result;
  // Rows disappear after a successful resend, withdrawal or acceptance.
  const open = r
    ? r.ids.map((id) => p.rows.find((u) => u.id === id)).filter((u) => u?.status === 'invited' && !u.mail_sent_at)
    : [];
  const failed = r?.ids.length ?? 0;
  const sent = r ? r.n - failed : 0;
  const one = failed === 1;
  let title = '';
  let text = '';
  if (r?.off) {
    title = r.n === 1 ? m.users_res_created() : m.users_res_created_many({ n: r.n });
    text = one ? m.users_res_off_one() : m.users_res_off_many();
  } else if (r) {
    title = !sent
      ? one
        ? m.users_res_failed()
        : m.users_res_failed_many({ n: failed })
      : m.users_res_partial({
          sent: sent === 1 ? m.users_res_sent_one() : m.users_res_sent_many({ n: sent }),
          unsent: one ? m.users_res_unsent_one() : m.users_res_unsent_many({ n: failed }),
        });
    text = one ? m.users_res_text_one() : m.users_res_text_many();
  }
  return {
    show: open.length > 0,
    off: !!r?.off,
    icon: r?.off ? 'ti-mail-off' : 'ti-alert-triangle',
    title,
    text,
    rows: open.flatMap((u) => (u ? [{ id: u.id, email: u.email, copy: () => void p.copyLink(u) }] : [])),
    close: () => p.closeResult(),
  };
}

function rolePick(p: UsersPage): RolePick {
  const n = p.chosen.length;
  const first = p.chosen[0];
  const common = first && p.chosen.every((u) => u.role === first.role) ? first.role : null;
  const open = ui.menu === 'pick';
  return {
    title: m.users_role_for({ who: people(n) }),
    open,
    toggle: () => {
      if (n === 0) return;
      p.roleHi = null;
      ui.toggleMenu('pick');
    },
    ...pickList({
      opts: ROLES.map((r) => ({ v: r, l: roleLabel(r), sub: roleDesc(r) })),
      cur: common,
      open,
      hi: p.roleHi,
      disabled: n === 0,
      mark: (i) => {
        p.roleHi = i;
      },
      show: () => {
        ui.menu = 'pick';
      },
      hide: () => ui.closeMenu(),
      choose: (role) => p.bulkRole(role),
    }),
  };
}

function sortHead(p: UsersPage, key: SortKey, label: string): SortHead {
  const on = p.sort === key;
  return {
    label,
    aria: m.users_sort_by({ label }),
    on,
    desc: on && p.dir === -1,
    onClick: () => p.sortBy(key),
  };
}

/**
 * Rows of the list, derivable separately from the other values: they
 * do not depend on the form, the search in the field or the open menu.
 */
export function rowsValues(p: UsersPage, ctx: UsersContext, now = Date.now()): UserRow[] {
  return p.list.map((u) => rowValues(p, u, ctx, now));
}

/** Values of the page from the state; `rows` from `rowsValues()` if already derived. */
export function usersValues(
  p: UsersPage,
  ctx: UsersContext,
  now = Date.now(),
  rows: UserRow[] = rowsValues(p, ctx, now),
): UsersValues {
  const form = p.invite;
  const n = p.inviteCount;
  const many = n > 1;
  const noMail = !p.hasMail;
  const err = p.inviteError;
  const nSel = p.chosen.length;
  const all: boolean | 'mixed' = nSel === 0 ? false : nSel === p.pickable.length ? true : 'mixed';
  const q = p.q.trim();
  const counts = (f: UsersFilter) => p.matched.filter((u) => f === 'all' || u.status === f).length;
  return {
    uQ: p.q,
    uHasQ: p.q.length > 0,
    onUQ: (value) => p.setQuery(value),
    clearUQ: () => p.setQuery(''),
    uNoMail: noMail,
    uHasMail: !noMail,
    uNoMailGo: ctx.setupMail,
    inviteOpen: !!form,
    inviteClosed: !form,
    openInvite: () => p.openInvite(),
    invEmail: form?.email ?? '',
    invName: form && !many ? form.name : '',
    invNameDis: many,
    invNamePh: many ? m.users_invite_name_placeholder_many() : m.users_invite_name_placeholder(),
    invNamePhM: many ? m.users_invite_name_placeholder_mobile_many() : m.users_invite_name_placeholder_mobile(),
    invPh: form?.list.length ? '' : m.users_invite_email_placeholder(),
    invChips: (form?.list ?? []).map((e) => {
      const kind = p.chipKind(e);
      return {
        label: e,
        bad: kind !== 'ok',
        tip: kind === 'dup' ? m.users_chip_taken() : kind === 'bad' ? m.users_chip_invalid() : undefined,
        rmLabel: m.users_chip_remove({ email: e }),
        remove: () => p.removeChip(e),
      };
    }),
    invFocus: !!form?.focus,
    invRoles: roleCards(form?.role ?? 'user', false, (r) => p.inviteRole(r)),
    invErr: err,
    hasInvErr: !!err,
    invBtn: { dis: n === 0 || !!err || !!form?.busy },
    invBusy: !!form?.busy,
    invSendLabel: many
      ? noMail
        ? m.users_invite_create_many({ n })
        : m.users_invite_send_many({ n })
      : noMail
        ? m.users_invite_create()
        : m.users_invite_send(),
    invSendShort: many
      ? noMail
        ? m.users_invite_create_short_many({ n })
        : m.users_invite_send_short_many({ n })
      : noMail
        ? m.users_invite_create_short()
        : m.users_invite_send_short(),
    onInvEmail: (value) => p.inviteInput(value),
    onInvName: (value) => p.inviteName(value),
    invKey: (event) => p.inviteKey(event),
    invNameKey: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void p.sendInvites();
      }
    },
    onInvFocus: () => p.inviteFocus(),
    onInvBlur: () => p.inviteBlur(),
    invSend: () => void p.sendInvites(),
    invCancel: () => p.closeInvite(),
    invRes: inviteResult(p),
    uPills: FILTERS.map((f) => ({
      label: f === 'all' ? m.users_filter_all() : statusLabel(f),
      n: counts(f),
      on: p.filter === f,
      onClick: () => p.setFilter(f),
    })),
    uSelOn: nSel > 0,
    uSelOff: nSel === 0,
    uSelText: m.users_sel_count({ n: nSel }),
    uSelClear: () => p.clearSelection(),
    selBulkRole: rolePick(p),
    uBulkCanLock: p.chosen.some((u) => u.status === 'active'),
    uBulkCanUnlock: p.chosen.some((u) => u.status === 'locked'),
    uBulkLock: () => p.bulkLock(),
    uBulkUnlock: () => p.bulkUnlock(),
    uBulkRemove: () => p.bulkRemove(),
    uHasRows: p.list.length > 0,
    uAllCk: {
      on: all,
      label: all === true ? m.users_sel_clear() : m.users_select_all(),
      icon: all === 'mixed' ? 'ti-minus' : 'ti-check',
      vis: p.pickable.length ? 1 : 0.35,
      onClick: () => p.toggleAll(),
    },
    uHdName: sortHead(p, 'name', m.users_head_name()),
    uHdRole: sortHead(p, 'role', m.users_head_role()),
    uHdStatus: sortHead(p, 'status', m.users_head_status()),
    uRows: rows,
    uEmpty: p.list.length === 0,
    uEmptyText: q ? m.users_empty_query({ q }) : m.users_empty(),
    uCanReset: !!q || p.filter !== 'all',
    uReset: () => p.resetFilter(),
  };
}
