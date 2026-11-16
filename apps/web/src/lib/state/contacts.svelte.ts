/**
 * Contacts for the recipient suggestions in compose: recent
 * recipients from "Sent" of all mail accounts, the app directory
 * (`GET directory`, active app users) and, where the mail server offers JMAP for
 * Contacts, the contact cards (`ContactCard/query`, RFC 9610).
 * Loading happens when a recipient field gets focus, afterwards at most every five
 * minutes; a source that fails keeps its last state.
 */
import { CONTACTS, coreCapability, type ContactCard, type EmailAddress, type Id, type JmapClient } from '@roedy/jmap';
import { api } from '#lib/api.ts';
import { accounts } from '#lib/state/accounts.svelte.ts';
import { mailboxes } from '#lib/state/mailboxes.svelte.ts';
import { session } from '#lib/state/session.svelte.ts';

/** Person from a source; `name` empty if none is known. */
export interface Person {
  name: string;
  email: string;
}

/** Sent email with all recipients (To, Cc, Bcc). */
export interface SentEmail {
  at: number;
  to: Person[];
}

export interface Contact {
  name: string;
  email: string;
  /** In how many of the recent sent emails (rank). */
  count: number;
  /** Last sent (ms), 0 = never. */
  at: number;
  /** Name and address in comparison form (`fold`), separated by a line break. */
  match: string;
}

/** Mail account for `ContactsApi.accounts`; `ready` = without "sign-in required". */
export interface ContactAccount {
  id: string;
  ready: boolean;
}

export interface ContactsApi {
  directory: () => Promise<Person[]>;
  /** All mail accounts; only the ready ones are read, the others keep their last state. */
  accounts: () => Promise<ContactAccount[]>;
  /** Recent sent emails of an account. */
  sent: (account: string) => Promise<SentEmail[]>;
  /** People from an account's contact cards; empty without JMAP for Contacts. */
  cards: (account: string) => Promise<Person[]>;
}

/** Sent emails per account for "recent recipients". */
const SENT_LIMIT = 200;
/** Contact cards per account. */
const CARD_LIMIT = 500;
/** At most this many suggestions. */
export const SUGGEST_MAX = 5;
/** Reload at the earliest after this time, on the next focus. */
export const CONTACTS_STALE_MS = 5 * 60_000;
/**
 * Remembered sends (`remember`) stay until a load that has read "Sent"
 * of all accounts at least this long afterwards; that is how much time
 * sending gets to arrive there.
 */
const OWN_GRACE_MS = 60_000;

/** Comparison form: lower case, German umlauts as ae/oe/ue, sharp s as ss, without accents. */
export function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/\u00e4/g, 'ae')
    .replace(/\u00f6/g, 'oe')
    .replace(/\u00fc/g, 'ue')
    .replace(/\u00df/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Frequent first, then last sent, then by name or address. */
function rank(a: Contact, b: Contact): number {
  return b.count - a.count || b.at - a.at || (a.name || a.email).localeCompare(b.name || b.email, 'de');
}

/**
 * Merges the sources: per address (case-insensitive)
 * one contact, which counts once per sent email; the
 * name comes from the newest sent email with a name, otherwise from
 * the directory or contact cards. Entries without an address drop out.
 */
export function mergeContacts(sent: readonly SentEmail[], others: readonly Person[]): Contact[] {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, the list is displayed
  const out = new Map<string, Contact>();
  const add = (p: Person, at: number | null, seen?: Set<string>) => {
    // Data from the server: an address without text drops out instead of aborting the load.
    const email = typeof p.email === 'string' ? p.email.trim() : '';
    if (!email) return;
    const key = email.toLowerCase();
    if (seen?.has(key)) return;
    seen?.add(key);
    const raw = typeof p.name === 'string' ? p.name.trim() : '';
    const name = raw === email ? '' : raw;
    const o = out.get(key);
    if (!o) out.set(key, { name, email, count: at === null ? 0 : 1, at: at ?? 0, match: '' });
    else {
      if (at !== null) {
        o.count++;
        o.at = Math.max(o.at, at);
      }
      if (!o.name && name) o.name = name;
    }
  };
  for (const e of [...sent].sort((a, b) => b.at - a.at)) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, new per email
    const seen = new Set<string>();
    for (const p of e.to) add(p, e.at, seen);
  }
  for (const p of others) add(p, null);
  return [...out.values()].map((c) => ({ ...c, match: `${fold(c.name)}\n${fold(c.email)}` })).sort(rank);
}

export class Contacts {
  /** All contacts, by rank. */
  list = $state.raw<Contact[]>([]);
  #api: ContactsApi;
  #directory: Person[] = [];
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, `list` is displayed
  #sent = new Map<string, SentEmail[]>();
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, `list` is displayed
  #cards = new Map<string, Person[]>();
  /** Sent since the last load (`remember`). */
  #own: SentEmail[] = [];
  #loadedAt = -Infinity;
  #loading: Promise<void> | null = null;
  #gen = 0;

  constructor(contactsApi: ContactsApi = jmapContactsApi()) {
    this.#api = contactsApi;
  }

  /** Loads the sources if they are missing or older than five minutes; errors stay silent. */
  ensure(): Promise<void> {
    if (this.#loading) return this.#loading;
    if (Date.now() - this.#loadedAt < CONTACTS_STALE_MS) return Promise.resolve();
    const loading = this.#load().finally(() => {
      if (this.#loading === loading) this.#loading = null;
    });
    this.#loading = loading;
    return loading;
  }

  /** Suggestions for the input: name or address contains it; `skip` with the lower-case address. */
  suggest(query: string, skip: (email: string) => boolean): Contact[] {
    const q = fold(query.trim());
    const out: Contact[] = [];
    if (!q) return out;
    for (const c of this.list) {
      if (!c.match.includes(q) || skip(c.email.toLowerCase())) continue;
      out.push(c);
      if (out.length === SUGGEST_MAX) break;
    }
    return out;
  }

  /** Contact for an address, for the name of typed addresses. */
  find(email: string): Contact | undefined {
    const key = email.trim().toLowerCase();
    return this.list.find((c) => c.email.toLowerCase() === key);
  }

  /** After sending: the recipients count as last sent immediately. */
  remember(to: readonly Person[]): void {
    if (!to.length) return;
    this.#own = [...this.#own, { at: Date.now(), to: [...to] }];
    this.#rebuild();
  }

  /** Sign-out: discard everything. */
  reset(): void {
    this.#gen++;
    this.#loading = null;
    this.#loadedAt = -Infinity;
    this.#directory = [];
    this.#sent.clear();
    this.#cards.clear();
    this.#own = [];
    this.list = [];
  }

  async #load(): Promise<void> {
    const gen = this.#gen;
    const start = Date.now();
    const quiet = <T>(p: Promise<T>) => p.catch(() => null);
    const [directory, all] = await Promise.all([quiet(this.#api.directory()), quiet(this.#api.accounts())]);
    const per = await Promise.all(
      (all ?? [])
        .filter((a) => a.ready)
        .map(async ({ id }) => {
          const [sent, cards] = await Promise.all([quiet(this.#api.sent(id)), quiet(this.#api.cards(id))]);
          return { id, sent, cards };
        }),
    );
    if (gen !== this.#gen) return;
    let ok = directory !== null || all !== null;
    if (directory) this.#directory = directory;
    if (all) {
      // Removed accounts drop out; failed ones and those with "sign-in required" keep their last state.
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- internal only, new per load
      const ids = new Set(all.map((a) => a.id));
      for (const map of [this.#sent, this.#cards]) for (const k of [...map.keys()]) if (!ids.has(k)) map.delete(k);
      for (const { id, sent, cards } of per) {
        if (sent) this.#sent.set(id, sent);
        if (cards) this.#cards.set(id, cards);
        ok ||= !!sent;
      }
      // What was sent well before the load is now in "Sent" – provided every account has read it.
      if (all.every((a) => a.ready) && per.every((x) => x.sent))
        this.#own = this.#own.filter((e) => e.at >= start - OWN_GRACE_MS);
    }
    if (ok) this.#loadedAt = start;
    this.#rebuild();
  }

  #rebuild(): void {
    // The own entry in the directory is not a suggestion (like the addresses of the mail accounts).
    const me = session.user?.email.toLowerCase();
    const directory = this.#directory.filter((p) => p.email.toLowerCase() !== me);
    this.list = mergeContacts(
      [...[...this.#sent.values()].flat(), ...this.#own],
      [...directory, ...[...this.#cards.values()].flat()],
    );
  }
}

const person = (a: EmailAddress): Person => ({ name: a.name?.trim() ?? '', email: a.email });

/** Name of a contact card: `full`, otherwise given and surnames (RFC 9553, 2.2.1). */
function cardName(card: ContactCard): string {
  const full = card.name?.full?.trim();
  if (full) return full;
  return (card.name?.components ?? [])
    .filter((c) => c.kind === 'given' || c.kind === 'given2' || c.kind === 'surname' || c.kind === 'surname2')
    .map((c) => (typeof c.value === 'string' ? c.value.trim() : ''))
    .filter(Boolean)
    .join(' ');
}

/** Mailbox "Sent" of an account, `null` without. */
async function sentBoxOf(account: string): Promise<Id | null> {
  await mailboxes.ensure(account);
  return mailboxes.role(account, 'sent')?.id ?? null;
}

/** `ContactsApi` via the backend (`GET directory`) and JMAP (RFC 8621 `Email/query`, RFC 9610 `ContactCard/query`). */
export function jmapContactsApi(
  client: (account: string) => Promise<JmapClient> = (account) => accounts.client(account),
  sentBox: (account: string) => Promise<Id | null> = sentBoxOf,
): ContactsApi {
  return {
    directory: async () => {
      const res = await api<{ users: Person[] }>('GET', 'directory');
      return res.users;
    },
    accounts: async () => {
      await accounts.ensure();
      return (accounts.list ?? []).map((a) => ({ id: a.id, ready: a.state === 'ok' }));
    },
    sent: async (account) => {
      const box = await sentBox(account);
      if (!box) return [];
      const c = await client(account);
      const accountId = await c.accountId();
      const max = coreCapability(await c.session()).maxObjectsInGet;
      const b = c.batch();
      const query = b.call('Email/query', {
        accountId,
        filter: { inMailbox: box },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: Math.min(SENT_LIMIT, max),
      });
      const get = b.call('Email/get', {
        accountId,
        '#ids': query.ref('/ids'),
        properties: ['to', 'cc', 'bcc', 'receivedAt'],
      });
      const res = await b.send();
      return res.get(get).list.map((e) => ({
        at: Date.parse(e.receivedAt) || 0,
        to: [...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? [])].map(person),
      }));
    },
    cards: async (account) => {
      const c = await client(account);
      const s = await c.session();
      // Only with contacts in the session and an account for them (scope contacts).
      if (!(CONTACTS in s.capabilities) || s.primaryAccounts[CONTACTS] === undefined) return [];
      const accountId = await c.accountId(CONTACTS);
      const b = c.batch();
      const query = b.call('ContactCard/query', {
        accountId,
        limit: Math.min(CARD_LIMIT, coreCapability(s).maxObjectsInGet),
      });
      const get = b.call('ContactCard/get', { accountId, '#ids': query.ref('/ids'), properties: ['name', 'emails'] });
      const res = await b.send();
      return res.get(get).list.flatMap((card) => {
        const name = cardName(card);
        return Object.values(card.emails ?? {})
          .filter((e) => typeof e.address === 'string')
          .map((e) => ({ name, email: e.address }));
      });
    },
  };
}

export const contacts = new Contacts();
