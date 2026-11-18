/**
 * State module `accounts`: the user's mail accounts from
 * `GET mail-accounts`, per account a token source (`TokenSource` via
 * `GET mail-accounts/:id/token`) and a JMAP client from `@roedy/jmap`.
 * `count` is `null` while the list is unknown –
 * otherwise the layout would briefly redirect to "no account" while loading.
 */
import { JmapClient, TokenSource, type TokenGrant } from '@roedy/jmap';
import { MA_COLORS } from '@roedy/tokens';
import { api, isApiError, retryAfter } from '#lib/api.ts';
import { appFetch } from '#lib/state/network.svelte.ts';

/** Mail account from `GET mail-accounts`. */
export interface MailAccount {
  id: string;
  email: string;
  /** User name of the JMAP session (fact "user name"). */
  username: string;
  /** Origin of the mail server. */
  url: string;
  host: string;
  /** Registry server with this origin; `null` = own server. */
  server_id: string | null;
  auth_kind: 'oauth' | 'token';
  /** Index into `MA_COLORS`. */
  color: number;
  /** `needs_reauth` = "sign-in required". */
  state: 'ok' | 'needs_reauth';
  /** Allowed neither in the registry nor as an own server (`raBlocked`). */
  blocked: boolean;
  quota_used: number | null;
  quota_total: number | null;
  last_check_at: string | null;
  created_at: string;
}

/** Colors of an account's tile: fill and text. */
export function colorOf(account: Pick<MailAccount, 'color'>): { bg: string; ink: string } {
  const [, bg, ink] = MA_COLORS[account.color] ?? MA_COLORS[0];
  return { bg, ink };
}

/** Tile of an account (account switcher, headers in the folder tree): initial of the address and colors. */
export function tileOf(account: Pick<MailAccount, 'email' | 'color'>): { letter: string; bg: string; ink: string } {
  return { letter: account.email.charAt(0).toUpperCase(), ...colorOf(account) };
}

/** `defaultAccount` of the settings for "all accounts" (`mDefault: 'all'`). */
export const DEFAULT_ALL = 'all';

/**
 * Default account (`defaultAccount` of the settings), otherwise the first account –
 * also with "all accounts" (when the sidebar shows an account).
 */
export function defaultAccountOf(list: readonly MailAccount[] | null, id: string | null): MailAccount | null {
  return list?.find((a) => a.id === id) ?? list?.[0] ?? null;
}

/**
 * Account marked "default" (list, account switch): with "all accounts"
 * as default none, as long as "all accounts" exists (more than one account).
 */
export function markedDefaultOf(list: readonly MailAccount[] | null, id: string | null): MailAccount | null {
  return id === DEFAULT_ALL && (list?.length ?? 0) > 1 ? null : defaultAccountOf(list, id);
}

/** Tiles of the first `count` accounts for "all accounts". */
export function tilesOf(list: readonly MailAccount[], count: number): { letter: string; bg: string; ink: string }[] {
  return list.slice(0, count).map((a) => tileOf(a));
}

export class Accounts {
  /** `null` while unknown (before the first load, signed out). */
  list = $state<MailAccount[] | null>(null);
  count = $derived(this.list?.length ?? null);
  /**
   * The latest load failed; cleared when a new load starts. Says nothing about the list: after a failed first
   * load it stays `null` (no "no account" either), a failed refresh keeps the previous list.
   */
  failed = $state(false);

  // Not reactive: sources and clients are not displayed.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #tokens = new Map<string, TokenSource>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #clients = new Map<string, Promise<JmapClient>>();
  #seq = 0;
  /** Running color choice per account (counter of the latest choice). */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #colorSeq = new Map<string, number>();
  /** Color according to the server while a color choice runs: target of the rollback. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #colorBase = new Map<string, number>();
  /** Hidden accounts (remove with undo): entry and position in the list. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  #hidden = new Map<string, { account: MailAccount; at: number }>();
  /** Running load (`#seq` of the call), otherwise 0. */
  #running = 0;
  #loading: Promise<void> | null = null;

  /** Loads the accounts if they are still unknown; a running load counts. */
  ensure(): Promise<void> {
    if (this.list !== null) return Promise.resolve();
    if (!this.#loading) {
      const loading = this.load().finally(() => {
        if (this.#loading === loading) this.#loading = null;
      });
      this.#loading = loading;
    }
    return this.#loading;
  }

  /** Loads the accounts; responses of an older call expire. */
  async load(): Promise<void> {
    const seq = ++this.#seq;
    this.#running = seq;
    this.failed = false;
    let res: { accounts: MailAccount[] };
    try {
      res = await api<{ accounts: MailAccount[] }>('GET', 'mail-accounts');
    } catch (error) {
      if (seq === this.#seq) this.failed = true;
      throw error;
    } finally {
      if (this.#running === seq) this.#running = 0;
    }
    if (seq !== this.#seq) return;
    // Hidden accounts: "undo" brings back the server's state, one already removed there brings back nothing.
    for (const [id, hidden] of this.#hidden) {
      const fresh = res.accounts.find((a) => a.id === id);
      if (fresh) hidden.account = fresh;
      else this.#hidden.delete(id);
    }
    this.list = res.accounts.filter((a) => !this.#hidden.has(a.id));
    this.failed = false;
    for (const id of [...this.#tokens.keys()]) if (!res.accounts.some((a) => a.id === id)) this.#forget(id);
  }

  /** Start from the copy (`#lib/start-copy.ts`): list without the server until it answers. */
  fromCopy(list: MailAccount[]): void {
    this.list = list;
  }

  /** Sign-out: discard list and tokens. */
  reset(): void {
    this.#seq++;
    this.#loading = null;
    this.list = null;
    this.failed = false;
    this.#hidden.clear();
    for (const id of [...this.#tokens.keys()]) this.#forget(id);
  }

  get(id: string): MailAccount | undefined {
    return this.list?.find((a) => a.id === id);
  }

  /** Hidden while undo is pending (`hide`). */
  isHidden(id: string): boolean {
    return this.#hidden.has(id);
  }

  /**
   * New or re-authenticated account (response of `POST mail-accounts`
   * or `…/reauth`). After "sign in again" the token source fetches the
   * new token; a running fetch ends.
   */
  put(account: MailAccount): void {
    this.#tokens.get(account.id)?.clear();
    // Hidden (remove with undo): only "undo" shows it again.
    const hidden = this.#hidden.get(account.id);
    if (hidden) {
      hidden.account = account;
      return;
    }
    // Unknown list or a load that began before the new account: reload instead of half a list.
    if (this.list === null || this.#running) void this.load().catch(() => {});
    if (this.list === null) return;
    const at = this.list.findIndex((a) => a.id === account.id);
    this.list = at < 0 ? [...this.list, account] : this.list.map((a, i) => (i === at ? account : a));
  }

  /**
   * "Check connection" (`POST mail-accounts/:id/check`):
   * takes storage and `last_check_at` from the response; `needs_reauth`
   * and `blocked` change the entry as with the token, other errors nothing.
   */
  async check(id: string): Promise<MailAccount> {
    try {
      const account = await api<MailAccount>('POST', `mail-accounts/${encodeURIComponent(id)}/check`);
      // A color choice still running stays in effect.
      const pending = this.#colorSeq.has(id) ? this.get(id)?.color : undefined;
      this.#replace(pending === undefined ? account : { ...account, color: pending });
      return account;
    } catch (error) {
      if (isApiError(error, 409, 'needs_reauth')) this.#patch(id, { state: 'needs_reauth' });
      else if (isApiError(error, 409, 'blocked')) this.#patch(id, { blocked: true });
      throw error;
    }
  }

  /**
   * Color of the account (`PATCH mail-accounts/:id`): applies immediately;
   * if the latest choice fails, the color the server last confirmed applies
   * again (even if several were chosen quickly before).
   */
  async setColor(id: string, color: number): Promise<void> {
    const prev = this.get(id)?.color;
    if (prev === undefined || prev === color) return;
    if (!this.#colorSeq.has(id)) this.#colorBase.set(id, prev);
    const seq = (this.#colorSeq.get(id) ?? 0) + 1;
    this.#colorSeq.set(id, seq);
    this.#patch(id, { color });
    const latest = () => this.#colorSeq.get(id) === seq;
    try {
      const account = await api<MailAccount>('PATCH', `mail-accounts/${encodeURIComponent(id)}`, { color });
      if (this.#colorSeq.has(id)) this.#colorBase.set(id, account.color);
      if (latest()) this.#replace(account);
    } catch (error) {
      if (latest()) this.#patch(id, { color: this.#colorBase.get(id) ?? prev });
      throw error;
    } finally {
      if (latest()) {
        this.#colorSeq.delete(id);
        this.#colorBase.delete(id);
      }
    }
  }

  /**
   * "Remove account" with undo: the account disappears
   * from the list immediately – also from a reloaded one – until `remove()`
   * removes it or `restore()` brings it back. `false` for an unknown
   * or already hidden account.
   */
  hide(id: string): boolean {
    const at = this.list?.findIndex((a) => a.id === id) ?? -1;
    const account = this.list?.[at];
    if (!this.list || !account) return false;
    this.#hidden.set(id, { account, at });
    this.list = this.list.filter((a) => a.id !== id);
    return true;
  }

  /** Undo: the hidden account back in its place. */
  restore(id: string): void {
    const hidden = this.#hidden.get(id);
    if (!hidden) return;
    this.#hidden.delete(id);
    if (!this.list || this.list.some((a) => a.id === id)) return;
    const list = [...this.list];
    list.splice(Math.min(hidden.at, list.length), 0, hidden.account);
    this.list = list;
  }

  /**
   * Removes the account (`DELETE mail-accounts/:id`; the backend then revokes
   * the grant) and forgets token and client. An already
   * removed account (404) counts as removed; on any other error everything
   * stays as it is.
   */
  async remove(id: string, keepalive = false): Promise<void> {
    try {
      await api('DELETE', `mail-accounts/${encodeURIComponent(id)}`, undefined, { keepalive });
    } catch (error) {
      if (!isApiError(error, 404)) throw error;
    }
    this.#hidden.delete(id);
    // A running load may still know the account.
    if (this.#running) void this.load().catch(() => {});
    if (this.list) this.list = this.list.filter((a) => a.id !== id);
    this.#forget(id);
  }

  /**
   * Token source of the account. If the broker reports `needs_reauth` or
   * `blocked`, the list shows it at once ("sign-in required",
   * `raBlocked`); the error goes to the caller unchanged.
   */
  tokens(id: string): TokenSource {
    let source = this.#tokens.get(id);
    if (!source) {
      source = new TokenSource({
        fetch: async (refresh) => {
          try {
            return await api<TokenGrant>(
              'GET',
              `mail-accounts/${encodeURIComponent(id)}/token${refresh ? '?refresh=true' : ''}`,
            );
          } catch (error) {
            if (isApiError(error, 409, 'needs_reauth')) this.#patch(id, { state: 'needs_reauth' });
            else if (isApiError(error, 409, 'blocked')) this.#patch(id, { blocked: true });
            throw error;
          }
        },
        retryAfter: (error) => (isApiError(error, 429) ? retryAfter(error) : undefined),
      });
      this.#tokens.set(id, source);
    }
    return source;
  }

  /**
   * JMAP client of the account with the session from the broker's response
   * (saves fetching `/.well-known/jmap`). If the first token fails,
   * the next call tries again.
   */
  client(id: string): Promise<JmapClient> {
    let client = this.#clients.get(id);
    if (!client) {
      const account = this.get(id);
      if (!account) return Promise.reject(new Error(`Unknown mail account ${id}`));
      const tokens = this.tokens(id);
      client = tokens
        .token()
        .then(() => new JmapClient({ url: account.url, tokens, session: tokens.grant?.session, fetch: appFetch }));
      void client.catch(() => {
        if (this.#clients.get(id) === client) this.#clients.delete(id);
      });
      this.#clients.set(id, client);
    }
    return client;
  }

  /** Server response for an account in the list; an unknown one is not added. */
  #replace(account: MailAccount): void {
    if (this.list) this.list = this.list.map((a) => (a.id === account.id ? account : a));
  }

  #patch(id: string, patch: Partial<MailAccount>): void {
    if (this.list) this.list = this.list.map((a) => (a.id === id ? { ...a, ...patch } : a));
  }

  #forget(id: string): void {
    this.#tokens.get(id)?.clear();
    this.#tokens.delete(id);
    this.#clients.delete(id);
  }
}

export const accounts = new Accounts();
