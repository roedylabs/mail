/**
 * JMAP push in the service worker: confirmation of a subscription, new mail
 * and `pushsubscriptionchange`, even without an open window. The token comes
 * from the backend as in the app (session cookie). Something always appears
 * for a new mail: without a session or response `blindNotice`, if the
 * account is signed out `authNotice`.
 */
import {
  JmapClient,
  parsePushObject,
  TokenSource,
  verifyPushSubscription,
  type Email,
  type PushObject,
  type TokenGrant,
} from '@roedy/jmap';
import {
  authNotice,
  blindNotice,
  isQuiet,
  mailNotice,
  mailTag,
  mergeMails,
  openMails,
  type MailContext,
  type MailNotice,
  type MailSummary,
} from '#lib/mail-push-notification.ts';
import { mailPushStore, type MailPushCopy, type MailPushStore } from '#lib/mail-push-store.ts';
import { browserSubscription } from '#lib/push-keys.ts';
import { baseLocale, isLocale, overwriteGetLocale } from '#lib/paraglide/runtime.js';
import { MAIL_MESSAGE } from '#lib/push-message.ts';
import {
  createEntry,
  destroyEntries,
  isExpired,
  ownEntries,
  renewIfDue,
  serverKey,
  VERIFIED_MESSAGE,
} from '#lib/mail-push-subscription.ts';

/** JMAP client of an account; replaceable in tests. */
export type LoadClient = (accountId: string) => Promise<JmapClient>;

/** From the service worker's `clients`; the app project does not know its types. */
export interface WindowClients {
  matchAll(options: {
    type: 'window';
    includeUncontrolled: boolean;
  }): Promise<readonly { visibilityState: DocumentVisibilityState; postMessage(message: unknown): void }[]>;
}

/** What a push needs from the service worker. */
export interface MailWorker {
  clients: WindowClients;
  registration: Pick<ServiceWorkerRegistration, 'pushManager' | 'showNotification' | 'getNotifications'>;
  /** Name until the app has stored a copy. */
  appName: string;
  /** The browser requires the notification even with the app visible (`needsEveryNotice`). */
  everyNotice: boolean;
  load?: LoadClient;
  store?: MailPushStore;
  now?: number;
}

/** Rejection by the broker (`{ "error": "<code>" }`); the app knows the same codes as `ApiError`. */
class TokenRefused extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(`Token: ${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

const WINDOWS = { type: 'window', includeUncontrolled: true } as const;

/** Lower than `renewIfDue`: fetching the entries more than once a day brings nothing. */
const RENEW_CHECK = 86_400_000;

async function refusedCode(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => null);
  const code = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return typeof code === 'string' ? code : 'unknown';
}

/** Client with token and session from the broker's response (`GET mail-accounts/:id/token`). */
export async function workerClient(accountId: string): Promise<JmapClient> {
  const tokens = new TokenSource({
    fetch: async (refresh) => {
      const path = `/api/v1/mail-accounts/${encodeURIComponent(accountId)}/token${refresh ? '?refresh=true' : ''}`;
      const response = await fetch(path, {
        credentials: 'same-origin',
        headers: { 'X-Requested-With': 'roedy-mail' },
      });
      if (!response.ok) throw new TokenRefused(response.status, await refusedCode(response));
      return (await response.json()) as TokenGrant;
    },
  });
  await tokens.token();
  const session = tokens.grant?.session as { apiUrl?: unknown } | undefined;
  if (typeof session?.apiUrl !== 'string') throw new Error('Token without session');
  return new JmapClient({ url: new URL(session.apiUrl).origin, tokens, session });
}

function mailContext(id: string, copy: MailPushCopy | null, worker: MailWorker, now: number): MailContext {
  const accounts = copy?.accounts ?? {};
  return {
    id,
    email: accounts[id] ?? '',
    multi: Object.keys(accounts).length > 1,
    silent: copy ? isQuiet(copy.quiet, now) : false,
    appName: copy?.appName || worker.appName,
  };
}

function senderOf(email: Pick<Email, 'from'>): string {
  const sender = email.from?.[0];
  return sender?.name?.trim() || sender?.email || '';
}

/** Sender and subject via JMAP, newest first; the push service only sees the IDs. */
async function fetchMails(
  client: JmapClient,
  push: Extract<PushObject, { type: 'EmailPush' }>,
): Promise<MailSummary[]> {
  const ids = push.emails.flatMap(({ id }) => (typeof id === 'string' ? [id] : []));
  if (ids.length === 0) return [];
  const { list } = await client.call('Email/get', {
    accountId: push.accountId,
    ids,
    properties: ['id', 'threadId', 'from', 'subject', 'receivedAt'],
  });
  const received = (email: Pick<Email, 'receivedAt'>) => Date.parse(email.receivedAt ?? '') || 0;
  return [...list]
    .sort((a, b) => received(b) - received(a))
    .map((email) => ({
      id: email.id,
      thread: email.threadId ?? email.id,
      from: senderOf(email),
      subject: email.subject ?? '',
    }));
}

/** Renews the entry at the mail server; if it fails, it counts as not checked. */
async function renewEntry(
  accountId: string,
  worker: MailWorker,
  client: () => Promise<JmapClient>,
  store: MailPushStore,
  now: number,
): Promise<void> {
  if (now - (await store.renewedAt(accountId)) < RENEW_CHECK) return;
  const subscription = await worker.registration.pushManager.getSubscription();
  if (!subscription) return;
  const jmap = await client();
  const entries = await ownEntries(jmap, subscription.endpoint);
  await Promise.all(entries.filter((entry) => !isExpired(entry, now)).map((entry) => renewIfDue(jmap, entry, now)));
  await store.markRenewed(accountId, now);
}

function show(worker: MailWorker, notice: MailNotice): Promise<void> {
  return worker.registration.showNotification(notice.title, notice.options);
}

/** Otherwise closely following pushes of an account would overwrite each other's open notification. */
let showing: Promise<unknown> = Promise.resolve();

function inTurn(task: () => Promise<void>): Promise<void> {
  const turn = showing.then(task, task);
  showing = turn;
  return turn;
}

/** Visible app: list and counts arrive there, a notice would be duplicate. WebKit requires it anyway. */
async function acknowledge(worker: MailWorker, ctx: MailContext): Promise<void> {
  if (!worker.everyNotice) return;
  const tag = `${mailTag(ctx.id)}-seen`;
  const { title, options } = blindNotice({ ...ctx, silent: true });
  await show(worker, { title, options: { ...options, tag } });
  for (const notification of await worker.registration.getNotifications({ tag })) notification.close();
}

async function announce(
  worker: MailWorker,
  ctx: MailContext,
  push: PushObject | null,
  client: () => Promise<JmapClient>,
): Promise<void> {
  let mails: MailSummary[];
  try {
    mails = push?.type === 'EmailPush' ? await fetchMails(await client(), push) : [];
  } catch (error) {
    const reauth = error instanceof TokenRefused && error.status === 409 && error.code === 'needs_reauth';
    await inTurn(() => show(worker, reauth ? authNotice(ctx) : blindNotice(ctx)));
    return;
  }
  await inTurn(async () => {
    const open = await worker.registration.getNotifications({ tag: mailTag(ctx.id) });
    const all = mergeMails(
      mails,
      open.flatMap((notification) => openMails(notification.data)),
    );
    await show(worker, all.length > 0 ? mailNotice(all, ctx) : blindNotice(ctx));
  });
}

/**
 * Push in the registration of a mail account. Nothing appears for the
 * confirmation: it arrives while the app is visible. All open
 * windows learn about a new mail and sync right away; with the app visible
 * nothing else appears (`acknowledge`).
 */
export async function handleMailPush(accountId: string, raw: string | null, worker: MailWorker): Promise<void> {
  const object = parsePushObject(raw);
  const load = worker.load ?? workerClient;
  const windows = await worker.clients.matchAll(WINDOWS);
  if (object?.type === 'PushVerification') {
    await verifyPushSubscription(await load(accountId), object.pushSubscriptionId, object.verificationCode);
    for (const window of windows) {
      window.postMessage({ type: VERIFIED_MESSAGE, accountId, subscriptionId: object.pushSubscriptionId });
    }
    return;
  }
  for (const window of windows) window.postMessage({ type: MAIL_MESSAGE, accountId });
  const store = worker.store ?? mailPushStore;
  const now = worker.now ?? Date.now();
  const copy = await store.read().catch(() => null);
  // Texts in the app language; the base language without a copy or with an unknown language.
  const lang = copy?.lang && isLocale(copy.lang) ? copy.lang : baseLocale;
  overwriteGetLocale(() => lang);
  const ctx = mailContext(accountId, copy, worker, now);
  let loaded: Promise<JmapClient> | undefined;
  const client = () => (loaded ??= load(accountId));
  const visible = windows.some((window) => window.visibilityState === 'visible');
  await Promise.all([
    renewEntry(accountId, worker, client, store, now).catch(() => {}),
    visible ? acknowledge(worker, ctx) : announce(worker, ctx, object, client),
  ]);
}

/** The browser replaced or lost the subscription: update the entry at the mail server. */
export async function handleSubscriptionChange(
  accountId: string,
  manager: PushManager,
  change: { oldEndpoint: string | null; subscription: PushSubscription | null },
  load: LoadClient = workerClient,
): Promise<void> {
  const client = await load(accountId);
  const key = await serverKey(client);
  if (!key) return;
  if (change.oldEndpoint) await destroyEntries(client, change.oldEndpoint).catch(() => {});
  await createEntry(client, change.subscription ?? (await browserSubscription(manager, key)));
}
