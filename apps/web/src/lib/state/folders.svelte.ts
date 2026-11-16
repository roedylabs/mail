/**
 * Create, edit and delete own folders:
 * state of the name dialog for folders and the actions behind it (create,
 * edit, delete, commit). Tags use the same dialog.
 */
import type { Id } from '@roedy/jmap';
import { failText } from '#lib/errors.ts';
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import { accounts } from '#lib/state/accounts.svelte.ts';
import {
  canDelete,
  findFolder,
  folderChain,
  folderLevels,
  mailboxes,
  nameTaken,
  tagMailboxIds,
  type FolderNode,
  type Mailboxes,
} from '#lib/state/mailboxes.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/** Open dialog (`kind: 'folder'`). */
export interface NameDialogState {
  account: string;
  /** Chosen parent folder; `null` = top level. */
  parent: Id | null;
  name: string;
  /** Editing: the folder; otherwise `null` (create). */
  rename: Id | null;
  /** Editing: parent folder in the tree when opened; a different `parent` moves. */
  origin: Id | null;
  /** Selection "Location" expanded (`pick: 'loc'`). */
  pick: boolean;
}

/** View after creating (layout, at the time of confirming). */
export interface FolderOpenNav {
  /** Shows the new folder (in "all accounts" with its account). */
  open: (account: string, id: Id) => void;
  /** Back to the previous view (undo). */
  restore: () => void;
}

/** View after deleting (mailbox page, at the time of the confirmation). */
export interface FolderLeaveNav {
  /** Inbox of the view. */
  inbox: () => void;
  /** Back into the folder (undo). */
  restore: () => void;
}

/** Row of the selection "Location" (`namePickOpts`). */
export interface NamePickOption {
  /** Key for `{#each}`: id of the folder, `''` for "Top level". */
  key: string;
  label: string;
  /** Depth (`d`); indented by `12 + d * 22` px (`pl`). */
  depth: number;
  icon: IconName;
  /** Color dot instead of icon (`dot`): tags; `null` for folders. */
  dot: string | null;
  /** Selected (`on`: fill, check mark, `aria-selected`). */
  on: boolean;
  onClick: () => void;
}

/** Color of a tag; empty for folders. */
export interface NameSwatch {
  label: string;
  bg: string;
  ink: string;
  on: boolean;
  onClick: () => void;
}

/** Values of the name dialog; the component derives style values. */
export interface NameDialogValues {
  nameIsTag: boolean;
  /** "New folder", "New subfolder", "Edit folder". */
  nameTitle: string;
  /** "in ‹email address›". */
  nameSub: string;
  /** Icon of the tile: `ti-folder-plus`, when editing `ti-folder-cog`. */
  nameIcon: IconName;
  nameTileBg: string;
  nameTileInk: string;
  nameVal: string;
  namePh: string;
  /** "Create" or "Save". */
  nameBtnLabel: string;
  /** Name not empty: button usable. */
  nameOk: boolean;
  namePickOpts: NamePickOption[];
  /** Path of the chosen location ("Projects › Website") or "Top level". */
  namePickLabel: string;
  namePickIcon: IconName;
  /** Selection "Location" expanded (`namePickGr`). */
  namePickOpen: boolean;
  nameSw: NameSwatch[];
  namePickToggle: () => void;
  onNameInput: (value: string) => void;
  /** "Create"/"Save" and Enter in the field. */
  nameCommit: () => void;
  /** Cancel, close, click on the backdrop and Escape. */
  nameClose: () => void;
}

export class Folders {
  dialog = $state<NameDialogState | null>(null);
  readonly #boxes: Mailboxes;

  constructor(boxes: Mailboxes = mailboxes) {
    this.#boxes = boxes;
  }

  /** "New folder" or "New folder in …"; a running toast goes out first. */
  add(account: string, parent: Id | null = null): void {
    ui.toasts.dismiss();
    // "Location" and the name check need the mailboxes (e.g. not loaded yet from the palette).
    this.#boxes.ensure(account).catch(() => undefined);
    this.dialog = { account, parent, name: '', rename: null, origin: null, pick: false };
  }

  /** "Edit folder": name and location of the folder prefilled. */
  edit(account: string, id: Id): void {
    const hit = findFolder(this.#boxes.tree(account), id);
    if (!hit) return;
    ui.toasts.dismiss();
    this.dialog = { account, parent: hit.parent, name: hit.node.name, rename: id, origin: hit.parent, pick: false };
  }

  close(): void {
    this.dialog = null;
  }

  /** Account removed or signed out: dialog closed. */
  reset(): void {
    this.dialog = null;
  }

  setName(name: string): void {
    if (this.dialog) this.dialog.name = name;
  }

  /** Chooses a location; the selection collapses. */
  setParent(parent: Id | null): void {
    if (this.dialog) Object.assign(this.dialog, { parent, pick: false });
  }

  togglePick(): void {
    if (this.dialog) this.dialog.pick = !this.dialog.pick;
  }

  /**
   * "Create" or "Save". If the name is already taken under the
   * location, an error toast reports it and the dialog stays open.
   */
  async commit(nav: FolderOpenNav): Promise<void> {
    const d = this.dialog;
    const name = d?.name.trim();
    if (!d || !name) return;
    const list = this.#boxes.list(d.account);
    // "Location" unchanged: the parent at the server – also for a folder that the tree puts at the top.
    const kept = d.rename !== null && d.parent === d.origin;
    const parent = kept ? (list.find((b) => b.id === d.rename)?.parentId ?? d.parent) : d.parent;
    if (nameTaken(list, parent, name, d.rename)) {
      ui.toasts.error(m.folders_error_taken({ name }));
      return;
    }
    this.dialog = null;
    if (d.rename) this.#save(d.account, d.rename, name, kept ? null : { parentId: d.parent });
    else await this.#create(d, name, nav);
  }

  /**
   * "Delete folder": confirmation with subfolders and
   * messages, then with undo. A branch with a role (e.g. archive) or
   * without the right to delete reports an error right away.
   */
  remove(account: string, id: Id, nav: FolderLeaveNav): void {
    const levels = folderLevels(this.#boxes.list(account), id);
    if (!levels) return;
    if (!canDelete(levels)) {
      ui.toasts.error(m.error_act());
      return;
    }
    const root = levels[0]?.[0];
    if (!root) return;
    const sub = levels.flat().length - 1;
    const n = levels.flat().reduce((sum, b) => sum + b.totalEmails, 0);
    const text = [
      sub === 0 ? '' : sub === 1 ? m.folders_delete_sub_one() : m.folders_delete_sub({ n: sub }),
      n === 0 ? m.folders_delete_empty() : n === 1 ? m.folders_delete_mail_one() : m.folders_delete_mail({ n }),
    ]
      .filter(Boolean)
      .join(' ');
    ui.ask({
      title: m.folders_delete_title({ name: root.name }),
      text,
      icon: 'ti-folder-x',
      ok: m.folders_delete_ok(),
      danger: true,
      run: () =>
        this.#remove(
          account,
          root.id,
          root.name,
          levels.flat().map((b) => b.id),
          nav,
        ),
    });
  }

  /** Values of the dialog; `null` while it is closed. `nav` applies on confirming. */
  values(nav: () => FolderOpenNav): NameDialogValues | null {
    const d = this.dialog;
    if (!d) return null;
    const tree = this.#boxes.tree(d.account);
    const opts: NamePickOption[] = [
      {
        key: '',
        label: m.name_top(),
        depth: 0,
        icon: 'ti-folders',
        dot: null,
        on: d.parent === null,
        onClick: () => this.setParent(null),
      },
    ];
    // The edited folder and everything below drop out: a folder cannot lie inside itself.
    const walk = (list: readonly FolderNode[], depth: number) => {
      for (const f of list) {
        if (f.id === d.rename) continue;
        opts.push({
          key: f.id,
          label: f.name,
          depth,
          icon: 'ti-folder',
          dot: null,
          on: d.parent === f.id,
          onClick: () => this.setParent(f.id),
        });
        walk(f.children, depth + 1);
      }
    };
    walk(tree, 1);
    const path = d.parent === null ? null : (folderChain(tree, d.parent)?.map((f) => f.name) ?? null);
    const email = accounts.list?.find((a) => a.id === d.account)?.email ?? '';
    return {
      nameIsTag: false,
      nameTitle: d.rename ? m.name_folder_edit() : d.parent ? m.name_folder_sub() : m.name_folder_new(),
      nameSub: m.name_folder_in({ email }),
      nameIcon: d.rename ? 'ti-folder-cog' : 'ti-folder-plus',
      nameTileBg: 'var(--acc)',
      nameTileInk: 'var(--accink)',
      nameVal: d.name,
      namePh: m.name_folder_ph(),
      nameBtnLabel: d.rename ? m.name_save() : m.name_create(),
      nameOk: d.name.trim() !== '',
      namePickOpts: opts,
      namePickLabel: path ? path.join(' › ') : m.name_top(),
      namePickIcon: path ? 'ti-folder' : 'ti-folders',
      namePickOpen: d.pick,
      nameSw: [],
      namePickToggle: () => this.togglePick(),
      onNameInput: (value) => this.setName(value),
      nameCommit: () => void this.commit(nav()),
      nameClose: () => this.close(),
    };
  }

  /** Expands the parent folder and its ancestors so that the new or moved folder is visible. */
  #reveal(account: string, parent: Id | null): void {
    if (parent === null) return;
    for (const f of folderChain(this.#boxes.tree(account), parent) ?? [])
      if (!this.#boxes.isOpen(account, f.id)) this.#boxes.toggle(account, f.id);
  }

  /**
   * Creating goes to the server immediately, because the view switches into the new
   * folder; "undo" deletes it again, sign-out does not.
   * If it fails, the dialog opens again with the input.
   */
  async #create(d: NameDialogState, name: string, nav: FolderOpenNav): Promise<void> {
    const { account, parent } = d;
    let id: Id;
    try {
      id = await this.#boxes.create(account, name, parent);
    } catch (error) {
      if (!this.dialog) this.dialog = { ...d, pick: false };
      ui.toasts.error(failText(error));
      return;
    }
    this.#reveal(account, parent);
    nav.open(account, id);
    ui.toasts.defer({
      text: m.folders_created({ name }),
      // Locally there is nothing to revert; only "undo" deletes the folder at the server (`onUndo`).
      revert: () => undefined,
      onUndo: () => {
        const token = this.#boxes.stage(account, { hide: [id] });
        nav.restore();
        this.#boxes
          .destroy(account, [id])
          .catch((error: unknown) => ui.toasts.error(failText(error, m.error_undo())))
          .finally(() => this.#boxes.unstage(token));
      },
    });
  }

  /**
   * Rename or move (`move`: new parent, otherwise `null`):
   * immediately in the display, to the server after the toast. If the folder
   * no longer exists by then, an error toast reports it.
   */
  #save(account: string, id: Id, name: string, move: { parentId: Id | null } | null): void {
    const box = this.#boxes.list(account).find((b) => b.id === id);
    if (!box) {
      ui.toasts.error(m.error_act());
      return;
    }
    const renamed = name !== box.name;
    if (!move && !renamed) return;
    const parentId = move ? move.parentId : box.parentId;
    const token = this.#boxes.stage(account, { id, name, parentId });
    this.#reveal(account, parentId);
    ui.toasts.defer({
      text: move ? m.folders_moved({ name }) : m.folders_renamed({ name }),
      revert: () => this.#boxes.unstage(token),
      commit: async (keepalive) => {
        await this.#boxes.update(account, id, { ...(renamed ? { name } : {}), ...(move ?? {}) }, keepalive);
        this.#boxes.unstage(token);
      },
      onError: (error) => ui.toasts.error(failText(error, m.error_undo())),
    });
  }

  /**
   * Delete: the branch hidden immediately, the view in the inbox; at the
   * server after the toast, with the subfolders at the time of sending.
   */
  #remove(account: string, id: Id, name: string, hide: Id[], nav: FolderLeaveNav): void {
    const list = this.#boxes.list(account);
    const trash = this.#boxes.role(account, 'trash')?.id ?? null;
    const tagBoxes = tagMailboxIds(list);
    const token = this.#boxes.stage(account, { hide });
    nav.inbox();
    ui.toasts.defer({
      text: m.folders_deleted({ name }),
      revert: () => this.#boxes.unstage(token),
      // Only "undo" leads back into the folder; after an error or on sign-out the view stays.
      onUndo: () => nav.restore(),
      commit: async () => {
        await this.#boxes.remove(account, id, trash, (box) => tagBoxes.has(box));
        this.#boxes.unstage(token);
      },
      onError: (error) => ui.toasts.error(failText(error, m.error_undo())),
    });
  }
}

export const folders = new Folders();
