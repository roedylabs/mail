/**
 * Administration › Mail servers against the admin API: list from
 * `GET admin/servers` with redirect URI and server of the system mail, policy
 * "Allow custom server URLs" (`admin/servers/policy`), "Test connection"
 * (`POST admin/servers/:id/test`) with a diagnosis per row, removal after
 * confirmation and the dialog for adding and editing with automatic
 * registration of the OAuth client (`POST admin/servers/register-client`,
 * before saving).
 *
 * Removal after confirmation has undo: `DELETE` goes out when the toast
 * expires (`ui.toasts.defer`) or immediately when leaving the page; if it
 * fails, the row returns. Errors show the error toast; diagnosis and
 * registration texts depend on the reason.
 *
 * List and policy stay for the session (`keptServers`): a reopened page shows
 * them at once and loads again in the background; if that fails, they stay
 * with the toast "Couldn’t update the list.".
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { ago } from '#lib/ago.ts';
import { ApiError, api, fieldsOf, isApiError, retryAfter } from '#lib/api.ts';
import { copyText } from '#lib/clipboard.svelte.ts';
import { Countdown } from '#lib/countdown.svelte.ts';
import { credBad } from '#lib/credentials.ts';
import { csp } from '#lib/csp.ts';
import {
  adminRejected,
  diagAction,
  diagColor,
  diagIcon,
  diagText,
  registrationText,
  throttleText,
  type DiagAction,
  type DiagLine,
  type DiagReasons,
  type DiagStatus,
} from '#lib/diagnosis.ts';
import { failText, loadFailText } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import type { KeyInput } from '#lib/keys.ts';
import { m } from '#lib/paraglide/messages.js';
import { overlayClose, type OverlayEvent } from '#lib/shell.ts';
import { onForget } from '#lib/state/forget.ts';
import { Kept } from '#lib/state/kept.ts';
import { session } from '#lib/state/session.svelte.ts';
import { Loading, ui } from '#lib/state/ui.svelte.ts';
import type { DeferredAction } from '#lib/undo.ts';
import { MAX_DOMAINS, domainsOf, hostOf, httpOther, isDomain, localHttp } from '#lib/url.ts';
import { clockText, waitText } from '#lib/wait.ts';

export type { DiagStatus } from '#lib/diagnosis.ts';
export type ListStatus = 'loading' | 'ready' | 'failed';
export type OaMode = 'auto' | 'manual';
/** Sections of the page. */
export type Section = 'list' | 'policy';

/** Entry of `GET admin/servers` (`api::servers::AdminServer`). */
export interface AdminServer {
  id: string;
  label: string;
  /** Base URL, origin only (`https://mail.example.com`). */
  url: string;
  /** Host with port if given. */
  host: string;
  domains: string[];
  client_id: string | null;
  has_secret: boolean;
  reach: DiagStatus;
  cors: DiagStatus;
  oauth: DiagStatus;
  tested_at: string | null;
  /** Linked mail accounts. */
  accounts?: number;
}

/** Response of `GET admin/servers`. */
interface ServerList {
  servers: AdminServer[];
  /** `<public address>/oauth/callback`. */
  redirect_uri: string;
  /** Server the system mails go through. */
  system_mail_server: string | null;
}

/** Errors in the dialog per field; `adm` below the sign-in for the registration. */
interface FormErrors {
  label?: string | undefined;
  url?: string | undefined;
  dom?: string | undefined;
  adm?: string | undefined;
  /** Client ID or secret with control characters or over 1024 bytes. */
  cred?: string | undefined;
}

/** Registration of the OAuth client in the dialog. */
type RegState = 'busy' | 'ok' | 'err' | null;

/** Dialog "Add server" or "Edit server". */
export interface ServerForm {
  /** Counts up per opened dialog: responses only apply to their dialog. */
  seq: number;
  /** Edited server; `null` when adding. */
  id: string | null;
  label: string;
  url: string;
  domains: string[];
  /** Text in the field, not yet a chip. */
  domIn: string;
  oa: OaMode;
  cid: string;
  csec: string;
  showSec: boolean;
  /** Stored client ID; a stored secret belongs only to it. */
  savedCid: string;
  /** Linked mail accounts of the edited server; a new client requires them to sign in again. */
  links: number;
  hasSec: boolean;
  au: string;
  ap: string;
  aSt: RegState;
  aErr: string | null;
  /** Address that was or is being registered for, and the client ID of the registration. */
  regUrl: string;
  regCid: string;
  /** The registration has a secret that the backend takes over on saving (`has_secret`). */
  regSec: boolean;
  err: FormErrors;
  /** Saving running. */
  saving: boolean;
  /** Saving waits for the running registration. */
  saveQueued: boolean;
}

/** Key in a field (`#lib/keys.ts`). */
export type { KeyInput };

/** Address: `https://` with a dot in the host; the scheme in any case like the backend. */
const HTTPS = /^https:\/\/[^\s/]+\.[^\s/]+/i;
const SEP = /[\s,;]+/;

/** Maximum length of the label like in the backend (`MAX_LABEL`, also in the setup). */
export const MAX_LABEL = 100;

/** Fixed green for "OK". */
const OK_COLOR = diagColor('ok');

/** Address from the field: without whitespace and trailing `/`. */
const trimUrl = (url: string) => url.trim().replace(/\/+$/, '');

/** Append domains: lower case, without a leading `@`, duplicates only once. */
function addDomains(list: readonly string[], raw: string): string[] {
  const out = [...list];
  for (const d of domainsOf(raw)) if (!out.includes(d)) out.push(d);
  return out;
}

/** Error of the address when saving or registering (`empty` is the text without an address). */
function urlError(url: string, empty: string): string | undefined {
  if (httpOther(url)) return m.server_http_other();
  if (!HTTPS.test(url) && !localHttp(url)) return empty;
  return undefined;
}

/** List and policy of the last open page of the session. */
export interface KeptServers {
  rows: AdminServer[];
  redirectUri: string | null;
  systemServer: string | null;
  allowOwn: boolean;
}

export const keptServers = new Kept<KeptServers>();

/** Toggles of the policy of every page, one after the other: a load of a reopened page also asks only after them. */
let policyWrites: Promise<unknown> = Promise.resolve();
/** Counts sign-outs: a toggle queued before one is not sent any more (it would go out with the next session). */
let policyEpoch = 0;
onForget(() => {
  policyEpoch++;
  policyWrites = Promise.resolve();
});

export class ServersPage {
  rows = $state<AdminServer[]>([]);
  status = $state<ListStatus>('loading');
  /** Reason the first load failed (text of the card). */
  failure = $state('');
  /** Skeleton only after the skeleton delay. */
  readonly loading = new Loading();
  redirectUri = $state<string | null>(null);
  systemServer = $state<string | null>(null);
  /** "Users can enter their own server URLs". */
  allowOwn = $state(false);
  /** Server whose test is running; only one at a time. */
  testing = $state<string | null>(null);
  /** Expanded diagnoses. */
  readonly diag = new SvelteSet<string>();
  /** Reasons of the last test per server (only from the response of "Test connection"). */
  readonly reasons = new SvelteMap<string, DiagReasons>();
  /** Lock of "Register client automatically" after 429 from Roedy or `throttled` from Stalwart. */
  readonly regLock = new Countdown<'reg'>();
  /** Remaining lock time in seconds; changes only once per second (not on every clock tick). */
  regLeft = $derived(this.regLock.left('reg'));
  /**
   * Address of the server that throttles the registration (`throttled`, box
   * "Too many requests."); the lock then applies only to it. `null`: lock by
   * Roedy ("Too many attempts.", for all servers).
   */
  regThrottled = $state<string | null>(null);
  /** Wait time after a throttled test per server (`retry_after`); only for the diagnosis text. */
  readonly testWait = new Countdown<string>();
  /** Seconds tick for it: the countdown clock ticks every 250 ms, the diagnosis needs only whole seconds. */
  #testSec = $derived(Math.floor(this.testWait.now / 1000));
  dialog = $state<ServerForm | null>(null);

  /** Redirect URI for Stalwart; until the list is loaded that of this browser. */
  redirect = $derived(this.redirectUri ?? `${location.origin}/oauth/callback`);
  /** Host of the app for which the diagnosis checks CORS. */
  appHost = $derived(hostOf(this.redirect));

  #seq = 0;
  #formSeq = 0;
  #regSeq = 0;
  /** Servers whose removal the server has not confirmed yet: keep them out of reloaded lists. */
  #removing: string[] = [];
  /** Their rows, as long as the removal may yet fail (kept list). */
  #removingRows: AdminServer[] = [];
  /** Last list from the server, unfiltered, and how many arrived (undo of a removal uses the newest). */
  #lastList: AdminServer[] = [];
  #lists = 0;
  /** "Allow custom server URLs" as the server knows it (kept list; a toggle may yet fail). */
  #ownKnown = false;
  /** Local changes per server; a test result only applies without newer ones. */
  #edits: Record<string, number> = {};
  /** Stored servers that are tested after the running test. */
  #queue: string[] = [];
  #policySeq = 0;
  #disposed = false;
  /** Last removal with undo: leaving the page sends it immediately. */
  #final: DeferredAction | null = null;
  /** Reopened with the kept list: the next load reports a failure only as "Couldn’t update the list.". */
  #reopened = false;
  readonly #keep = keptServers.keeper();

  constructor() {
    const kept = keptServers.value;
    if (!kept) return;
    this.rows = kept.rows;
    this.redirectUri = kept.redirectUri;
    this.systemServer = kept.systemServer;
    this.allowOwn = this.#ownKnown = kept.allowOwn;
    this.status = 'ready';
    this.#reopened = true;
  }

  /** Loads list and policy; after the first load the list stays as it is on an error. */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    const policySeq = this.#policySeq;
    let changes = keptServers.changes;
    const reopened = this.#reopened;
    this.#reopened = false;
    try {
      const res = await this.loading.run(
        // After a removal of a left page still on its way: otherwise the response could still contain the server.
        keptServers.after(
          this,
          () => {
            // Superseded or left while waiting: no request any more.
            if (seq !== this.#seq || this.#disposed) return Promise.resolve(null);
            changes = keptServers.changes;
            return Promise.all([
              api<ServerList>('GET', 'admin/servers'),
              // After toggles still on their way: otherwise the response could be older than a confirmed one.
              policyWrites
                .catch(() => {})
                .then(() => api<{ allow_custom_servers: boolean }>('GET', 'admin/servers/policy')),
            ]);
          },
          // The wait ran out: once the removal is through after all, load again.
          () => {
            if (!this.#disposed) void this.load();
          },
        ),
      );
      if (!res || seq !== this.#seq || this.#disposed) return;
      const [list, policy] = res;
      // Added, saved, tested or removed in the meantime: the list is older, so reload.
      if (changes !== keptServers.changes) {
        this.#reopened = reopened;
        void this.load();
        return;
      }
      // Reasons only apply to the test they come from (another one may have retested in the meantime).
      for (const id of [...this.reasons.keys()]) {
        const now = list.servers.find((r) => r.id === id);
        if (!now || now.tested_at !== this.rows.find((r) => r.id === id)?.tested_at) this.reasons.delete(id);
      }
      this.#lastList = list.servers;
      this.#lists++;
      this.rows = list.servers.filter((s) => !this.#removing.includes(s.id));
      this.redirectUri = list.redirect_uri;
      this.systemServer = list.system_mail_server;
      // A toggle during loading applies, not the older state.
      if (policySeq === this.#policySeq) this.allowOwn = this.#ownKnown = policy.allow_custom_servers;
      this.status = 'ready';
      const ids = list.servers.map((s) => s.id);
      for (const id of this.diag) if (!ids.includes(id)) this.diag.delete(id);
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

  /** "Try again" of the card: skeleton again until the response. */
  async retry(): Promise<void> {
    this.status = 'loading';
    await this.load();
  }

  /**
   * Leave the page: keep list and policy as the server knows them (servers
   * whose removal may yet fail stay in it); late responses change nothing any
   * more. A removal still waiting in the toast goes out immediately; the toast
   * closes with its undo.
   */
  dispose(): void {
    if (this.status === 'ready' && !this.#disposed) {
      const { redirectUri, systemServer } = this;
      const ids = this.rows.map((s) => s.id);
      const rows = [...$state.snapshot(this.rows), ...this.#removingRows.filter((s) => !ids.includes(s.id))];
      this.#keep({ rows, redirectUri, systemServer, allowOwn: this.#ownKnown });
    }
    this.#disposed = true;
    this.#regSeq++;
    this.regLock.stop();
    this.testWait.stop();
    // With `keepalive`: the tab may be closed right after.
    if (ui.toasts.waiting(this.#final)) void ui.toasts.flush(true);
    this.#final = null;
  }

  /** Remaining time after a throttled test in seconds; changes at most once per second. */
  testLeft(id: string): number {
    const end = this.testWait.until(id);
    return end === null ? 0 : Math.max(0, Math.ceil((end - this.#testSec * 1000) / 1000));
  }

  /** Whether the registration is locked for this address: lock by Roedy or throttling by exactly this server. */
  #regBlocked(url: string): boolean {
    return this.regLock.active('reg') && (this.regThrottled === null || this.regThrottled === url);
  }

  /**
   * Error toast, reload the list; without a session or role reload the account.
   * After leaving the page nothing, except for `late` the error toast (a removal sent when leaving).
   */
  #failed(error: unknown, late = false): void {
    if (this.#disposed && !late) return;
    ui.toasts.error(failText(error));
    if (this.#disposed) return;
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      void session.refreshUser().catch(() => {});
      return;
    }
    void this.load();
  }

  /** Take over a server from a response (add, edit, test). */
  #put(server: AdminServer): void {
    const known = this.rows.some((s) => s.id === server.id);
    this.rows = known ? this.rows.map((s) => (s.id === server.id ? server : s)) : [...this.rows, server];
  }

  #edited(id: string): number {
    // The reasons of the last test no longer apply to the changed details.
    this.reasons.delete(id);
    const n = (this.#edits[id] ?? 0) + 1;
    this.#edits[id] = n;
    return n;
  }

  // List

  toggleDiag(id: string): void {
    if (this.diag.has(id)) this.diag.delete(id);
    else this.diag.add(id);
  }

  /**
   * "Test connection": expands the diagnosis, result as a toast. Only one
   * test runs at a time; after saving (`queue`) the test follows after a
   * running one.
   */
  async test(id: string, queue = false): Promise<void> {
    if (!this.rows.some((s) => s.id === id)) return;
    if (this.testing) {
      if (queue && !this.#queue.includes(id)) this.#queue.push(id);
      return;
    }
    const wasOpen = this.diag.has(id);
    this.testing = id;
    this.diag.add(id);
    const stamp = this.#edits[id] ?? 0;
    try {
      const { server, reasons, retry_after } = await api<{
        server: AdminServer;
        reasons?: DiagReasons;
        retry_after?: number;
      }>('POST', `admin/servers/${id}/test`);
      // Also for a page already left: a reopened page's load may be older.
      keptServers.changed();
      if (this.#disposed) return;
      // Saved or removed in the meantime: the response may be older than the state of the list.
      if ((this.#edits[id] ?? 0) !== stamp || !this.rows.some((s) => s.id === id)) return;
      this.#put(server);
      this.reasons.set(id, reasons ?? {});
      if (retry_after) this.testWait.start(id, retry_after);
      else this.testWait.clear(id);
      // Throttled means unchecked: not "OK".
      const bad =
        [server.reach, server.cors, server.oauth].includes('err') || Object.values(reasons ?? {}).includes('throttled');
      ui.toasts.show(bad ? m.server_test_warn({ label: server.label }) : m.server_test_ok({ label: server.label }));
    } catch (error) {
      // Without a result back to the state before the test: open diagnostics stay open,
      // closed ones close again (a server never tested has no toggle to open them).
      if (!wasOpen) this.diag.delete(id);
      this.#failed(error);
    } finally {
      if (this.testing === id) this.testing = null;
      const next = this.#queue.shift();
      if (next !== undefined && !this.#disposed) void this.test(next);
    }
  }

  /** "Remove" with confirmation; then with undo. */
  remove(server: AdminServer): void {
    const n = server.accounts ?? 0;
    const sys = server.id === this.systemServer;
    const linked = n === 0 ? m.server_remove_none() : n === 1 ? m.server_remove_one() : m.server_remove_many({ n });
    ui.ask({
      title: m.server_remove_title({ label: server.label }),
      text: sys ? `${linked} ${m.server_remove_system()}` : linked,
      icon: 'ti-server-off',
      ok: m.server_remove(),
      danger: true,
      run: () => {
        const before = this.rows;
        // The row as it is now (a reload may have changed it since the dialog opened); gone already: nothing to bring back.
        const shown = before.find((s) => s.id === server.id) ?? null;
        keptServers.changed();
        this.#removing.push(server.id);
        if (shown) this.#removingRows.push(shown);
        this.rows = before.filter((s) => s.id !== server.id);
        this.diag.delete(server.id);
        this.#edited(server.id);
        const alive = keptServers.alive();
        const lists = this.#lists;
        const action: DeferredAction = {
          text: m.server_removed({ label: (shown ?? server).label }),
          // After "Undo" or a failed call: back at its place.
          revert: () => {
            this.#removing = this.#removing.filter((x) => x !== server.id);
            this.#removingRows = this.#removingRows.filter((s) => s.id !== server.id);
            keptServers.changed();
            // A newer list decides: its row at its place, or nothing if the server is gone meanwhile.
            const base = lists === this.#lists ? before : this.#lastList;
            const at = base.findIndex((s) => s.id === server.id);
            const row = base[at];
            if (!shown || !row || this.rows.some((s) => s.id === server.id)) return;
            const after = base.slice(at + 1).map((s) => s.id);
            const next = this.rows.findIndex((s) => after.includes(s.id));
            const rows = [...this.rows];
            rows.splice(next < 0 ? rows.length : next, 0, row);
            this.rows = rows;
          },
          commit: async (keepalive) => {
            try {
              const sending = api('DELETE', `admin/servers/${server.id}`, undefined, { keepalive });
              // Also if the page is left meanwhile: a reopened one loads only after it.
              keptServers.track(sending, this);
              await sending;
            } catch (error) {
              // Already gone (e.g. removed by another person): treat as removed.
              if (!isApiError(error, 404)) throw error;
            }
            this.#removed(server.id);
          },
          onError: (error) => {
            // Errors of an earlier session (signed out meanwhile) are no longer reported.
            if (alive()) this.#failed(error, true);
          },
        };
        this.#final = action;
        ui.toasts.defer(action);
        // Confirmed only after leaving the page (the dialog stays open): send right away.
        if (this.#disposed) void ui.toasts.flush(true);
      },
    });
  }

  /** Removal confirmed; the system mail server as it is now (it may have changed while the toast ran). */
  #removed(id: string): void {
    keptServers.changed();
    this.#removing = this.#removing.filter((x) => x !== id);
    this.#removingRows = this.#removingRows.filter((s) => s.id !== id);
    if (this.systemServer === id) {
      this.systemServer = null;
      // System mail without a server: banner and notice of the users page follow from `auth/me`.
      void session.refreshUser().catch(() => {});
    }
  }

  /** "Users can enter their own server URLs": immediately, without undo. */
  toggleOwn(): void {
    const on = !this.allowOwn;
    this.allowOwn = on;
    const seq = ++this.#policySeq;
    const epoch = policyEpoch;
    ui.toasts.show(on ? m.server_own_allowed() : m.server_own_blocked());
    // Only once switched on does the CSP allow more; already before the response in case of an immediate navigation.
    if (on) csp.stale = true;
    // One after the other so that the last chosen state also arrives last.
    policyWrites = policyWrites
      .catch(() => {})
      .then(async () => {
        if (epoch !== policyEpoch) return;
        await api('PUT', 'admin/servers/policy', { allow_custom_servers: on });
        this.#ownKnown = on;
      })
      .catch((error: unknown) => {
        if (seq !== this.#policySeq) return;
        this.allowOwn = !on;
        this.#failed(error);
      });
  }

  async copyRedirect(): Promise<void> {
    if (await copyText(this.redirect)) ui.toasts.show(m.server_redirect_copied());
    else ui.toasts.error(m.error_copy_uri());
  }

  // Dialog

  /** Open the dialog: new or for a server, optionally with the kind of OAuth client. */
  openDialog(server: AdminServer | null = null, oa?: OaMode): void {
    this.#regSeq++;
    const cid = server?.client_id ?? '';
    this.dialog = {
      seq: ++this.#formSeq,
      id: server?.id ?? null,
      label: server?.label ?? '',
      url: server?.url ?? 'https://',
      domains: [...(server?.domains ?? [])],
      domIn: '',
      oa: oa ?? (cid ? 'manual' : 'auto'),
      cid,
      csec: '',
      showSec: false,
      savedCid: cid,
      links: server?.accounts ?? 0,
      hasSec: !!server?.has_secret,
      au: '',
      ap: '',
      aSt: null,
      aErr: null,
      regUrl: '',
      regCid: '',
      regSec: false,
      err: {},
      saving: false,
      saveQueued: false,
    };
    ui.closeMenu();
    ui.toasts.dismiss();
  }

  closeDialog(): void {
    this.#regSeq++;
    this.dialog = null;
  }

  #set(patch: Partial<ServerForm>): void {
    if (this.dialog) this.dialog = { ...this.dialog, ...patch };
  }

  #setErr(err: FormErrors): void {
    if (this.dialog) this.#set({ err: { ...this.dialog.err, ...err } });
  }

  setLabel(value: string): void {
    this.#set({ label: value });
    this.#setErr({ label: undefined });
  }

  /**
   * Change the address. A registered client belongs to its server: if the
   * address changes afterwards, the stored client ID applies again (like in
   * the setup) – unless it was changed by hand in the meantime; a running
   * registration is discarded.
   */
  setUrl(value: string): void {
    const d = this.dialog;
    if (!d) return;
    this.#set({ url: value });
    this.#setErr({ url: undefined });
    if (trimUrl(value) === d.regUrl) return;
    if (d.aSt === 'busy') {
      this.#regSeq++;
      this.#set({ aSt: null, aErr: null, saveQueued: false });
    } else if (d.aSt === 'ok') {
      this.#set({ aSt: null, aErr: null, ...(d.cid === d.regCid ? { cid: d.savedCid } : {}) });
    }
  }

  /** Input in the domains field: separators make chips. */
  domainInput(value: string): void {
    const d = this.dialog;
    if (!d) return;
    if (!SEP.test(value)) {
      this.#set({ domIn: value });
    } else {
      const parts = value.split(SEP);
      const last = /[,;\s]$/.test(value) ? '' : (parts.pop() ?? '');
      this.#set({ domains: addDomains(d.domains, parts.join(' ')), domIn: last });
    }
    this.#setErr({ dom: undefined });
  }

  /** Enter takes over, backspace in the empty field removes the last domain. */
  domainKey(event: KeyInput): void {
    const d = this.dialog;
    if (!d) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      this.#set({ domains: addDomains(d.domains, d.domIn), domIn: '' });
    } else if (event.key === 'Backspace' && !d.domIn && d.domains.length) {
      this.#set({ domains: d.domains.slice(0, -1) });
    }
  }

  domainBlur(): void {
    const d = this.dialog;
    if (d?.domIn) this.#set({ domains: addDomains(d.domains, d.domIn), domIn: '' });
  }

  /** Remove a domain; a message about the domains no longer applies afterwards. */
  removeDomain(domain: string): void {
    const d = this.dialog;
    if (!d) return;
    this.#set({ domains: d.domains.filter((x) => x !== domain) });
    this.#setErr({ dom: undefined });
  }

  setOa(oa: OaMode): void {
    this.#set({ oa });
  }

  setAdminUser(value: string): void {
    this.#set({ au: value, aErr: null });
    this.#setErr({ adm: undefined });
  }

  setAdminPassword(value: string): void {
    this.#set({ ap: value, aErr: null });
    this.#setErr({ adm: undefined });
  }

  setCid(value: string): void {
    this.#set({ cid: value });
    this.#setErr({ cred: undefined });
  }

  setSecret(value: string): void {
    this.#set({ csec: value });
    this.#setErr({ cred: undefined });
  }

  toggleSecret(): void {
    if (this.dialog) this.#set({ showSec: !this.dialog.showSec });
  }

  /**
   * "Register again": back to the sign-in. Until the next registration the
   * stored client ID applies (saving would otherwise remove a working
   * client).
   */
  registerAgain(): void {
    this.#regSeq++;
    if (this.dialog) this.#set({ aSt: null, aErr: null, cid: this.dialog.savedCid });
  }

  /**
   * "Register client automatically": confidential client via DCR before
   * saving. The backend keeps the secret until the server is saved with this
   * client ID; the dialog sends nothing for it.
   */
  async register(): Promise<void> {
    const d = this.dialog;
    if (!d || d.aSt === 'busy') return;
    const url = trimUrl(d.url);
    if (this.#regBlocked(url)) return;
    const err: FormErrors = {};
    const bad = urlError(d.url.trim(), m.server_err_url_first());
    if (bad) err.url = bad;
    if (!d.au.trim() || !d.ap) err.adm = m.server_err_admin();
    if (err.url || err.adm) {
      this.#setErr(err);
      return;
    }
    // A still running lock then belongs to the throttling of another server.
    this.regLock.clear('reg');
    const req = ++this.#regSeq;
    this.#set({ aSt: 'busy', aErr: null, regUrl: url });
    this.#setErr({ adm: undefined, url: undefined });
    try {
      const res = await api<{ client_id: string; has_secret?: boolean }>('POST', 'admin/servers/register-client', {
        url,
        username: d.au.trim(),
        password: d.ap,
      });
      if (req !== this.#regSeq || this.#disposed) return;
      // A stored secret belongs to the old client ID; the backend holds the new one ready.
      this.#set({
        aSt: 'ok',
        cid: res.client_id,
        regCid: res.client_id,
        regSec: res.has_secret === true,
        csec: '',
        au: '',
        ap: '',
      });
      if (this.dialog?.saveQueued) {
        this.#set({ saveQueued: false });
        void this.save();
      }
    } catch (error) {
      if (req !== this.#regSeq || this.#disposed) return;
      this.#set({ saveQueued: false });
      this.#registerFailed(error);
    }
  }

  /**
   * Errors of the registration per reason like in the setup; 429 from Roedy as
   * box "Too many attempts." (`aLocked`), `throttled` from Stalwart with wait
   * time as box "Too many requests." (`aThr`), both with a running wait time.
   */
  #registerFailed(error: unknown): void {
    if (error instanceof ApiError && error.code === 'registration_failed') {
      const reason = typeof error.body.reason === 'string' ? error.body.reason : null;
      const detail = typeof error.body.detail === 'string' ? error.body.detail : null;
      const wait = error.body.retry_after;
      if (reason === 'throttled' && typeof wait === 'number' && wait > 0) {
        this.#set({ aSt: 'err', aErr: null });
        this.regThrottled = this.dialog?.regUrl ?? null;
        this.regLock.start('reg', wait);
        return;
      }
      this.#set({
        aSt: 'err',
        aErr: registrationText(reason, detail, session.appName),
        ...(adminRejected(reason) ? { ap: '' } : {}),
      });
    } else if (isApiError(error, 429)) {
      this.#set({ aSt: 'err', aErr: null });
      this.regThrottled = null;
      this.regLock.start('reg', retryAfter(error));
    } else if (isApiError(error, 422, 'invalid') && this.dialog) {
      const fields = fieldsOf(error);
      this.#set({ aSt: null });
      if (fields.url) this.#setErr({ url: urlError(this.dialog.url.trim(), m.server_err_url()) ?? m.server_err_url() });
      if (fields.username || fields.password) this.#setErr({ adm: m.server_err_admin() });
    } else {
      this.#set({ aSt: null });
      this.#failed(error);
    }
  }

  /** Enter in label or address saves. */
  dialogKey(event: KeyInput): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void this.save();
  }

  /**
   * "Add and test" or "Save and test": checks the fields (duplicate addresses
   * only of the server), saves and tests afterwards. A secret is only sent if it is entered for a client
   * ID in manual mode; empty keeps the stored one (with the same client ID).
   */
  async save(): Promise<void> {
    const d = this.dialog;
    if (!d || d.saving) return;
    // During the registration the client ID is not fixed yet: save afterwards.
    if (d.aSt === 'busy') {
      this.#set({ saveQueued: true });
      return;
    }
    const domains = addDomains(d.domains, d.domIn);
    const url = trimUrl(d.url);
    const others = this.rows.filter((s) => s.id !== d.id);
    const err: FormErrors = {};
    if (!d.label.trim()) err.label = m.server_err_label();
    const badUrl = urlError(url, m.server_err_url());
    if (badUrl) err.url = badUrl;
    const bad = domains.find((x) => !isDomain(x));
    const taken = domains.map((x) => [x, others.find((s) => s.domains.includes(x))] as const).find(([, s]) => s);
    // One message at a time: an invalid domain first, then one already assigned, last the number.
    if (bad) err.dom = m.server_err_domain({ domain: bad });
    else if (taken?.[1]) err.dom = m.server_err_domain_taken({ domain: taken[0], server: taken[1].label });
    else if (domains.length > MAX_DOMAINS) err.dom = m.server_doms_max({ n: MAX_DOMAINS });
    if (credBad(d.cid.trim())) err.cred = m.server_cid_bad();
    else if (d.oa === 'manual' && credBad(d.csec.trim())) err.cred = m.server_secret_bad();
    if (err.label || err.url || err.dom || err.cred) {
      this.#set({ err, domains, domIn: '' });
      return;
    }
    const cid = d.cid.trim();
    const secret = d.oa === 'manual' && cid ? d.csec.trim() : '';
    const body = {
      label: d.label.trim(),
      url,
      domains,
      ...(d.id ? { client_id: cid || null } : cid ? { client_id: cid } : {}),
      ...(secret ? { client_secret: secret } : {}),
    };
    this.#set({ saving: true, domains, domIn: '', err: {} });
    // New server or new address: the CSP of this tab does not know it (already before the response in case of an immediate navigation).
    if (!d.id || this.rows.find((s) => s.id === d.id)?.url !== url) csp.stale = true;
    const current = () => this.dialog?.seq === d.seq;
    try {
      const server = d.id
        ? await api<AdminServer>('PATCH', `admin/servers/${d.id}`, body)
        : await api<AdminServer>('POST', 'admin/servers', body);
      // Also for a page already left: a reopened page's load may be older.
      keptServers.changed();
      if (this.#disposed) return;
      this.#edited(server.id);
      this.#put(server);
      if (current()) this.dialog = null;
      // Test right afterwards (if a test is running, after it); the diagnosis no longer applies after a new address or client ID.
      void this.test(server.id, true);
    } catch (error) {
      if (this.#disposed) return;
      if (!current()) {
        this.#failed(error);
        return;
      }
      this.#set({ saving: false });
      this.#saveFailed(error, url);
    }
  }

  /** Field errors of the server; what it does not know as a toast. */
  #saveFailed(error: unknown, url: string): void {
    if (isApiError(error, 404)) {
      // Removed in the meantime.
      this.closeDialog();
      this.#failed(error);
      return;
    }
    if (!isApiError(error, 422, 'invalid')) {
      this.#failed(error);
      return;
    }
    const fields = fieldsOf(error);
    const err: FormErrors = {};
    if (fields.label?.code === 'required') err.label = m.server_err_label();
    const u = fields.url;
    if (u)
      err.url = u.code === 'taken' ? m.server_err_taken() : (urlError(url, m.server_err_url()) ?? m.server_err_url());
    const dom = fields.domains;
    const domain = typeof dom?.domain === 'string' ? dom.domain : '';
    if (dom?.code === 'taken' && domain) {
      err.dom = m.server_err_domain_taken({ domain, server: typeof dom.server === 'string' ? dom.server : '' });
    } else if (dom?.code === 'invalid' && domain) {
      err.dom = m.server_err_domain({ domain });
    } else if (dom?.code === 'too_many') {
      err.dom = m.server_doms_max({ n: MAX_DOMAINS });
    }
    if (fields.client_id?.code === 'redirect_mismatch') {
      // Public address changed after the registration: "Automatic" back to the
      // sign-in, "Manual" keeps the input with the error at the client ID field.
      if (this.dialog?.oa === 'auto') {
        this.#regSeq++;
        this.#set({ aSt: null, cid: this.dialog.savedCid, aErr: m.reg_redirect_mismatch({ app: session.appName }) });
      } else {
        const uri = fields.client_id.redirect_uri;
        err.cred = m.reg_redirect_mismatch_manual({ uri: typeof uri === 'string' ? uri : '' });
      }
    } else if (fields.client_id) err.cred = m.server_cid_bad();
    else if (fields.client_secret) err.cred = m.server_secret_bad();
    // Fields with text in the dialog; client ID and secret share one message.
    const shown = ['url', 'client_id', 'client_secret'];
    if (err.label) shown.push('label');
    if (err.dom) shown.push('domains');
    // Otherwise a field for which the dialog has no text.
    if (Object.keys(fields).some((f) => !shown.includes(f))) ui.toasts.error(m.error_act());
    if (Object.keys(err).length) this.#set({ err });
  }
}

// Values of the page

export interface ServerChip {
  label: string;
  status: DiagStatus;
  icon: IconName;
  /** Colour of the icon and the text (`ic`, `ink`). */
  ic: string;
  ink: string;
  aria: string;
  tip: string;
}

export interface DiagRowValues {
  label: string;
  sub: string;
  sep: boolean;
  icon: IconName;
  ic: string;
  text: string;
  isErr: boolean;
  actLabel: string;
  act: () => void;
}

export interface ServerRow {
  id: string;
  label: string;
  host: string;
  url: string;
  sep: boolean;
  doms: { d: string }[];
  noDoms: boolean;
  accts: string;
  isSys: boolean;
  plain: boolean;
  chips: ServerChip[];
  tested: string;
  /** With notices: tile red and rotated. */
  warn: boolean;
  /** Test of this server running. */
  busy: boolean;
  testLabel: string;
  diagOpen: boolean;
  diagBusy: boolean;
  diagDone: boolean;
  diagRows: DiagRowValues[];
  diagLabel: string;
  canDiag: boolean;
  test: () => void;
  edit: () => void;
  remove: () => void;
  diagToggle: () => void;
}

export interface ServersValues {
  srvTabs: { label: string; onClick: () => void }[];
  srvHas: boolean;
  srvEmpty: boolean;
  srvAdd: () => void;
  srvSum: string;
  srvRows: ServerRow[];
  tgSrvOwn: { on: boolean; onClick: () => void };
  srvOwnSum: string;
  srvRedirect: string;
  srvCopyRedirect: () => void;
}

export interface ServersContext {
  /** Scroll to the section. */
  scrollTo: (section: Section) => void;
}

const STATUS: Record<DiagStatus, { icon: IconName; ic: string; ink: string; text: () => string }> = {
  ok: { icon: 'ti-check', ic: OK_COLOR, ink: 'var(--fg)', text: m.server_status_ok },
  err: { icon: 'ti-x', ic: 'var(--danger)', ink: 'var(--danger)', text: m.server_status_err },
  unk: { icon: 'ti-question-mark', ic: 'var(--mfg)', ink: 'var(--mfg)', text: m.server_status_unk },
};

function chip(label: string, status: DiagStatus): ServerChip {
  const s = STATUS[status];
  const text = s.text();
  return {
    label,
    status,
    icon: s.icon,
    ic: s.ic,
    ink: s.ink,
    aria: m.server_chip_aria({ label, status: text }),
    tip: text.charAt(0).toUpperCase() + text.slice(1),
  };
}

/** Rows of the diagnosis, texts per reason. */
function diagRows(p: ServersPage, s: AdminServer): DiagRowValues[] {
  const reasons = p.reasons.get(s.id);
  const ctx = { origin: p.appHost, redirect: p.redirect, app: session.appName, wait: p.testLeft(s.id) };
  const actions: Record<DiagAction, [string, () => void]> = {
    edit: [m.server_diag_edit(), () => p.openDialog(s)],
    test: [m.server_diag_retest(), () => void p.test(s.id)],
    register: [m.server_diag_register(), () => p.openDialog(s, 'auto')],
  };
  const action = (line: DiagLine) => actions[diagAction(line, reasons?.[line])];
  const rows: [DiagLine, string, string, DiagStatus, string, () => void][] = [
    [
      'reach',
      m.server_diag_jmap(),
      m.server_diag_jmap_sub({ url: s.url.replace(/\/+$/, '') }),
      s.reach,
      ...action('reach'),
    ],
    ['cors', m.server_diag_cors(), m.server_diag_cors_sub({ host: p.appHost }), s.cors, ...action('cors')],
    [
      'oauth',
      m.server_diag_oauth(),
      s.client_id ? m.server_diag_cid({ cid: s.client_id }) : m.server_diag_no_cid(),
      s.oauth,
      ...action('oauth'),
    ],
  ];
  return rows.map(([line, label, sub, st, actLabel, act], i) => ({
    label,
    sub,
    sep: i > 0,
    icon: diagIcon(st),
    ic: diagColor(st),
    text: diagText(line, st, s.reach, reasons, ctx),
    isErr: st === 'err',
    actLabel,
    act,
  }));
}

const hasWarning = (s: AdminServer) => [s.reach, s.cors, s.oauth].includes('err');

function rowValues(p: ServersPage, s: AdminServer, i: number, now: number): ServerRow {
  const n = s.accounts ?? 0;
  const busy = p.testing === s.id;
  const open = p.diag.has(s.id);
  const testedAt = s.tested_at ? Date.parse(s.tested_at) : NaN;
  return {
    id: s.id,
    label: s.label,
    host: s.host,
    url: s.url,
    sep: i > 0,
    doms: s.domains.map((d) => ({ d })),
    noDoms: s.domains.length === 0,
    accts: n === 0 ? m.server_accounts_none() : n === 1 ? m.server_accounts_one() : m.server_accounts_many({ n }),
    isSys: s.id === p.systemServer,
    plain: localHttp(s.url),
    chips: [
      chip(m.server_chip_reach(), s.reach),
      chip(m.server_chip_cors(), s.cors),
      chip(m.server_chip_oauth(), s.oauth),
    ],
    tested: busy
      ? m.server_testing()
      : Number.isNaN(testedAt)
        ? m.server_untested()
        : m.server_tested({ ago: ago(testedAt, now) }),
    warn: hasWarning(s),
    busy,
    testLabel: busy ? m.server_test_busy() : m.server_test(),
    diagOpen: open,
    diagBusy: open && busy,
    diagDone: open && !busy,
    diagRows: open && !busy ? diagRows(p, s) : [],
    diagLabel: open ? m.server_diag_hide() : m.server_diag_show(),
    canDiag: !!s.tested_at,
    test: () => void p.test(s.id),
    edit: () => p.openDialog(s),
    remove: () => p.remove(s),
    diagToggle: () => p.toggleDiag(s.id),
  };
}

/** Values of the page from the state. */
export function serversValues(p: ServersPage, ctx: ServersContext, now = Date.now()): ServersValues {
  const n = p.rows.length;
  const warn = p.rows.filter(hasWarning).length;
  const sum = n === 1 ? m.server_sum_one() : m.server_sum_many({ n });
  return {
    srvTabs: [
      { label: m.server_tab_list(), onClick: () => ctx.scrollTo('list') },
      { label: m.server_tab_policy(), onClick: () => ctx.scrollTo('policy') },
    ],
    srvHas: n > 0,
    srvEmpty: n === 0,
    srvAdd: () => p.openDialog(),
    srvSum: warn ? m.server_sum_warn({ sum, n: warn }) : sum,
    srvRows: p.rows.map((s, i) => rowValues(p, s, i, now)),
    tgSrvOwn: { on: p.allowOwn, onClick: () => p.toggleOwn() },
    srvOwnSum: p.allowOwn ? m.server_own_on() : m.server_own_off(),
    srvRedirect: p.redirect,
    srvCopyRedirect: () => void p.copyRedirect(),
  };
}

// Values of the dialog

export interface OaOption {
  label: string;
  on: boolean;
  /** Shadow of the selected option (`shadow`). */
  shadow: string;
  onClick: () => void;
}

export interface ServerDialogValues {
  title: string;
  sub: string;
  btn: string;
  icon: IconName;
  label: string;
  url: string;
  domIn: string;
  domPh: string;
  doms: { d: string; rmLabel: string; rm: () => void }[];
  eLabel: string;
  hasELabel: boolean;
  eUrl: string;
  hasEUrl: boolean;
  plain: boolean;
  eDom: string;
  hasEDom: boolean;
  eAdm: string;
  hasECred: boolean;
  eCred: string;
  /** 429 from Roedy during registration: box "Too many attempts.", button disabled with countdown. */
  aLocked: boolean;
  aLockText: string;
  /** `throttled` from Stalwart: box "Too many requests." (ti-clock), button disabled with countdown. */
  aThr: boolean;
  aThrText: string;
  /** "Edit server" with linked accounts: notice before "Register client automatically". */
  hasLinkHint: boolean;
  linkHint: string;
  /** The same under "Manual" as soon as the client ID differs from the stored one. */
  hasCidHint: boolean;
  cidHint: string;
  regDis: boolean;
  hasEAdm: boolean;
  oaOpts: OaOption[];
  isAuto: boolean;
  isManual: boolean;
  aOk: boolean;
  aNotOk: boolean;
  /** Registration running. */
  aBusy: boolean;
  au: string;
  ap: string;
  regLabel: string;
  regIcon: IconName;
  cidNote: string;
  cid: string;
  csec: string;
  secPh: string;
  /** The client ID of the registration is in the field: notice without the addition about the redirect URI. */
  secReg: boolean;
  /** Secret visible. */
  showSec: boolean;
  secIcon: IconName;
  secTip: string;
  redirect: string;
  /** Saving running. */
  saving: boolean;
  onLabel: (value: string) => void;
  onUrl: (value: string) => void;
  onDomIn: (value: string) => void;
  domKey: (event: KeyInput) => void;
  domBlur: () => void;
  onAu: (value: string) => void;
  onAp: (value: string) => void;
  reg: () => void;
  regAgain: () => void;
  onCid: (value: string) => void;
  onCsec: (value: string) => void;
  onSecEye: () => void;
  copyRedirect: () => void;
  save: () => void;
  close: () => void;
  /** Click on the backdrop, not on the dialog. */
  overlay: (event: OverlayEvent) => void;
  key: (event: KeyInput) => void;
}

/** Values of the dialog; `null` as long as it is closed. */
export function dialogValues(p: ServersPage): ServerDialogValues | null {
  const d = p.dialog;
  if (!d) return null;
  const err = (k: keyof FormErrors) => d.err[k] ?? '';
  const eAdm = err('adm') || d.aErr || '';
  const busy = d.aSt === 'busy';
  // Stalwart's throttling applies only to its server, Roedy's lock to all.
  const thr = p.regLeft > 0 && p.regThrottled === trimUrl(d.url);
  const left = p.regThrottled === null || thr ? p.regLeft : 0;
  const oa = (mode: OaMode, label: string): OaOption => ({
    label,
    on: d.oa === mode,
    shadow: d.oa === mode ? 'var(--sh1)' : 'none',
    onClick: () => p.setOa(mode),
  });
  // A secret belongs to the stored client ID; the backend takes over one from the registration on saving.
  const cid = d.cid.trim();
  const secReg = !!cid && d.regSec && cid === d.regCid && trimUrl(d.url) === d.regUrl;
  const secText = secReg
    ? m.server_secret_registered()
    : cid && d.hasSec && cid === d.savedCid
      ? m.server_secret_kept()
      : m.server_secret_optional();
  // A new client requires all linked accounts to sign in again.
  const links = d.links;
  const linkText = (one: () => string, many: (n: { n: number }) => string) =>
    links === 1 ? one() : links > 1 ? many({ n: links }) : '';
  return {
    title: d.id ? m.server_dlg_edit() : m.server_add(),
    sub: d.id ? hostOf(trimUrl(d.url)) || d.url.trim() : m.server_dlg_add_sub(),
    btn: d.id ? m.server_dlg_save() : m.server_dlg_save_new(),
    icon: d.id ? 'ti-server-cog' : 'ti-server-2',
    label: d.label,
    url: d.url,
    domIn: d.domIn,
    domPh: d.domains.length ? '' : m.server_domain_placeholder(),
    doms: d.domains.map((x) => ({
      d: x,
      rmLabel: m.server_domain_remove({ domain: x }),
      rm: () => p.removeDomain(x),
    })),
    eLabel: err('label'),
    hasELabel: !!err('label'),
    eUrl: err('url'),
    hasEUrl: !!err('url'),
    plain: localHttp(d.url.trim()) && !err('url'),
    eDom: err('dom'),
    hasEDom: !!err('dom'),
    eAdm,
    hasEAdm: !!eAdm,
    eCred: err('cred'),
    hasECred: !!err('cred'),
    aLocked: left > 0 && !thr,
    aLockText: m.limit_text({ wait: waitText(left) }),
    aThr: thr,
    aThrText: thr ? throttleText(session.appName, left) : '',
    hasLinkHint: links > 0,
    linkHint: linkText(m.server_link_hint_one, m.server_link_hint),
    hasCidHint: links > 0 && cid !== d.savedCid,
    cidHint: linkText(m.server_cid_hint_one, m.server_cid_hint),
    regDis: busy || left > 0,
    oaOpts: [oa('auto', m.server_oa_auto()), oa('manual', m.server_oa_manual())],
    isAuto: d.oa === 'auto',
    isManual: d.oa === 'manual',
    aOk: d.aSt === 'ok',
    aNotOk: d.aSt !== 'ok',
    aBusy: busy,
    au: d.au,
    ap: d.ap,
    regLabel: busy
      ? m.server_oa_registering()
      : left > 0
        ? m.reg_locked_button({ clock: clockText(left) })
        : m.server_oa_register(),
    regIcon: busy ? 'ti-loader-2' : left > 0 ? 'ti-lock' : 'ti-wand',
    cidNote: m.server_oa_cid({ cid: d.cid }),
    cid: d.cid,
    csec: d.csec,
    secPh: secText,
    secReg,
    showSec: d.showSec,
    secIcon: d.showSec ? 'ti-eye-off' : 'ti-eye',
    secTip: d.showSec ? m.server_secret_hide() : m.server_secret_show(),
    redirect: p.redirect,
    saving: d.saving || d.saveQueued,
    onLabel: (value) => p.setLabel(value),
    onUrl: (value) => p.setUrl(value),
    onDomIn: (value) => p.domainInput(value),
    domKey: (event) => p.domainKey(event),
    domBlur: () => p.domainBlur(),
    onAu: (value) => p.setAdminUser(value),
    onAp: (value) => p.setAdminPassword(value),
    reg: () => void p.register(),
    regAgain: () => p.registerAgain(),
    onCid: (value) => p.setCid(value),
    onCsec: (value) => p.setSecret(value),
    onSecEye: () => p.toggleSecret(),
    copyRedirect: () => void p.copyRedirect(),
    save: () => void p.save(),
    close: () => p.closeDialog(),
    overlay: overlayClose(() => p.closeDialog()),
    key: (event) => p.dialogKey(event),
  };
}
