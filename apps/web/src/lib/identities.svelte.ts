/**
 * Email account › Identities: identities of the account via `Identity/get`,
 * editing of name, reply address and signature via `Identity/set` (RFC 8621, 6);
 * the server sets the address and creates new identities. After saving, the
 * composer gets the new list. A failed first load, no identity and a running
 * save each have their own state in the page.
 */
import type { EmailAddress, Identity, JmapClient, PatchObject, SetError } from '@roedy/jmap';
import { SvelteSet } from 'svelte/reactivity';
import { isEmail } from '#lib/email.ts';
import { failText } from '#lib/errors.ts';
import { LoadFailed, loadErrorText, loadFailureOf, type LoadInput, type LoadValues } from '#lib/mail-account.svelte.ts';
import { avatarOf, initials } from '#lib/mail-list.ts';
import { m } from '#lib/paraglide/messages.js';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { compose, sortIdentities } from '#lib/state/compose.svelte.ts';
import { onForget } from '#lib/state/forget.ts';
import { ui } from '#lib/state/ui.svelte.ts';

export interface IdentityApi {
  list(account: string): Promise<Identity[]>;
  /** Changes an identity and returns the list afterwards; rejected as `IdentityRefused`. */
  update(account: string, id: string, patch: PatchObject): Promise<Identity[]>;
}

/** The server rejected the change (`notUpdated`). */
export class IdentityRefused extends Error {
  readonly error: SetError;
  constructor(error: SetError) {
    super(`Identity/set: ${error.type}`);
    this.error = error;
  }
}

/** `IdentityApi` via JMAP: `Identity/set` and `Identity/get` in one request. */
export function jmapIdentityApi(client: (account: string) => Promise<JmapClient>): IdentityApi {
  return {
    async list(account) {
      const c = await client(account);
      return (await c.call('Identity/get', { accountId: await c.accountId(), ids: null })).list;
    },
    async update(account, id, patch) {
      const c = await client(account);
      const accountId = await c.accountId();
      const batch = c.batch();
      const set = batch.call('Identity/set', { accountId, update: { [id]: patch } });
      const get = batch.call('Identity/get', { accountId, ids: null });
      const res = await batch.send();
      const refused = res.get(set).notUpdated?.[id];
      if (refused) throw new IdentityRefused(refused);
      return res.get(get).list;
    },
  };
}

/** Reply addresses as the text of the field "Reply to"; several with commas. */
export function replyText(list: readonly EmailAddress[] | null): string {
  return (list ?? []).map((a) => a.email).join(', ');
}

/** Field "Reply to" as `replyTo`: empty `null`, `undefined` for an invalid address. */
export function parseReplyTo(text: string): EmailAddress[] | null | undefined {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return parts.every(isEmail) ? parts.map((email) => ({ name: null, email })) : undefined;
}

export interface IdentityFields {
  name: string;
  replyTo: string;
  sig: string;
}

/** Form fields from the server's identity. */
export function identityFields(i: Identity): IdentityFields {
  return { name: i.name, replyTo: replyText(i.replyTo), sig: i.textSignature };
}

/**
 * Changes for `Identity/set`, only what changed. An empty name keeps the
 * previous one; a changed
 * signature clears the HTML signature so that other programs do not show the
 * old one (the app only writes text).
 */
export function identityPatch(before: Identity, f: IdentityFields, replyTo: EmailAddress[] | null): PatchObject {
  const patch: PatchObject = {};
  const name = f.name.trim() || before.name;
  if (name !== before.name) patch.name = name;
  if (replyText(replyTo) !== replyText(before.replyTo)) patch.replyTo = replyTo;
  if (f.sig !== before.textSignature) {
    patch.textSignature = f.sig;
    if (before.htmlSignature) patch.htmlSignature = '';
  }
  return patch;
}

/**
 * Edited identity (`maIdEd`): only the changed fields, the others
 * follow the last loaded identity – a reload during editing
 * thus resets no newer values.
 */
export interface IdentityDraft {
  account: string;
  id: string;
  changes: Partial<IdentityFields>;
}

export class Identities {
  /** Last loaded identities per account; `LoadFailed` if the first load failed. */
  lists = $state.raw<Record<string, Identity[] | LoadFailed>>({});
  draft = $state.raw<IdentityDraft | null>(null);
  /** Accounts whose `Identity/set` is running. */
  saving = new SvelteSet<string>();
  #gen = 0;
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- running fetches, not shown
  #loads = new Map<string, Promise<void>>();
  readonly #api: IdentityApi;

  constructor(api: IdentityApi = jmapIdentityApi((account) => accounts.client(account))) {
    this.#api = api;
  }

  /**
   * Identities of an account; until then the last loaded ones. If the
   * first load fails, the page shows the card, a later failure as a toast.
   */
  load(account: string): Promise<void> {
    let load = this.#loads.get(account);
    if (load) return load;
    const gen = this.#gen;
    // After a failed load ("Try again") the skeleton again.
    if (this.lists[account] instanceof LoadFailed) {
      const lists = { ...this.lists };
      delete lists[account];
      this.lists = lists;
    }
    load = this.#api
      .list(account)
      .then(
        (list) => {
          if (gen !== this.#gen) return;
          this.lists = { ...this.lists, [account]: list };
          compose.identitiesChanged(account, list);
        },
        (error: unknown) => {
          if (gen !== this.#gen) return;
          if (Array.isArray(this.lists[account]))
            ui.toasts.error(loadErrorText(error, accounts.get(account)?.host ?? ''));
          else this.lists = { ...this.lists, [account]: new LoadFailed(error) };
        },
      )
      .finally(() => {
        if (gen === this.#gen) this.#loads.delete(account);
      });
    this.#loads.set(account, load);
    return load;
  }

  edit(account: string, identity: Identity): void {
    this.draft = { account, id: identity.id, changes: {} };
  }

  /** Change a field; without effect during `Identity/set`. */
  set(field: keyof IdentityFields, value: string): void {
    if (this.draft && !this.saving.has(this.draft.account))
      this.draft = { ...this.draft, changes: { ...this.draft.changes, [field]: value } };
  }

  /** Edited identity of the account, otherwise `undefined`. */
  #edited(account: string): { draft: IdentityDraft; identity: Identity } | undefined {
    const d = this.draft;
    const list = this.lists[account];
    const identity = d?.account === account && Array.isArray(list) ? list.find((i) => i.id === d.id) : undefined;
    return d && identity ? { draft: d, identity } : undefined;
  }

  /** Form fields: the loaded identity with the changes of the draft. */
  fieldsOf(account: string): IdentityFields | null {
    const e = this.#edited(account);
    return e ? { ...identityFields(e.identity), ...e.draft.changes } : null;
  }

  cancel(): void {
    this.draft = null;
  }

  /** Save (`maIdF.save`): first check the reply address, then `Identity/set`. */
  async save(): Promise<void> {
    const d = this.draft;
    if (!d || this.saving.has(d.account)) return;
    const e = this.#edited(d.account);
    if (!e) {
      this.draft = null;
      return;
    }
    const before = e.identity;
    const f = { ...identityFields(before), ...d.changes };
    const replyTo = parseReplyTo(f.replyTo);
    if (replyTo === undefined) {
      ui.toasts.show(m.mail_identity_reply_invalid());
      return;
    }
    const patch = identityPatch(before, f, replyTo);
    if (Object.keys(patch).length === 0) {
      this.draft = null;
      ui.toasts.show(m.mail_identity_saved());
      return;
    }
    const gen = this.#gen;
    this.saving.add(d.account);
    try {
      const next = await this.#api.update(d.account, d.id, patch);
      if (gen !== this.#gen) return;
      this.lists = { ...this.lists, [d.account]: next };
      compose.identitiesChanged(d.account, next);
      if (this.draft === d) this.draft = null;
      ui.toasts.show(m.mail_identity_saved());
    } catch (error) {
      if (gen !== this.#gen) return;
      const reply = error instanceof IdentityRefused && error.error.properties?.includes('replyTo');
      ui.toasts.error(reply ? m.mail_identity_reply_invalid() : failText(error));
    } finally {
      if (gen === this.#gen) this.saving.delete(d.account);
    }
  }

  /** Sign-out: discard lists, draft and running fetches. */
  reset(): void {
    this.#gen++;
    this.#loads.clear();
    this.lists = {};
    this.draft = null;
    this.saving.clear();
  }
}

export const identities = new Identities();
// Sign-out: `forgetAccount()` does not know the module, it only loads with its pages.
onForget(() => identities.reset());

/** Row of the list (`maIdRows[]`); background and shadow by `editing`. */
export interface IdentityRow {
  id: string;
  name: string;
  email: string;
  ini: string;
  avBg: string;
  avInk: string;
  /** "Reply to …" · "With signature" or "No signature". */
  sub: string;
  editing: boolean;
  edit: () => void;
}

/** Form of the edited identity (`maIdF`). */
export interface IdentityForm extends IdentityFields {
  /**
   * Saving is running: spinner and "Saving …",
   * fields read-only, "Cancel" faded and without effect.
   */
  saving: boolean;
  onName: (value: string) => void;
  onReply: (value: string) => void;
  onSig: (value: string) => void;
  cancel: () => void;
  save: () => void;
}

export interface IdentitiesValues {
  /** First load failed (`maLoad.fail`): card instead of list and notice; otherwise `null` (`maLoad.ok`). */
  load: LoadValues | null;
  /** No identity (`maIdEmpty`): empty state with `emptyText` instead of the list, the notice stays. */
  empty: boolean;
  emptyText: string;
  rows: IdentityRow[];
  form: IdentityForm;
}

/** Values of the page; `null` while nothing is loaded (skeleton). */
export function identitiesValues(a: MailAccount, input: LoadInput): IdentitiesValues | null {
  const loaded = identities.lists[a.id];
  if (loaded === undefined) return null;
  const failed = loaded instanceof LoadFailed ? loaded : null;
  const list = loaded instanceof LoadFailed ? [] : loaded;
  const saving = identities.saving.has(a.id);
  const d = identities.draft?.account === a.id ? identities.draft : null;
  const f = identities.fieldsOf(a.id);
  const rows = sortIdentities(list, a.email).map((i): IdentityRow => {
    const [avBg, avInk] = avatarOf(i.name || i.email);
    const reply = replyText(i.replyTo);
    return {
      id: i.id,
      name: i.name || i.email,
      email: i.email,
      ini: initials(i.name) || i.email.charAt(0).toUpperCase(),
      avBg,
      avInk,
      sub: [
        reply ? m.mail_identity_reply_to({ email: reply }) : '',
        i.textSignature.trim() ? m.mail_identity_with_sig() : m.mail_identity_without_sig(),
      ]
        .filter(Boolean)
        .join(' · '),
      editing: d?.id === i.id,
      edit: () => identities.edit(a.id, i),
    };
  });
  return {
    load: failed && {
      ...loadFailureOf(failed.error, a.host),
      onRetry: () => void identities.load(a.id),
      goCon: () => input.connection(a.id),
    },
    empty: !failed && list.length === 0,
    emptyText: m.mail_identity_empty_text({ host: a.host }),
    rows,
    form: {
      name: f?.name ?? '',
      replyTo: f?.replyTo ?? '',
      sig: f?.sig ?? '',
      saving,
      onName: (v) => identities.set('name', v),
      onReply: (v) => identities.set('replyTo', v),
      onSig: (v) => identities.set('sig', v),
      // Without effect while saving; leaving the page discards anyway.
      cancel: () => {
        if (!identities.saving.has(a.id)) identities.cancel();
      },
      save: () => void identities.save(),
    },
  };
}
