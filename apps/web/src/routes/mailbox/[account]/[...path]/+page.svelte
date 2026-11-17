<!--
  Mailbox, folder or tag: list per `pfDesign` – "Soft" in date groups,
  "Compact" as a table sortable by sender or recipient or date – with the
  conversations from `threads`, skeleton after 150 ms. At a thread's address
  the message page with the emails from `message`; the view's list stays
  loaded meanwhile (position, paging, return). The layout shows the source
  dialog and on mobile "More actions" via `ui.pageDialog`. Star, read, delete,
  delete permanently, spam, restore and "Empty Trash" in rows and reading view
  run via `edits`; opening marks the shown emails as read. The reading view
  sets tags and moves: as a popover on desktop, on mobile from "More actions"
  (second level "Add tag", the move dialog with back). Multi-select with a
  selection bar (`pf.bulk`), also across "All accounts" (one toast, one
  `Email/set` per account), and the list focus (`pfFocus`): the last opened row
  stays highlighted and visible, on desktop ↑/↓ select a row and Enter opens
  it. Swipe gestures on the rows on mobile and tablet (`swL`/`swR`) like the
  row's quick actions; "Move to folder" opens the move dialog without back.
-->
<script module lang="ts">
  import { DEFAULT_SORT, draftOf, type ListSort, type Segment } from '#lib/mail-list.ts';

  /**
   * Segment (`pfFilter`) and sorting of the "Compact" form (`pfSort`, `pfDir`):
   * apply to all mailboxes until the page is left –
   * also across the switch between the layout's desktop and mobile branch, which
   * recreates the page.
   */
  const kept = $state<{ segment: Segment; sort: ListSort }>({ segment: 'all', sort: DEFAULT_SORT });
  /** Another route followed: the next instance starts with the default (the old one does not ask again). */
  const nav = { left: false };
</script>

<script lang="ts">
  import { goto, onNavigate } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import MailListCompact from '#lib/components/MailListCompact.svelte';
  import MailListSoft from '#lib/components/MailListSoft.svelte';
  import MessageMenu from '#lib/components/MessageMenu.svelte';
  import MessageView from '#lib/components/MessageView.svelte';
  import MoveDialog from '#lib/components/MoveDialog.svelte';
  import SourceDialog from '#lib/components/SourceDialog.svelte';
  import { copyPending } from '#lib/clipboard.svelte.ts';
  import { downloadBlob } from '#lib/download.ts';
  import { sourceFileName } from '#lib/mail-source.ts';
  import { allowSender } from '#lib/mail/remote-content.ts';
  import { mailRenderer } from '#lib/mail/renderer.svelte.ts';
  import ErrorView from '#lib/components/ErrorView.svelte';
  import Skeleton from '#lib/components/Skeleton.svelte';
  import { failText, isOffline, timeZoneOf } from '#lib/errors.ts';
  import {
    baseValues,
    listNotice,
    bySendAt,
    listOrder,
    nextSort,
    selectionValues,
    segmentsOf,
    threadRef,
    type BulkAction,
    type ListRow,
    type ListThread,
    type TimeContext,
  } from '#lib/mail-list.ts';
  import { SvelteSet } from 'svelte/reactivity';
  import type { SwipeAction } from '#lib/swipe.ts';
  import {
    cancelEdits,
    flagEdits,
    FLAGGED,
    folderEdits,
    inSource,
    notSpamEdits,
    purgeEdits,
    restoreEdits,
    SEEN,
    seenEdits,
    spamEdits,
    tagEdits,
    trashEdits,
    type ActionEmail,
    type ActionRoles,
    type Edits,
  } from '#lib/mail-actions.ts';
  import { appListView, isReachable } from '#lib/state/views.ts';
  import { network } from '#lib/state/network.svelte.ts';
  import {
    moveValues,
    readValues,
    shownEmails,
    sourceValues,
    type MoveTargets,
    type ReadAttachment,
    type ReadMoveOption,
  } from '#lib/message-view.ts';
  import { sidebarScope } from '#lib/mailbox-nav.ts';
  import { m } from '#lib/paraglide/messages.js';
  import { ALL_ACCOUNTS, mailboxParams, parseMailboxPath, type RoleId } from '#lib/routes.ts';
  import { followGone, openList, openThread, threadHref } from '#lib/thread-nav.ts';
  import { returnLabel, returnToSearch } from '#lib/search-return.ts';
  import { search } from '#lib/state/search.svelte.ts';
  import { accounts } from '#lib/state/accounts.svelte.ts';
  import { compose, draftRef, NEW_DRAFT, parseMailto, replyInit, type ComposeNav } from '#lib/state/compose.svelte.ts';
  import { modKey } from '#lib/keys.ts';
  import { replyValues, type ReplyActions, type ReplyMode, type ReplyState } from '#lib/reply.ts';
  import { LOCAL_DRAFT } from '#lib/state/edit-queue.svelte.ts';
  import { edits, lacksAccess, refusedBy, type EditPart } from '#lib/state/edits.svelte.ts';
  import { planActions } from '#lib/state/plan-actions.ts';
  import { folders, type FolderLeaveNav } from '#lib/state/folders.svelte.ts';
  import { tagEdit } from '#lib/state/tag-edit.svelte.ts';
  import { mailboxes } from '#lib/state/mailboxes.svelte.ts';
  import {
    listEmail,
    message,
    PREFETCH_DELAY,
    type Conversation,
    type MessageEmail,
    type MessageSource,
  } from '#lib/state/message.svelte.ts';
  import { prefs } from '#lib/state/prefs.svelte.ts';
  import { scheduled } from '#lib/state/scheduled.svelte.ts';
  import { TagFixError, tags } from '#lib/state/tags.svelte.ts';
  import { tagFixError } from '#lib/tag-fix.ts';
  import { threads, type ThreadList } from '#lib/state/threads.svelte.ts';
  import { Loading, ui } from '#lib/state/ui.svelte.ts';

  const location = $derived(parseMailboxPath(page.url.pathname));
  const scope = $derived(sidebarScope(accounts.list, prefs.values.defaultAccount, location));
  /** Accounts of the view, also without access: those read from storage. */
  const viewAccounts = $derived(scope.all ? (accounts.list ?? []) : scope.account ? [scope.account] : []);
  const view = $derived(location && accounts.list ? appListView(location, viewAccounts, scope.all) : null);

  /** Segment of the view: the selected one, as long as there is one there. */
  const segment = $derived(view && segmentsOf(view.kind).includes(kept.segment) ? kept.segment : 'all');
  if (nav.left) Object.assign(kept, { segment: 'all', sort: DEFAULT_SORT });
  nav.left = false;
  onNavigate(({ from, to }) => {
    if (to?.route.id !== from?.route.id) nav.left = true;
  });

  const compact = $derived(prefs.values.pfDesign === 'compact');
  /** Column header of the last click: the list is recreated and gives the focus back to it until the view changes. */
  let sortFocus = $state<ListSort['key'] | null>(null);
  $effect(() => {
    void [page.url.pathname, kept.segment, compact];
    sortFocus = null;
  });
  const order = $derived(view ? listOrder(view.kind, compact, kept.sort) : null);

  /** Key of the list: the same sources keep the same list, even if mailbox counters change. */
  const key = $derived(
    view?.sources && !view.unavailable ? JSON.stringify([view.sources, segment, order, segmentsOf(view.kind)]) : null,
  );
  let list = $state.raw<ThreadList | null>(null);
  const loading = new Loading();

  $effect(() => {
    if (!key) {
      list = null;
      return;
    }
    untrack(() => {
      const sources = view?.sources;
      if (!view || !sources || !order) return;
      const multi = view.multi;
      // Sorted differently from the default: only takes the sorted list's slot in the cache.
      const sorted = JSON.stringify(order) !== JSON.stringify(listOrder(view.kind, false));
      const opened = threads.open(sources, segment, order, segmentsOf(view.kind), sorted);
      list = opened.list;
      if (opened.cached) {
        // Back in a list: sync in the background, report errors as when reopening a list.
        if (opened.list.status === 'loading') return;
        void opened.list.refresh().then(({ failed }) => {
          // Without a connection the list from storage shows; the notice bar says so.
          if (failed && !isOffline(opened.list.failure))
            ui.toasts.error(multi && failed < sources.length ? m.list_refresh_partial() : m.error_list());
        });
        return;
      }
      loading
        .run(opened.list.ready)
        .then(() => {
          if (multi && opened.list.failed.length) ui.toasts.show(m.list_refresh_partial());
        })
        .catch((error: unknown) => {
          // The empty state shows folders without storage.
          if (!isOffline(error)) ui.toasts.error(failText(error, m.error_list()));
        });
    });
  });

  // While mailboxes or tags of the view load, the skeleton counts too.
  const waiting = $derived(view !== null && view.sources === null);
  $effect(() => {
    if (!waiting) return;
    let release = () => {};
    untrack(() => void loading.run(new Promise<void>((r) => (release = r))));
    return () => release();
  });

  /** Clock for "Today", "Yesterday" and the times; renewed every minute. */
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 60_000);
    return () => clearInterval(timer);
  });
  const time: TimeContext = $derived({
    now,
    tz: timeZoneOf(prefs.values),
    timeFmt: prefs.values.timeFmt,
    weekStart: prefs.values.weekStart,
    dateFmt: prefs.values.dateFmt,
  });

  const tagMaps = $derived(Object.fromEntries(viewAccounts.map((a) => [a.id, tags.byMailbox(a.id)])));

  /**
   * Selected conversations (`pfSel`, `threadRef()`); only those of the list
   * count. Another view or another segment starts without (`setF`),
   * another sorting keeps them.
   */
  let selected = $state.raw<ReadonlySet<string>>(new Set());
  const selectionKey = $derived(JSON.stringify([view?.sources ?? null, segment]));
  $effect(() => {
    void selectionKey;
    selected = new Set();
  });

  /** Last opened or ↑/↓-selected conversation (`pfFocus`); another view starts without. */
  let focus = $state<string | null>(null);
  const focusKey = $derived(JSON.stringify(view?.sources ?? null));
  $effect(() => {
    void focusKey;
    focus = null;
  });

  /** Send time of scheduled emails from the "Scheduled" sync. */
  const sendAt = (account: string, email: string, boxes: readonly string[]) => scheduled.sendAt(account, email, boxes);

  /** Threads of the list while the view is available; in "Scheduled" by send time. */
  const shownThreads = $derived(
    list && view && order && !view.unavailable ? bySendAt(list.threads, view.kind, order, sendAt) : [],
  );

  /** Values of the list without selection and focus: checkboxes and ↑/↓ do not recompute the rows (`selectionValues`). */
  const basePf = $derived.by(() => {
    if (!view || (!view.unavailable && (!list || list.status === 'loading'))) return null;
    const values = baseValues({
      kind: view.kind,
      title: view.title,
      segment,
      threads: shownThreads,
      counts: list && !view.unavailable ? list.counts : { all: null, unread: null, flagged: null },
      total: list && !view.unavailable ? list.total : 0,
      multi: view.multi,
      accountOf: (id) => accounts.list?.find((a) => a.id === id),
      tagOf: (account, box) => tagMaps[account]?.get(box),
      time,
      compact,
      sort: kept.sort,
      sendAt,
      outboxOf,
      swipe: ui.swipeOn ? { left: prefs.values.swL, right: prefs.values.swR } : null,
    });
    // No empty state without an account's response: the list is not empty but unknown.
    const failed = view.unavailable || list?.status === 'error';
    // Without `calculateTotal` the record names no count; the rows count anyway.
    const tot = view.unavailable ? 0 : list?.counts.all || shownThreads.length;
    return listNotice(failed ? { ...values, empty: false } : values, tot, {
      accounts: viewAccounts,
      offline: network.offline,
      unsaved: failed && (network.offline || isOffline(list?.failure)),
      // If more can be loaded, nothing is missing: `navigator.onLine` reports `false` permanently in a LAN without a default route.
      truncated: !!list?.truncated && !list.hasMore,
    });
  });

  /** The view's account if there is only one (`solo`). */
  const onlyAccount = $derived(viewAccounts.length === 1 ? viewAccounts[0] : null);

  /** "Sign in again" or "Go to connection": one account directly, otherwise the list of accounts (`goAcct`). */
  function goAccount() {
    const only = onlyAccount;
    void goto(
      only ? resolve('/account/mail-accounts/[id]/connection', { id: only.id }) : resolve('/account/mail-accounts'),
    );
  }
  const pf = $derived(
    basePf && view ? selectionValues(basePf, { kind: view.kind, threads: shownThreads, selected, focus }) : null,
  );

  /**
   * Address of a thread: in "All accounts" with its account (`<account>/<thread>`
   * as one part). A draft opens compose with it (`pfOpen`).
   */
  function open(row: Pick<ListRow, 'account' | 'threadId' | 'id'>) {
    if (!location) return;
    if (opensCompose(row)) {
      void openDraft(row.account, row.id);
      return;
    }
    openThread(location, row.account, row.threadId);
  }

  /** Row, J/K or arrow button opens compose: every row in "Drafts", elsewhere if the row's email is a draft. */
  function opensCompose(row: Pick<ListRow, 'account' | 'threadId' | 'id'>): boolean {
    if (location && 'role' in location && location.role === 'drafts') return true;
    const t = shownThreads.find((t) => t.account === row.account && t.threadId === row.threadId);
    return !!t && draftOf(t, rolesOf(row.account).drafts);
  }

  /** Compose with a draft, back to `from`: from an open conversation "Back to message" (`r.pfMsg`), otherwise the view. */
  async function openDraft(account: string, id: string, sendAt?: number, from?: string) {
    const here = page.url.pathname + page.url.search;
    const href = from ?? here;
    const ret = {
      href,
      label: opened && href === here ? m.compose_back_message() : (view?.title ?? m.mailbox_inbox()),
    };
    if (await compose.openDraft(account, id, ret, sendAt))
      void goto(resolve('/compose/[draft]', { draft: encodeURIComponent(draftRef({ account, id })) }));
  }

  /** `mailto:` link in a message: compose with its account, back "Back to message". */
  function writeTo(href: string) {
    const init = parseMailto(href);
    if (!init) return;
    const ret = { href: page.url.pathname + page.url.search, label: m.compose_back_message() };
    if (compose.start({ ...init, account: opened?.account ?? null }, ret))
      void goto(resolve('/compose/[draft]', { draft: NEW_DRAFT }));
  }

  const replyActions: ReplyActions = {
    open: openReply,
    mode: (mode) => setReply({ mode }),
    text: (text) => setReply({ text }),
    to: (to) => setReply({ to }),
    send: sendReply,
    cancel: () => (reply = null),
    expand: () => expandReply(),
    files: (files) => expandReply(files),
  };

  let busy = $state(false);

  async function refresh() {
    const current = list;
    const only = onlyAccount;
    if (only && !isReachable(only)) {
      ui.toasts.error(
        only.blocked
          ? m.mail_account_check_blocked({ host: only.host })
          : m.mail_account_check_auth({ host: only.host }),
      );
      return;
    }
    if (view?.unavailable) {
      // Reload the view's mailboxes; the sidebar shows "Sign-in required".
      if (network.offline) ui.toasts.error(m.error_offline());
      for (const a of viewAccounts.filter(isReachable))
        if (mailboxes.of(a.id)?.status === 'error') void mailboxes.load(a.id).catch(() => {});
      void tags.ensure().catch(() => {});
      return;
    }
    if (busy || !current || !view) return;
    busy = true;
    // Sync pill while the request runs.
    ui.syncing = true;
    const multi = view.multi;
    // The icon spins at least one turn, even if the response comes faster.
    const spin = new Promise((r) => setTimeout(r, 600));
    try {
      const { added, failed } = await current.refresh();
      if (failed) {
        if (multi && failed < current.sources.length) ui.toasts.show(m.list_refresh_partial());
        else ui.toasts.error(failText(current.failure, m.error_list()));
      } else if (!added)
        ui.toasts.show(viewAccounts.every(isReachable) ? m.list_refresh_none() : m.list_refresh_partial());
    } finally {
      await spin;
      busy = false;
      ui.syncing = false;
    }
  }

  function more() {
    list?.loadMore().catch((error: unknown) => ui.toasts.error(failText(error, m.error_list())));
  }

  // --- Message ---

  /** Account and thread from the address; in "All accounts" the part is `<account>/<thread>`. */
  const opened = $derived.by(() => {
    if (!location?.thread) return null;
    if (location.account !== ALL_ACCOUNTS) return { account: location.account, threadId: location.thread };
    const cut = location.thread.indexOf('/');
    return cut > 0 ? { account: location.thread.slice(0, cut), threadId: location.thread.slice(cut + 1) } : null;
  });
  /** Account of the conversation: `undefined` while the mail accounts load, `null` if the account does not exist. */
  const threadAccount = $derived(
    opened && accounts.list ? (accounts.list.find((a) => a.id === opened.account) ?? null) : undefined,
  );
  /** The browser may reach the account; "Sign-in required" and locked servers only read from storage. */
  const usable = $derived(!!threadAccount && threadAccount.state === 'ok' && !threadAccount.blocked);
  // Only load with a known account (address opened directly or reloaded).
  const threadKey = $derived(
    opened && threadAccount ? JSON.stringify([opened.account, opened.threadId, usable]) : null,
  );
  let conversation = $state.raw<Conversation | null>(null);

  // The live sync syncs the shown list and conversation at once.
  $effect(() => {
    if (list) return threads.show(list);
  });
  $effect(() => {
    if (conversation) return message.show(conversation);
  });
  const reading = new Loading();
  /** Expanded and collapsed emails (`pfTh`); another conversation starts afresh. */
  let folds = $state<Record<string, boolean>>({});

  $effect(() => {
    // Another conversation or the list closes menus, popovers and source (`pfOpen`, `pfClose`, `stopM`).
    sheet = null;
    untrack(() => {
      closeSource();
      if (ui.menu === 'rdtag' || ui.menu === 'rdmove') ui.closeMenu();
    });
    if (!threadKey) {
      conversation = null;
      return;
    }
    untrack(() => {
      if (!opened) return;
      folds = {};
      marked.clear();
      const { conversation: c, cached } = message.open(opened.account, opened.threadId, !usable);
      conversation = c;
      // Back in a conversation: reload in the background (new replies, keywords).
      if (cached && c.status !== 'loading') void c.refresh().catch(() => {});
      else void reading.run(c.ready).catch(() => {});
    });
  });

  // While the mail accounts load, the message skeleton counts too.
  $effect(() => {
    if (!opened || threadAccount !== undefined) return;
    let release = () => {};
    untrack(() => void reading.run(new Promise<void>((r) => (release = r))));
    return () => release();
  });

  /** Place of the conversation in the loaded list: representative email, position, neighbours. */
  const inList = $derived.by(() => {
    if (!opened || !list || view?.unavailable) return null;
    // Order of the list, so in "Scheduled" by send time.
    const index = shownThreads.findIndex((t) => t.account === opened.account && t.threadId === opened.threadId);
    if (index < 0) return null;
    return { index, threads: shownThreads, total: Math.max(list.total, list.threads.length), hasMore: list.hasMore };
  });

  /** Row of the conversation in the list (`rm`). */
  const listRow = $derived(inList ? (inList.threads[inList.index] ?? null) : null);
  /** Representative email of the conversation in the list. */
  const repId = $derived(listRow?.id ?? null);

  /** Emails of the reading view: from the server or from storage, otherwise the list row without text. */
  const readEmails = $derived.by(() => {
    if (conversation?.status === 'ready') return conversation.emails;
    return conversation?.unreachable && listRow ? [listEmail(listRow)] : null;
  });

  /** The view's list is not there yet: it may still bring the conversation's row. */
  const listPending = $derived(!view || (!view.unavailable && (!list || list.status === 'loading')));

  // Account without access and the list does not know the conversation either: back, notice and empty state are there.
  $effect(() => {
    if (threadAccount && !usable && conversation?.unreachable && !listRow && !listPending) untrack(() => toList(true));
  });

  // Keep the top conversations for later, not while the list is still building.
  $effect(() => {
    if (!list || list.status !== 'ready' || !shownThreads.length) return;
    const rows = shownThreads.filter((t) => {
      const account = accounts.list?.find((a) => a.id === t.account);
      return account?.state === 'ok' && !account.blocked;
    });
    const timer = setTimeout(() => void message.prefetch(rows), PREFETCH_DELAY);
    return () => clearTimeout(timer);
  });

  /** Open popover of the reading view (desktop); other shell menus do not recompute the reading view. */
  const readMenu = $derived(ui.menu === 'rdtag' ? 'tag' : ui.menu === 'rdmove' ? 'move' : null);

  /** Return path to the search while this conversation is the one opened from it. */
  const searchBack = $derived(search.returnAt(page.url.pathname));

  const rd = $derived.by(() => {
    if (!opened || !view || !conversation || !readEmails) return null;
    // While paging, the previous conversation still hangs until the effect.
    if (conversation.account !== opened.account || conversation.threadId !== opened.threadId) return null;
    // All emails deleted: the effect below leads to the list.
    if (!readEmails.length) return null;
    const account = threadAccount ?? undefined;
    return readValues({
      emails: readEmails,
      repId,
      kind: view.kind,
      // Opened from the search: its way back instead of the folder (`navRet.label`).
      title: searchBack ? returnLabel(searchBack.kind) : view.title,
      account,
      roles: rolesOf(opened.account),
      multi: view.multi,
      tagOf: (box) => tagMaps[opened.account]?.get(box),
      menu: readMenu,
      // Tag list and targets only while a popover or the "Add tag" level shows them.
      tagTree: readMenu === 'tag' || sheet === 'tag' ? tags.tree([opened.account]) : [],
      tagPending: pendingTags(opened.account, opened.threadId),
      move: readMenu === 'move' ? moveTargets(opened.account, viewEmails) : NO_TARGETS,
      time,
      sendAt: (email, boxes) => scheduled.sendAt(opened.account, email, boxes),
      folds,
      dark: ui.dark,
      inverted: ui.readInverted,
      isMobile: ui.isMobile,
      ext: { extMode: prefs.values.extMode, extAllow: prefs.values.extAllow },
      once: conversation.once,
      render: mailRenderer.current,
      images: conversation.images,
      loadingFull: conversation.loadingFull,
      offline: network.offline || !usable,
      nav: inList
        ? {
            index: inList.index,
            total: inList.total,
            hasPrev: inList.index > 0,
            hasNext: inList.index < inList.threads.length - 1 || inList.hasMore,
          }
        : null,
    });
  });

  // `render.ts` with DOMPurify is not part of the list's first load: it loads with the first
  // open conversation, otherwise it preloads when idle. Until then the reading view shows no HTML document.
  // Closing the conversation or leaving the page withdraws the need (no more reloading).
  $effect(() => {
    if (!opened) {
      untrack(() => mailRenderer.preload());
      return;
    }
    untrack(() => void mailRenderer.load());
    return () => mailRenderer.release();
  });

  /** Open reply bar (`pfRp`); only applies to the email it replies to. */
  let reply = $state.raw<ReplyState | null>(null);
  const rp = $derived(rd ? replyValues(rd.reply, reply, modKey(), network.offline) : null);
  const canReply = $derived(rd?.canReply ?? false);

  /**
   * Another conversation (or none) closes the bar (`select`, `pfOpen`);
   * a short change of the account state does not (`threadKey` depends on `usable`).
   */
  const replyKey = $derived(opened ? JSON.stringify([opened.account, opened.threadId]) : null);
  $effect.pre(() => {
    void replyKey;
    untrack(() => (reply = null));
  });

  /** Reply, reply all, forward (`pfReply`): opens the bar or switches the kind, the text stays. */
  function openReply(mode: ReplyMode) {
    if (!rd?.canReply) return;
    reply = reply ? { ...reply, mode } : { mode, text: '', to: '' };
  }

  function setReply(patch: Partial<Pick<ReplyState, 'mode' | 'text' | 'to'>>) {
    if (reply) reply = { ...reply, ...patch };
  }

  const replyRet = () => ({ href: page.url.pathname + page.url.search, label: m.compose_back_message() });

  /**
   * "Open in editor" (`rp.expand`) or add attachment (`rp.attach`, with
   * the chosen files): compose with kind, text and quote of the bar.
   */
  function expandReply(files: readonly File[] = []) {
    if (!rd || !opened) return;
    const state = reply ?? { mode: 'reply' as const, text: '', to: '' };
    if (!compose.start(replyInit(rd.reply, state, opened.account), replyRet())) return;
    if (files.length) void compose.addFiles(files);
    reply = null;
    void goto(resolve('/compose/[draft]', { draft: NEW_DRAFT }));
  }

  /**
   * Sending from the bar (`rp.send`, also ‹mod› + Enter): without compose,
   * undo opens it. Without a connection only the error
   * toast comes before checking the text; the text stays in the bar.
   */
  function sendReply() {
    if (!rd || !opened || !rp || !reply) return;
    if (rp.sendOff) return compose.refuseReply();
    if (!rp.can) return;
    const state = reply;
    const nav: ComposeNav = {
      leave: () => {},
      reopen: () => void goto(resolve('/compose/[draft]', { draft: encodeURIComponent(compose.ref ?? NEW_DRAFT) })),
    };
    const sent = state.mode === 'fwd' ? m.read_forward_sent() : m.read_reply_sent();
    if (compose.sendNow(replyInit(rd.reply, state, opened.account), replyRet(), nav, sent)) reply = null;
  }

  // --- Actions: star, read, delete, spam, restore ---

  /** Role mailboxes of an account. */
  function rolesOf(account: string): ActionRoles {
    const id = (r: RoleId) => mailboxes.role(account, r)?.id ?? null;
    return {
      inbox: id('inbox'),
      sent: id('sent'),
      drafts: id('drafts'),
      scheduled: id('scheduled'),
      trash: id('trash'),
      spam: id('spam'),
    };
  }
  /** Sent, drafts or scheduled among a conversation's mailboxes (swipe gestures in tag views). */
  function outboxOf(account: string, mailboxIds: readonly string[]) {
    const roles = rolesOf(account);
    const has = (r: 'sent' | 'drafts' | 'scheduled') => !!roles[r] && mailboxIds.includes(roles[r]);
    return has('scheduled') ? 'scheduled' : has('drafts') ? 'drafts' : has('sent') ? 'sent' : null;
  }

  /** An email keeps its tags when moved (trash, spam, back). */
  const tagCheck = (account: string) => (box: string) => !!tagMaps[account]?.has(box);
  /** Mailboxes of the view in the account; `null` while they are missing. */
  const sourceOf = (account: string) => view?.sources?.find((s) => s.account === account) ?? null;
  const isTrashView = $derived(!!view && 'role' in view.kind && view.kind.role === 'trash');
  const isSpamView = $derived(!!view && 'role' in view.kind && view.kind.role === 'spam');
  const ownOf = (account: string) => accounts.list?.find((a) => a.id === account)?.email ?? '';

  /** An action without effect (role mailbox missing, view mailboxes still loading): report, close nothing. */
  const nothing = (account?: string) => {
    // An account without access or a draft only on the device has already been reported by `edits`;
    // this toast would replace the right one.
    if (ui.toast?.text === m.error_offline()) return;
    if (!account || !lacksAccess(account)) ui.toasts.error(m.error_act());
  };

  /** "Delete permanently" with confirmation; then at once, without undo. */
  function purge(account: string, emails: readonly ActionEmail[], done?: () => void) {
    const changes = purgeEdits(emails, rolesOf(account).trash, tagCheck(account));
    if (!changes.size) return nothing();
    ui.ask({
      title: m.list_purge_title(),
      text: m.list_purge_text(),
      icon: 'ti-trash-x',
      ok: m.list_purge(),
      danger: true,
      run: () => {
        edits.purge(account, changes, m.list_purged());
        done?.();
      },
    });
  }

  /**
   * Parts for deleting per account: scheduled emails cancel sending when
   * executed and go to the trash with `$draft` (`planCommit`, ADR
   * 0040 › 3), the rest as usual. `planned`: only scheduled ones change
   * (own texts). `null` if an account with scheduled emails must sign in
   * first (`planStale`, the notice is already shown).
   */
  function trashParts(groups: readonly { account: string; emails: readonly ActionEmail[] }[]) {
    const parts: EditPart[] = [];
    const stale: string[] = [];
    for (const { account, emails } of groups) {
      const roles = rolesOf(account);
      const tag = tagCheck(account);
      parts.push({ account, edits: trashEdits(emails, roles, tag) });
      const plan = planActions.trashPart({ account, emails, roles }, tag);
      if (plan) {
        parts.push(plan);
        stale.push(account);
      }
    }
    if (refusedBy(stale)) return null;
    const live = parts.filter((p) => p.edits.size);
    const planned = live.length > 0 && live.every((p) => !!p.send);
    // Own error text only if everything is scheduled; when mixed, the ordinary `Email/set` can fail too.
    return { parts, planned, failed: planned ? m.plan_cancel_failed() : undefined };
  }

  /** Delete: to the trash with undo, permanently in the trash. */
  function trash(account: string, emails: readonly ActionEmail[], done?: () => void) {
    if (isTrashView) {
      purge(account, emails, done);
      return;
    }
    const t = trashParts([{ account, emails }]);
    if (!t) return;
    const text = t.planned ? m.plan_trashed() : m.list_trashed();
    if (edits.runAll(t.parts, { text, failed: t.failed })) done?.();
    else nothing(account);
  }

  /**
   * If restoring leads everything to drafts (e.g. deleted scheduled
   * messages), the toast says so (`PLAN_TXT.restored`). The app
   * does not distinguish a deleted draft from that: both carry `$draft`.
   */
  function toDrafts(parts: readonly { account: string; edits: Edits }[]): boolean {
    const live = parts.filter((p) => p.edits.size);
    return (
      live.length > 0 &&
      live.every((p) => {
        const drafts = rolesOf(p.account).drafts;
        return !!drafts && [...p.edits.values()].every((e) => e.mailboxIds?.[drafts] === true);
      })
    );
  }

  function restore(account: string, emails: readonly ActionEmail[], done?: () => void) {
    const changes = restoreEdits(emails, rolesOf(account), tagCheck(account), ownOf(account));
    const text = toDrafts([{ account, edits: changes }]) ? m.plan_restored() : m.list_restored();
    if (edits.run({ account, edits: changes, text })) done?.();
    else nothing(account);
  }

  /** Row: its conversation and its emails in the view; `null` if it is no longer in the list. */
  function rowTarget(row: ListRow) {
    const t = list?.threads.find((x) => x.key === row.key);
    return t ? targetOf(t) : null;
  }

  /**
   * Conversation with the emails of its actions: in the view
   * (`scope`) and the representative one (`rep`); `null` while the view's
   * mailboxes are missing in the account. For row and selection bar.
   */
  function targetOf(t: ListThread) {
    const source = sourceOf(t.account);
    if (!source) return null;
    return {
      t,
      rep: t.members.filter((e) => e.id === t.id),
      scope: t.members.filter((e) => inSource(e.mailboxIds, source)),
    };
  }
  type Target = NonNullable<ReturnType<typeof targetOf>>;

  /** Star of the row, without toast: flags the representative email, unflags all of the view. */
  function rowStar(row: ListRow) {
    const r = rowTarget(row);
    if (r) edits.run({ account: r.t.account, edits: r.t.flagged ? flagEdits(r.scope, false) : flagEdits(r.rep, true) });
  }

  /**
   * Read or unread (`r.onRead`), without toast: all of the view read,
   * the representative one unread. In "Scheduled" at the same place "Cancel
   * send" (`pfCancel`), at once and without compose.
   */
  function rowRead(row: ListRow) {
    const r = rowTarget(row);
    if (!r) return;
    if (row.sched) {
      void cancel([{ account: r.t.account, emails: r.scope }]);
      return;
    }
    edits.run({ account: r.t.account, edits: r.t.unread ? seenEdits(r.scope, true) : seenEdits(r.rep, false) });
  }

  /**
   * "Cancel send" across accounts (row, selection bar, reading view): at once, without undo. `onStart` runs as soon as it starts (the
   * reading view then closes); without a scheduled email `nothing()` reports it.
   */
  async function cancel(groups: readonly { account: string; emails: readonly ActionEmail[] }[], onStart?: () => void) {
    const parts = groups.map((g) => ({ ...g, roles: rolesOf(g.account) }));
    const done = await planActions.cancel(parts, onStart);
    if (done === null) nothing();
    return done ?? [];
  }

  function rowDel(row: ListRow) {
    const r = rowTarget(row);
    if (r) trash(r.t.account, r.scope);
  }

  function rowRestore(row: ListRow) {
    const r = rowTarget(row);
    if (r) restore(r.t.account, r.scope);
  }

  /**
   * Swipe gesture of the row (`swMap[id].L/R.fn`): like its quick actions;
   * spam as in the reading view, "Move to folder" opens
   * the move dialog for the row (`mvPick`, without back).
   */
  function rowSwipe(row: ListRow, action: SwipeAction) {
    if (action.key === 'del') rowDel(row);
    else if (action.key === 'read') rowRead(row);
    else if (action.key === 'star') rowStar(row);
    else if (action.key === 'spam') {
      const r = rowTarget(row);
      if (r) spam(r.t.account, r.scope);
    } else if (rowTarget(row)) movePick = row.key;
  }

  /** Account and id of the open folder (in "All accounts" its account); otherwise `null`. */
  const openFolder = $derived(
    location && 'folder' in location
      ? { account: location.account === ALL_ACCOUNTS ? (location.owner ?? '') : location.account, id: location.folder }
      : null,
  );

  /** Targets after deleting a folder or tag: the view's inbox, undo goes back. */
  function folderNav(): FolderLeaveNav {
    const account = location?.account ?? ALL_ACCOUNTS;
    const before = page.url.pathname;
    return {
      inbox: () => void goto(resolve('/mailbox/[account]/[...path]', mailboxParams(account, { role: 'inbox' }))),
      // eslint-disable-next-line svelte/no-navigation-without-resolve -- the page's address is already resolved
      restore: () => void goto(before),
    };
  }

  /** "Edit folder" and "Delete folder" in the list header (`fEdit`, `fDel`). */
  function folderEdit() {
    if (openFolder) folders.edit(openFolder.account, openFolder.id);
  }
  function folderDelete() {
    if (openFolder) folders.remove(openFolder.account, openFolder.id, folderNav());
  }

  /** "Edit tag" and "Delete tag" in the list header (`tEdit`, `tDel`); deleting leads to the inbox as for folders. */
  function tagEditOpen() {
    if (location && 'tag' in location) tagEdit.edit(location.tag);
  }
  function tagDelete() {
    if (!location || !('tag' in location)) return;
    const tag = location.tag;
    // After the count only if the view still shows the tag.
    void tagEdit.remove(tag, () => (location && 'tag' in location && location.tag === tag ? folderNav() : null));
  }

  /** "Empty Trash" (`pf.clear`): per account of the view, the loaded ones disappear at once. */
  function clearTrash() {
    const current = list;
    if (!current || !isTrashView || refusedBy(current.sources.map((s) => s.account))) return;
    const n = current.counts.all ?? current.total;
    ui.ask({
      title: m.list_clear_title(),
      text: m.list_purge_text(),
      icon: 'ti-trash-x',
      ok: m.list_purge(),
      danger: true,
      run: () => {
        ui.toasts.show(n === 1 ? m.list_purged() : m.list_purged_n({ n }));
        for (const source of current.sources) {
          const box = mailboxes.role(source.account, 'trash')?.id;
          if (!box) continue;
          const shown = current.threads
            .filter((t) => t.account === source.account)
            .flatMap((t) => t.members.filter((e) => inSource(e.mailboxIds, source)));
          const keep = tagCheck(source.account);
          edits
            .clear(source.account, box, purgeEdits(shown, box, keep), keep)
            .catch((error: unknown) => ui.toasts.error(failText(error)))
            .finally(() => void current.refresh(source.account));
        }
      },
    });
  }

  // --- Selection: checkboxes, "Select all" and selection bar (`pf.bulk`), also across "All accounts" ---

  /** Checkbox of the row (`r.onSel`, `pfToggleSel`). */
  function toggleSelect(row: ListRow) {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- immutable copy, `selected` is the state
    const next = new Set(selected);
    if (!next.delete(row.ref)) next.add(row.ref);
    selected = next;
  }

  /** "Select all" or "Clear selection" (`pf.chkAll`): all loaded conversations of the list. */
  function selectAll() {
    selected = pf?.chkAll.all ? new Set() : new Set(list?.threads.map(threadRef));
  }

  const clearSelection = () => (selected = new Set());

  // Conversations that leave the list (sync, own actions) drop out of the selection; if they return, they are no longer selected.
  $effect(() => {
    const shown = new Set(list?.threads.map(threadRef));
    untrack(() => {
      if ([...selected].some((r) => !shown.has(r))) selected = new Set([...selected].filter((r) => shown.has(r)));
    });
  });

  /** Selected conversations of the list per account; without the view's mailboxes an account is left out. */
  function picked(): Map<string, Target[]> {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local grouping, no state
    const out = new Map<string, Target[]>();
    for (const t of list?.threads ?? []) {
      const target = selected.has(threadRef(t)) ? targetOf(t) : null;
      if (!target) continue;
      const items = out.get(t.account);
      if (items) items.push(target);
      else out.set(t.account, [target]);
    }
    return out;
  }

  /**
   * Buttons of the selection bar: which emails of a conversation
   * they hit, what they change per account, and for delete, restore and
   * delete permanently the text with the count (with `ask` after a confirmation).
   */
  const BULK: Record<
    BulkAction,
    {
      emails: (p: Target) => ActionEmail[];
      edits: (account: string, emails: ActionEmail[]) => Edits;
      text?: (n: number) => string;
      ask?: (n: number) => string;
    }
  > = {
    read: { emails: (p) => p.scope, edits: (_, e) => seenEdits(e, true) },
    unread: { emails: (p) => p.rep, edits: (_, e) => seenEdits(e, false) },
    flag: { emails: (p) => (p.t.flagged ? [] : p.rep), edits: (_, e) => flagEdits(e, true) },
    unflag: { emails: (p) => p.scope, edits: (_, e) => flagEdits(e, false) },
    cancel: { emails: (p) => p.scope, edits: (a, e) => cancelEdits(e, rolesOf(a)) },
    trash: {
      emails: (p) => p.scope,
      edits: (a, e) => trashEdits(e, rolesOf(a), tagCheck(a)),
      text: (n) => (n === 1 ? m.list_trashed() : m.list_trashed_n({ n })),
    },
    restore: {
      emails: (p) => p.scope,
      edits: (a, e) => restoreEdits(e, rolesOf(a), tagCheck(a), ownOf(a)),
      text: (n) => (n === 1 ? m.list_restored() : m.list_restored_n({ n })),
    },
    purge: {
      emails: (p) => p.scope,
      edits: (a, e) => purgeEdits(e, rolesOf(a).trash, tagCheck(a)),
      text: (n) => (n === 1 ? m.list_purged() : m.list_purged_n({ n })),
      ask: (n) => (n === 1 ? m.list_purge_title() : m.list_purge_title_n({ n })),
    },
  };

  /**
   * Button of the selection bar (`pf.bulk[].onClick`), across the selection's accounts
   * with one toast. Read and flag run without toast, the selection
   * stays. Delete and restore have undo, which also brings back the
   * selection (`pfMove`) as long as it is unchanged since;
   * delete permanently runs after the confirmation (`pfPurge`). Only
   * conversations that change count: the rest (e.g. scheduled ones or those in an
   * account without trash) stay selected; without any, `nothing()` reports it.
   */
  function bulk(action: BulkAction) {
    const spec = BULK[action];
    const all = [...picked()];
    // Drafts only on the device do not exist on the server yet: they do not count and stay selected.
    const groups = all
      .map(([account, items]) => [account, items.filter((p) => !p.t.id.startsWith(LOCAL_DRAFT))] as const)
      .filter(([, items]) => items.length > 0);
    if (!groups.length && all.length) {
      ui.toasts.error(network.offline ? m.error_offline() : m.error_act());
      return;
    }
    const emails = groups.map(([account, items]) => ({ account, emails: items.flatMap(spec.emails) }));
    // Deleting cancels sending for scheduled emails (own parts, `trashParts`).
    const trashing = action === 'trash' ? trashParts(emails) : null;
    if (action === 'trash' && !trashing) return;
    const parts: EditPart[] =
      trashing?.parts ?? emails.map((g) => ({ account: g.account, edits: spec.edits(g.account, g.emails) }));
    const changed = groups.flatMap(([account, items]) =>
      items.filter((p) => spec.emails(p).some((e) => parts.some((x) => x.account === account && x.edits.has(e.id)))),
    );
    const n = changed.length;
    const { ask } = spec;
    const text = trashing?.planned
      ? (k: number) => (k === 1 ? m.plan_trashed() : m.plan_trashed_n({ n: k }))
      : action === 'restore' && toDrafts(parts)
        ? (k: number) => (k === 1 ? m.plan_restored() : m.plan_restored_n({ n: k }))
        : spec.text;
    if (action === 'cancel') {
      if (!n) return nothing();
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- immutable copy, `selected` is the state
      const rest = new Set(selected);
      for (const p of changed) rest.delete(threadRef(p.t));
      // At once and without undo: the cancelled ones leave the selection (`pfCancel`).
      void cancel(emails, () => (selected = rest));
      return;
    }
    if (!text) {
      edits.runAll(parts);
      return;
    }
    if (!n) return nothing();
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- immutable copy, `selected` is the state
    const rest = new Set(selected);
    for (const p of changed) rest.delete(threadRef(p.t));
    if (ask) {
      ui.ask({
        title: ask(n),
        text: m.list_purge_text(),
        icon: 'ti-trash-x',
        ok: m.list_purge(),
        danger: true,
        run: () => {
          edits.purgeAll(parts, text(n));
          selected = rest;
        },
      });
      return;
    }
    const before = selected;
    const at = selectionKey;
    edits.runAll(parts, {
      text: text(n),
      failed: trashing?.failed,
      // Only back as long as nobody has changed the selection since and the view is the same.
      onRevert: () => {
        if (selected === rest && selectionKey === at) selected = before;
      },
    });
    selected = rest;
  }

  // --- List focus (`pfFocus`, `pfNav`): the last opened row, ↑/↓ and Enter on desktop ---

  // The opened conversation (also via J/K) becomes the focused row (`pfOpen`); after the reset
  // above this runs again so that a directly opened address keeps its focus when the mailboxes load.
  $effect(() => {
    void focusKey;
    if (opened) focus = threadRef(opened);
  });

  /**
   * ↑/↓: next or previous row; without focus the first or last. The
   * focus leaves buttons (`kbRoot`). `false` without rows: the key stays
   * with the browser then.
   */
  function moveFocus(by: 1 | -1): boolean {
    const refs = pf?.rows.map((r) => r.ref) ?? [];
    if (!refs.length) return false;
    const i = focus ? refs.indexOf(focus) : -1;
    focus = refs[i < 0 ? (by > 0 ? 0 : refs.length - 1) : Math.max(0, Math.min(refs.length - 1, i + by))]!;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return true;
  }

  /** Enter: open the focused row as long as it is in the list. */
  function openFocused(): boolean {
    const row = pf?.rows.find((r) => r.ref === focus);
    if (row) open(row);
    return !!row;
  }

  const actionEmail = (e: MessageEmail): ActionEmail => ({
    id: e.id,
    mailboxIds: e.mailboxIds,
    keywords: e.keywords,
    from: (e.from[0]?.email ?? '').toLowerCase(),
  });

  /** Emails of the open conversation in the view (delete, spam, move). */
  const viewEmails = $derived.by((): ActionEmail[] => {
    const source = opened && conversation ? sourceOf(opened.account) : null;
    if (!source || !conversation) return [];
    // Card from the row (`listEmail`): only the list knows the conversation's other emails.
    if (conversation.status !== 'ready' && listRow)
      return listRow.members.filter((e) => inSource(e.mailboxIds, source));
    return (readEmails ?? []).filter((e) => inSource(e.mailboxIds, source)).map(actionEmail);
  });

  /**
   * Open conversation: emails of the actions on the shown ones (`seq`), the
   * representative one (`rm`), those of the view (`scope`) and what is really to be read (`read`).
   */
  const reader = $derived.by(() => {
    if (!rd || !opened || !view || !readEmails) return null;
    const { seq, rm } = shownEmails({
      emails: readEmails,
      repId,
      kind: view.kind,
      roles: rolesOf(opened.account),
    });
    const card = conversation?.status !== 'ready' && viewEmails.length > 0;
    return {
      account: opened.account,
      seq: card ? viewEmails : seq.map(actionEmail),
      rm: actionEmail(rm),
      scope: viewEmails,
      read: seq.filter((e) => !e.miss).map(actionEmail),
    };
  });

  /** Star of the reading view: flags `rm`, unflags all shown ones (`rd.starOn` counts the shown ones). */
  function readStar() {
    const r = reader;
    if (!r) return;
    const flagged = r.seq.some((e) => e.keywords[FLAGGED]);
    edits.run({ account: r.account, edits: flagged ? flagEdits(r.seq, false) : flagEdits([r.rm], true) });
  }

  /** "Mark as unread" with undo, then back to the list (`onUnread`). */
  function readUnread() {
    const r = reader;
    if (!r) return;
    if (edits.run({ account: r.account, edits: seenEdits([r.rm], false), text: m.read_marked_unread() }))
      closeMessage();
    else nothing(r.account);
  }

  function readDel() {
    const r = reader;
    if (r) trash(r.account, r.scope, closeMessage);
  }

  /**
   * "Cancel send" of the reading view (`rd.onCancel`): closes it and then
   * opens compose with the draft, the previous time in the "Send later"
   * popover (`planPre`); too late or failed opens nothing.
   */
  async function readCancel() {
    const r = reader;
    if (!r) return;
    const sendAt = scheduled.sendAt(r.account, r.rm.id, r.rm.mailboxIds);
    // Only the shown email (`pfCancel([rm.id], true)`): compose opens exactly that one.
    // Back to the list: the reading view is closed even if the address has not changed yet.
    const from = listHref();
    const done = await cancel([{ account: r.account, emails: [r.rm] }], closeMessage);
    if (done.some((d) => d.id === r.rm.id)) void openDraft(r.account, r.rm.id, sendAt, from);
  }

  /**
   * "Send now" (`rd.onSendNow`, on mobile in "More actions"): closes the
   * reading view, cancels and resubmits (`pfSendNow`); undo or a
   * failed submission opens compose with the draft.
   */
  function readSendNow() {
    const r = reader;
    if (!r) return;
    sheet = null;
    const roles = rolesOf(r.account);
    if (!cancelEdits([r.rm], roles).size) return nothing();
    if (refusedBy([r.account])) return;
    const from = listHref();
    closeMessage();
    void planActions.sendNow(
      { ...r.rm, account: r.account },
      roles,
      () => void openDraft(r.account, r.rm.id, undefined, from),
    );
  }

  function readRestore() {
    const r = reader;
    if (r) restore(r.account, r.scope, closeMessage);
  }

  /** Report spam or "No spam" (in spam: back to the inbox) with undo; without effect an error toast reports it. */
  function spam(account: string, emails: readonly ActionEmail[], done?: () => void) {
    const roles = rolesOf(account);
    const tag = tagCheck(account);
    const ran = edits.run(
      isSpamView
        ? { account, edits: notSpamEdits(emails, roles, tag), text: m.list_not_spam() }
        : { account, edits: spamEdits(emails, roles, tag), text: m.list_spam_reported() },
    );
    if (ran) done?.();
    else nothing(account);
  }

  /** Spam from the reading view, then back to the list. */
  function readSpam() {
    const r = reader;
    if (!r) return;
    sheet = null;
    spam(r.account, r.scope, closeMessage);
  }

  // --- Set tag and move: popover on desktop, on mobile from "More actions" ---

  /**
   * Tags whose mailbox is being created, as `<account>\n<thread>\n<tag>`: in
   * this conversation they already count as set.
   */
  const placing = new SvelteSet<string>();
  const placingKey = (account: string, thread: string, tag = '') => `${account}\n${thread}\n${tag}`;
  function pendingTags(account: string, thread: string): Set<string> {
    const prefix = placingKey(account, thread);
    return new Set([...placing].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
  }

  /** Without an open popover the reading view needs no targets. */
  const NO_TARGETS: MoveTargets = { inbox: null, folders: [], on: () => false };

  /**
   * Targets for "Move": inbox and folders of the account, check mark where
   * the view's emails `scope` already are (scheduled ones stay put anyway).
   */
  function moveTargets(account: string, scope: readonly ActionEmail[]): MoveTargets {
    const roles = rolesOf(account);
    const tag = tagCheck(account);
    const emails = scope.filter((e) => !roles.scheduled || !e.mailboxIds.includes(roles.scheduled));
    return {
      inbox: roles.inbox,
      folders: mailboxes.tree(account),
      on: (box) => emails.length > 0 && !folderEdits(emails, box, roles, tag).size,
    };
  }

  /**
   * Set or remove a tag (`rd.tgOpts[].onClick`) on the shown
   * emails, at once and without toast; popover and sheet stay open. It is set
   * as soon as a shown email carries it; then the click removes it
   * from all. If the tag has no mailbox in the account yet, it is created first
   * (`tags.mailbox`); until then it counts as set in this
   * conversation, and further clicks on it do not wait. The tag
   * goes to the emails that were shown at the click.
   */
  function readTag(tag: string) {
    const r = reader;
    if (!r || !opened) return;
    const key = placingKey(r.account, opened.threadId, tag);
    if (placing.has(key)) return;
    const box = [...(tagMaps[r.account] ?? [])].find(([, t]) => t.id === tag)?.[0];
    if (box) {
      const on = r.seq.some((e) => e.mailboxIds.includes(box));
      // Nothing to change: the emails are only in the tag's mailbox.
      if (!edits.run({ account: r.account, edits: tagEdits(r.seq, box, !on) })) nothing(r.account);
      return;
    }
    placing.add(key);
    tags
      .mailbox(tag, r.account)
      .then((created) => edits.run({ account: r.account, edits: tagEdits(r.seq, created, true) }))
      .catch((error: unknown) => ui.toasts.error(error instanceof TagFixError ? tagFixError(error) : failText(error)))
      .finally(() => placing.delete(key));
  }

  /**
   * Move (`rd.mvOpts[].onClick`, `mvp.opts[].onClick`): toast with
   * undo, then back to the list. Without effect (target already reached,
   * view mailboxes still loading) popover and sheet stay open.
   */
  function readMove(opt: ReadMoveOption) {
    const r = reader;
    if (!r || opt.dis === 'true') return;
    const changes = folderEdits(r.scope, opt.id, rolesOf(r.account), tagCheck(r.account));
    if (!changes.size) return nothing();
    if (ui.menu === 'rdmove') ui.closeMenu();
    sheet = null;
    edits.run({ account: r.account, edits: changes, text: m.read_moved({ name: opt.label }) });
    closeMessage();
  }

  /**
   * Row from the "Move to folder" swipe gesture (`mvPick`): its
   * emails of the view as when moving from the reading view;
   * the dialog closes as soon as it leaves the list.
   */
  let movePick = $state<string | null>(null);
  const pickRow = $derived.by(() => {
    const t = movePick ? list?.threads.find((x) => x.key === movePick) : undefined;
    return t && !opened ? targetOf(t) : null;
  });
  // If the conversation leaves the list (sync, another view) or a conversation opens, the choice is over.
  $effect(() => {
    if (movePick && !pickRow) untrack(() => (movePick = null));
  });

  function pickMove(opt: ReadMoveOption) {
    const r = pickRow;
    if (!r || opt.dis === 'true') return;
    const changes = folderEdits(r.scope, opt.id, rolesOf(r.t.account), tagCheck(r.t.account));
    if (!changes.size) return nothing();
    movePick = null;
    edits.run({ account: r.t.account, edits: changes, text: m.read_moved({ name: opt.label }) });
  }

  /**
   * Read on opening (`pfOpen`): the shown unread emails, at once
   * and without toast, also new replies while the conversation is open.
   * Each email only once per opening – otherwise "Mark as unread" would
   * make it read again right away, and an error would repeat endlessly. Without
   * text (`miss`) nothing counts as read until it arrives.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- not reactive, only for the effect
  const marked = new Set<string>();
  $effect(() => {
    const r = reader;
    if (!r) return;
    const fresh = r.read.filter((e) => !e.keywords[SEEN] && !marked.has(e.id));
    for (const e of r.read) marked.add(e.id);
    if (fresh.length) untrack(() => edits.run({ account: r.account, edits: seenEdits(fresh, true), quiet: true }));
  });

  // All emails of the conversation deleted (permanently, from the reading view): back to the list.
  $effect(() => {
    if (opened && conversation?.status === 'ready' && !conversation.emails.length) untrack(() => toList(true));
  });

  /** "Load once" (`hb.once`). */
  const allowOnce = (key: string) => conversation?.allowOnce(key);

  /** "Load full message" (`tr.load`); if it fails, the notice stays (error toast as for the source). */
  function loadFull(key: string) {
    const c = conversation;
    // Only while the conversation is open: otherwise the error would sit above another one.
    c?.loadFull(key).catch((error: unknown) => {
      if (conversation === c) ui.toasts.error(failText(error));
    });
  }

  // Load images in the text of the open HTML emails; the next run retries failed ones.
  $effect(() => {
    const c = conversation;
    if (!rd || !c) return;
    const keys = rd.msgs.filter((msg) => msg.open && msg.hb).map((msg) => msg.key);
    untrack(() => keys.forEach((key) => c.loadImages(key)));
  });

  /** Address of the view's list (like `toList`), e.g. as the return from compose. */
  function listHref(): string | undefined {
    return location ? resolve('/mailbox/[account]/[...path]', mailboxParams(location.account, location)) : undefined;
  }

  /** Back to the view's list (`pfClose`). */
  function toList(replace: boolean) {
    if (location) openList(location, replace);
  }
  /** Back, Escape and after moving the open message: to the search it came from, otherwise to the list. */
  const closeMessage = () => {
    if (!returnToSearch(page.url.pathname)) toList(false);
  };

  /** Previous or next conversation of the list (`rdNav`); at the end of the loaded ones the list loads more. */
  async function step(by: -1 | 1) {
    const current = list;
    const at = inList;
    if (!current || !at) return;
    let target = at.threads[at.index + by];
    if (!target && by > 0 && at.hasMore) {
      const before = threadKey;
      try {
        await current.loadMore();
      } catch (error) {
        ui.toasts.error(failText(error, m.error_list()));
        return;
      }
      // Gone elsewhere in the meantime: stop paging.
      if (threadKey !== before) return;
      target = current.threads[at.index + 1];
    }
    if (!target) return;
    // Menus outside the reading view stay open (`pfOpen`); its own popovers close with the conversation, all with compose.
    if (location && !opensCompose(target)) ui.keepMenuAt = threadHref(location, target.account, target.threadId);
    open(target);
  }

  // J/K, ←/→ and Escape of the reading view on desktop, also while a conversation loads or fails.
  $effect(() => {
    if (!opened || ui.isMobile) return;
    ui.reader = {
      prev: () => void step(-1),
      next: () => void step(1),
      close: closeMessage,
      ...(canReply ? { reply: openReply } : {}),
    };
    return () => (ui.reader = null);
  });

  // Thread disappeared: after a merge continue in the new one, otherwise back to the list with a notice.
  $effect(() => {
    if (followGone(conversation, opened, () => location) === 'gone') untrack(() => ui.toasts.show(m.read_gone()));
  });

  /** Error page instead of list or conversation (`errPage`); `null` as long as nothing fails. */
  const errPage = $derived.by((): '404' | 'offline' | '500' | null => {
    if (!location || (location.thread && !opened) || threadAccount === null) return '404';
    if (!opened || rd) return null;
    if (conversation?.status === 'error') {
      // The list row is still coming ("not saved" card), or the account leads back to the list.
      if (conversation.unreachable && (listPending || conversation.frozen)) return null;
      return isOffline(conversation.error) ? 'offline' : '500';
    }
    return null;
  });

  // ↑/↓ and Enter only while the list is visible (not behind an error page).
  const listShown = $derived(!!pf && !opened && !ui.isMobile && errPage === null);
  $effect(() => {
    if (!listShown) return;
    ui.listKeys = { move: moveFocus, open: openFocused };
    return () => (ui.listKeys = null);
  });

  // Error page instead of conversation: on mobile with header and tab bar (`mRdOff`).
  $effect(() => {
    ui.readError = !!location?.thread && errPage !== null;
    return () => (ui.readError = false);
  });

  /** "Try again" of the error page of a failed conversation. */
  function retryConversation() {
    const failed = conversation;
    if (failed?.status === 'error') reading.run(failed.refresh()).catch(() => {});
  }

  /** "Try again" of the "not saved" card (`missRetry`); if it succeeds, the message shows. */
  async function retryMissing() {
    const c = conversation;
    try {
      await c?.retry();
    } catch (error) {
      // Another conversation in the meantime: the error would sit above it.
      if (conversation === c) ui.toasts.error(failText(error));
    }
  }

  /**
   * Load and save an attachment; the toast reports the start.
   * Attachments are never in storage. `network.offline` alone does not
   * block: in a LAN without a default route it reports `true` permanently.
   */
  async function download(att: ReadAttachment) {
    if (!opened) return;
    if (!usable) {
      ui.toasts.error(m.read_att_off_toast());
      return;
    }
    if (!network.offline) ui.toasts.show(m.read_downloading({ name: att.name }));
    try {
      if (!downloadBlob(att.name, await message.download(opened.account, att.part))) ui.toasts.error(m.error_act());
    } catch (error) {
      ui.toasts.error(isOffline(error) ? m.read_att_off_toast() : failText(error));
    }
  }

  // --- More actions (mobile) and source ---

  /**
   * On mobile the "More actions" sheet (`menu` = `rdmore`), its second
   * level "Add tag" (`rdtag`) or the move dialog with back
   * (`mvpick`, `mvBack`). On desktop the menu does not exist; a switch across
   * `MOBILE_BP` rebuilds the page in the layout and closes it (like the
   * source).
   */
  let sheet = $state<'more' | 'tag' | 'move' | null>(null);
  const closeSheet = () => {
    sheet = null;
    movePick = null;
  };
  /** What the move dialog currently stands for: the open conversation (mobile with back) or the swiped row. */
  const moveFor = $derived(sheet === 'move' && rd && opened ? 'reader' : pickRow ? 'row' : null);
  const mvp = $derived(
    moveFor === 'reader' && rd && opened
      ? moveValues(rd.subj, moveTargets(opened.account, viewEmails), true)
      : moveFor === 'row' && pickRow
        ? moveValues(pickRow.t.subject, moveTargets(pickRow.t.account, pickRow.scope), false)
        : null,
  );
  /** Open source (`rdSrc`); on mobile it takes the place of "More actions" (`rdsrc`). */
  let source = $state.raw<MessageSource | null>(null);

  /** Source of the email the reading view stands for (`rm`, `onSrc`); if loading fails, it closes with a toast. */
  function openSource() {
    // Like attachments, the source is never in storage; without access do not even ask.
    if (rd && (!usable || conversation?.unreachable)) {
      sheet = null;
      ui.toasts.error(m.error_offline());
      return;
    }
    const email = rd && conversation?.emails.find((e) => e.id === rd.id);
    if (!opened || !email) return;
    sheet = null;
    source?.dispose();
    const s = message.source(opened.account, email, sourceFileName(email.subject, m.read_source_file()));
    source = s;
    s.text.catch((error: unknown) => {
      // Closed or page left: report nothing more.
      if (source !== s || s.disposed) return;
      source = null;
      ui.toasts.error(failText(error));
    });
  }

  /** Closing aborts a running download. */
  function closeSource() {
    source?.dispose();
    source = null;
  }

  // If the reading view stands for another email (the list caught up, a new reply), the source closes (`rdSrc === rm.id`).
  $effect(() => {
    if (source && source.emailId !== rd?.id) untrack(closeSource);
  });

  /** To the clipboard, even while the text is still loading (`copyPending` keeps the gesture for Safari). */
  async function copySource(s: MessageSource) {
    try {
      if (await copyPending(s.text)) ui.toasts.show(m.read_source_copied());
      else ui.toasts.error(m.error_copy());
    } catch {
      // `openSource` reports the load error.
    }
  }

  /** "Download as .eml": the email as the server delivers it; no longer after closing. */
  async function saveSource(s: MessageSource) {
    let blob: Blob;
    try {
      blob = await s.blob;
    } catch {
      return; // `openSource` reports the load error.
    }
    if (!s.disposed && !downloadBlob(s.fileName, blob)) ui.toasts.error(m.error_act());
  }

  // Only subject and email of the reading view so that the source is not recreated every minute.
  const rdId = $derived(rd?.id);
  const rdSubj = $derived(rd?.subj ?? '');
  const src = $derived.by(() => {
    const s = source;
    if (!s || s.emailId !== rdId) return null;
    return sourceValues(s.parts, rdSubj, {
      close: closeSource,
      copy: () => void copySource(s),
      download: () => void saveSource(s),
    });
  });

  /** Theme from "More actions" (`mTheme`): invert and close the sheet. */
  function menuTheme() {
    ui.readInverted = !ui.readInverted;
    sheet = null;
  }

  // The layout shows source and "More actions": on desktop above the shell, on mobile in the sheet.
  $effect(() => {
    ui.pageDialog = () => {
      if (src) return { title: m.read_source_title(), close: closeSource, content: sourceDialog };
      if (mvp) return { title: m.read_move_title(), close: closeSheet, content: moveDialog };
      if (sheet && rd)
        return { title: sheet === 'tag' ? m.read_tag() : m.read_more(), close: closeSheet, content: messageMenu };
      return null;
    };
    return () => {
      ui.pageDialog = null;
      source?.dispose();
    };
  });

  function toggle(key: string) {
    const msg = rd?.msgs.find((x) => x.key === key);
    if (msg?.canFold) folds[key] = !msg.open;
  }
</script>

{#snippet sourceDialog(isMobile: boolean)}
  {#if src}<SourceDialog {src} {isMobile} />{/if}
{/snippet}

{#snippet messageMenu()}
  {#if rd}
    <MessageMenu
      {rd}
      level={sheet === 'tag' ? 'tag' : 'more'}
      onTag={() => (sheet = 'tag')}
      onMove={() => (sheet = 'move')}
      onSpam={readSpam}
      onSendNow={readSendNow}
      onTheme={menuTheme}
      onSource={openSource}
      onBack={() => (sheet = 'more')}
      onDone={closeSheet}
      onTagPick={readTag}
    />
  {/if}
{/snippet}

{#snippet moveDialog(isMobile: boolean)}
  {#if mvp}
    <MoveDialog
      {mvp}
      {isMobile}
      onPick={moveFor === 'reader' ? readMove : pickMove}
      focusFirst={moveFor === 'reader'}
      onClose={closeSheet}
      onBack={() => (sheet = 'more')}
    />
  {/if}
{/snippet}

{#if errPage === '404'}
  <ErrorView code="404" />
{:else if errPage}
  <ErrorView code={errPage} retry={retryConversation} />
{:else if opened}
  {#if rd && rp}
    <!-- New per conversation: it starts at the top, not at the previous one's scroll position. -->
    {#key threadKey}
      <MessageView
        {rd}
        isMobile={ui.isMobile}
        onClose={closeMessage}
        onPrev={() => void step(-1)}
        onNext={() => void step(1)}
        onToggle={toggle}
        onDownload={download}
        onTheme={() => (ui.readInverted = !ui.readInverted)}
        onSource={openSource}
        onMore={() => (sheet = 'more')}
        onStar={readStar}
        onUnread={readUnread}
        onCancel={readCancel}
        onSendNow={readSendNow}
        onRestore={readRestore}
        onSpam={readSpam}
        onDel={readDel}
        moreOpen={sheet !== null}
        onTagMenu={() => ui.toggleMenu('rdtag')}
        onMoveMenu={() => ui.toggleMenu('rdmove')}
        onTagPick={readTag}
        onMovePick={readMove}
        onExtOnce={allowOnce}
        onExtAlways={allowSender}
        onFull={loadFull}
        onMissRetry={() => void retryMissing()}
        onMailto={writeTo}
        {rp}
        {replyActions}
      />
    {/key}
  {:else if reading.slow}
    <Skeleton kind="rd" isMobile={ui.isMobile} />
  {/if}
{:else if pf}
  <!-- New per list: another list starts at the top, not at the previous one's scroll position. -->
  {#key key}
    {#if compact}
      <MailListCompact
        {pf}
        isMobile={ui.isMobile}
        {busy}
        hasMore={!!list && !view?.unavailable && list.hasMore}
        onSegment={(s: Segment) => (kept.segment = s)}
        onSort={(k: ListSort['key']) => {
          kept.sort = nextSort(kept.sort, k);
          sortFocus = k;
        }}
        focusSort={sortFocus}
        onOpen={open}
        onRefresh={refresh}
        onMore={more}
        onStar={rowStar}
        onRead={rowRead}
        onRestore={rowRestore}
        onDel={rowDel}
        onSwipe={rowSwipe}
        onClear={clearTrash}
        onGoAccount={goAccount}
        onFolderEdit={folderEdit}
        onFolderDelete={folderDelete}
        onTagEdit={tagEditOpen}
        onTagDelete={tagDelete}
        onSel={toggleSelect}
        onSelAll={selectAll}
        onClearSel={clearSelection}
        onBulk={bulk}
      />
    {:else}
      <MailListSoft
        {pf}
        isMobile={ui.isMobile}
        {busy}
        hasMore={!!list && !view?.unavailable && list.hasMore}
        onSegment={(s: Segment) => (kept.segment = s)}
        onOpen={open}
        onRefresh={refresh}
        onMore={more}
        onStar={rowStar}
        onRead={rowRead}
        onRestore={rowRestore}
        onDel={rowDel}
        onSwipe={rowSwipe}
        onClear={clearTrash}
        onGoAccount={goAccount}
        onFolderEdit={folderEdit}
        onFolderDelete={folderDelete}
        onTagEdit={tagEditOpen}
        onTagDelete={tagDelete}
        onSel={toggleSelect}
        onSelAll={selectAll}
        onClearSel={clearSelection}
        onBulk={bulk}
      />
    {/if}
  {/key}
{:else if loading.slow}
  <Skeleton kind={compact ? 'pfB' : 'pfA'} isMobile={ui.isMobile} />
{/if}
