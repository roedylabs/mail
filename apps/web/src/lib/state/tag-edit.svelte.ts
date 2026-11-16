/**
 * Create, edit and delete tags:
 * state of the name dialog for tags (`kind: 'tag'`) and the actions behind it
 * (create, edit, delete, commit). It shares the dialog with the folders
 * (`#lib/state/folders.svelte.ts`); `tags` works at the server.
 */
import { MA_COLORS } from '@roedy/tokens';
import { colorLabel } from '#lib/appearance.ts';
import { failText } from '#lib/errors.ts';
import { m } from '#lib/paraglide/messages.js';
import type { FolderLeaveNav, NameDialogValues, NamePickOption } from '#lib/state/folders.svelte.ts';
import { sameName } from '#lib/state/mailboxes.svelte.ts';
import { tags, takenError, type Tag, type TagNode, type TagPatch, type Tags } from '#lib/state/tags.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

/** Open dialog (`kind: 'tag'`). */
export interface TagDialogState {
  /** Chosen parent tag; `null` = top level. */
  parent: string | null;
  name: string;
  /** Index into `MA_COLORS` (`c`). */
  color: number;
  /** Color chosen by hand: a different parent tag then no longer changes it. */
  colorSet: boolean;
  /** Editing: the tag; otherwise `null` (create). */
  rename: string | null;
  /** Editing: parent tag and color when opened; saving unchanged changes nothing. */
  origin: { parent: string | null; color: number } | null;
  /** Selection "Location" expanded (`pick: 'loc'`). */
  pick: boolean;
}

/** View after creating (layout, at the time of confirming). */
export interface TagOpenNav {
  /** Shows the new tag in the sidebar view. */
  open: (id: string) => void;
  /** Back to the previous view (undo). */
  restore: () => void;
}

/** View after deleting (mailbox page): inbox, undo back into the tag. */
export type TagLeaveNav = FolderLeaveNav;

/** Tag in the tree with its parent tag (`null`: top level). */
function findTag(
  tree: readonly TagNode[],
  id: string,
  parent: string | null = null,
): { node: TagNode; parent: string | null } | null {
  for (const t of tree) {
    if (t.id === id) return { node: t, parent };
    const hit = findTag(t.children, id, t.id);
    if (hit) return hit;
  }
  return null;
}

/** Tags from the top one down to tag `id`; `null` if it does not exist. */
function tagChain(tree: readonly TagNode[], id: string): TagNode[] | null {
  for (const t of tree) {
    if (t.id === id) return [t];
    const rest = tagChain(t.children, id);
    if (rest) return [t, ...rest];
  }
  return null;
}

/** Error toast: a taken name with the sync's text, otherwise as everywhere. */
export function tagError(error: unknown, name: string, fallback: string = m.error_act()): string {
  if (takenError(error)) return m.tagfix_error_tag({ name });
  return failText(error, fallback);
}

export class TagEdit {
  dialog = $state<TagDialogState | null>(null);
  readonly #tags: Tags;
  /** The delete confirmation waits for the count (a second click does not count again). */
  #asking = false;

  constructor(store: Tags = tags) {
    this.#tags = store;
  }

  /**
   * "New tag": at the top with the next color (number of tags on the
   * top level), under a parent tag with its color. A running
   * toast goes out first.
   */
  add(parent: string | null = null): void {
    ui.toasts.dismiss();
    void this.#tags.ensure().catch(() => undefined);
    const tree = this.#tags.tree([]);
    const color = parent ? (findTag(tree, parent)?.node.color ?? 0) : tree.length % MA_COLORS.length;
    this.dialog = { parent, name: '', color, colorSet: false, rename: null, origin: null, pick: false };
  }

  /** "Edit tag": name, location and color (also an inherited one) prefilled. */
  edit(id: string): void {
    const hit = findTag(this.#tags.tree([]), id);
    if (!hit) return;
    ui.toasts.dismiss();
    const { parent } = hit;
    const { name, color } = hit.node;
    this.dialog = { parent, name, color, colorSet: true, rename: id, origin: { parent, color }, pick: false };
  }

  /** Dialog closed (also on sign-out). */
  close(): void {
    this.dialog = null;
  }

  setName(name: string): void {
    if (this.dialog) this.dialog.name = name;
  }

  /** Chooses a location; the selection collapses. Without an own choice a new tag takes the parent tag's color. */
  setParent(parent: string | null, color: number | null): void {
    const d = this.dialog;
    if (!d) return;
    Object.assign(d, { parent, pick: false }, color === null || d.colorSet ? {} : { color });
  }

  setColor(color: number): void {
    if (this.dialog) Object.assign(this.dialog, { color, colorSet: true });
  }

  togglePick(): void {
    if (this.dialog) this.dialog.pick = !this.dialog.pick;
  }

  /**
   * "Create" or "Save". If the name is already taken on the
   * level, an error toast reports it and the dialog stays open.
   */
  async commit(nav: TagOpenNav): Promise<void> {
    const d = this.dialog;
    const name = d?.name.trim();
    if (!d || !name) return;
    const list = this.#tags.list ?? [];
    if (list.some((t) => t.id !== d.rename && t.parent_id === d.parent && sameName(t.name, name))) {
      ui.toasts.error(m.tagfix_error_tag({ name }));
      return;
    }
    this.dialog = null;
    if (d.rename) this.#save(d, name, list);
    else await this.#create(d, name, nav);
  }

  /**
   * "Delete tag": confirmation with messages and subtags across
   * all reachable accounts, then with undo. The
   * count loads mailboxes; `nav` then returns the targets – `null` if
   * the view has left the tag in the meantime (then no confirmation).
   */
  async remove(id: string, nav: () => TagLeaveNav | null): Promise<void> {
    if (this.#asking) return;
    this.#asking = true;
    let usage: { sub: number; mails: number };
    try {
      usage = await this.#tags.usage(id);
    } catch (error) {
      ui.toasts.error(failText(error));
      return;
    } finally {
      this.#asking = false;
    }
    const { sub, mails } = usage;
    // Deleted elsewhere in the meantime, signed out or the view left: no confirmation any more.
    const tag = this.#tags.list?.find((t) => t.id === id);
    const to = nav();
    if (!tag || !to) return;
    const text = [
      mails === 0 ? m.tags_delete_none() : mails === 1 ? m.tags_delete_mail_one() : m.tags_delete_mail({ n: mails }),
      sub === 0 ? '' : sub === 1 ? m.tags_delete_sub_one() : m.tags_delete_sub({ n: sub }),
    ]
      .filter(Boolean)
      .join(' ');
    ui.ask({
      title: m.tags_delete_title({ name: tag.name }),
      text,
      icon: 'ti-tag-off',
      ok: m.tags_delete_ok(),
      danger: true,
      run: () => this.#remove(id, tag.name, to),
    });
  }

  /** Values of the dialog; `null` while it is closed. `nav` applies on confirming. */
  values(nav: () => TagOpenNav): NameDialogValues | null {
    const d = this.dialog;
    if (!d) return null;
    const tree = this.#tags.tree([]);
    const opts: NamePickOption[] = [
      {
        key: '',
        label: m.name_top(),
        depth: 0,
        icon: 'ti-tags',
        dot: null,
        on: d.parent === null,
        onClick: () => this.setParent(null, null),
      },
    ];
    // The edited tag and its subtags drop out: a tag cannot lie below itself.
    const walk = (list: readonly TagNode[], depth: number) => {
      for (const t of list) {
        if (t.id === d.rename) continue;
        opts.push({
          key: t.id,
          label: t.name,
          depth,
          icon: 'ti-tag',
          dot: MA_COLORS[t.color]?.[1] ?? MA_COLORS[0][1],
          on: d.parent === t.id,
          onClick: () => this.setParent(t.id, t.color),
        });
        walk(t.children, depth + 1);
      }
    };
    walk(tree, 1);
    const path = d.parent === null ? null : (tagChain(tree, d.parent)?.map((t) => t.name) ?? null);
    const [, bg, ink] = MA_COLORS[d.color % MA_COLORS.length] ?? MA_COLORS[0];
    return {
      nameIsTag: true,
      nameTitle: d.rename ? m.name_tag_edit() : d.parent ? m.name_tag_sub() : m.name_tag_new(),
      nameSub: m.name_tag_all(),
      nameIcon: 'ti-tag',
      nameTileBg: bg,
      nameTileInk: ink,
      nameVal: d.name,
      namePh: m.name_tag_ph(),
      nameBtnLabel: d.rename ? m.name_save() : m.name_create(),
      nameOk: d.name.trim() !== '',
      namePickOpts: opts,
      namePickLabel: path ? path.join(' › ') : m.name_top(),
      namePickIcon: path ? 'ti-tag' : 'ti-tags',
      namePickOpen: d.pick,
      nameSw: MA_COLORS.map(([name, swBg, swInk], i) => ({
        label: colorLabel(name),
        bg: swBg,
        ink: swInk,
        on: d.color % MA_COLORS.length === i,
        onClick: () => this.setColor(i),
      })),
      namePickToggle: () => this.togglePick(),
      onNameInput: (value) => this.setName(value),
      nameCommit: () => void this.commit(nav()),
      nameClose: () => this.close(),
    };
  }

  /** Expands the parent tag and its ancestors so that the new or moved tag is visible. */
  #reveal(parent: string | null): void {
    if (parent === null) return;
    for (const t of tagChain(this.#tags.tree([]), parent) ?? []) this.#tags.open.add(t.id);
  }

  /**
   * Creating goes to the server immediately, because the view switches into the new
   * tag; "undo" deletes it again, sign-out does not.
   * If it fails, the dialog opens again with the input.
   */
  async #create(d: TagDialogState, name: string, nav: TagOpenNav): Promise<void> {
    let tag: Tag;
    try {
      tag = await this.#tags.create(name, d.parent, d.color);
    } catch (error) {
      if (!this.dialog) this.dialog = { ...d, pick: false };
      ui.toasts.error(tagError(error, name));
      return;
    }
    this.#reveal(d.parent);
    nav.open(tag.id);
    ui.toasts.defer({
      text: m.tags_created({ name }),
      // Locally there is nothing to revert; only "undo" deletes the tag at the server (`onUndo`).
      revert: () => undefined,
      onUndo: () => {
        const token = this.#tags.stage({ hide: [tag.id] });
        nav.restore();
        this.#tags
          .remove(tag.id)
          .catch((error: unknown) => ui.toasts.error(failText(error, m.error_undo())))
          .finally(() => this.#tags.unstage(token));
      },
    });
  }

  /**
   * Rename, recolor or move: immediately in the display, to the
   * server after the toast. The color only goes along if it changes –
   * or, when moving, an inherited one, so that the tag looks as in the dialog.
   */
  #save(d: TagDialogState, name: string, list: readonly Tag[]): void {
    const t = list.find((x) => x.id === d.rename);
    if (!t || !d.origin) {
      ui.toasts.error(m.error_act());
      return;
    }
    const moved = d.parent !== d.origin.parent;
    const renamed = name !== t.name;
    const recolored = d.color !== d.origin.color;
    if (!moved && !renamed && !recolored) return;
    const patch: TagPatch = {
      ...(renamed ? { name } : {}),
      ...(moved ? { parent_id: d.parent } : {}),
      ...(recolored || (moved && t.color === null) ? { color: d.color } : {}),
    };
    const token = this.#tags.stage({
      id: t.id,
      name,
      parent_id: moved ? d.parent : t.parent_id,
      color: patch.color === undefined ? t.color : patch.color,
    });
    this.#reveal(d.parent);
    ui.toasts.defer({
      text: moved ? m.tags_moved({ name }) : m.tags_saved({ name }),
      revert: () => this.#tags.unstage(token),
      commit: async (keepalive) => {
        await this.#tags.edit(t.id, patch, keepalive);
        this.#tags.unstage(token);
      },
      onError: (error) => ui.toasts.error(tagError(error, name, m.error_undo())),
    });
  }

  /** Delete: the branch hidden immediately, the view in the inbox; at the server after the toast. */
  #remove(id: string, name: string, nav: TagLeaveNav): void {
    const token = this.#tags.stage({ hide: [id] });
    nav.inbox();
    ui.toasts.defer({
      text: m.tags_deleted({ name }),
      revert: () => this.#tags.unstage(token),
      // Only "undo" leads back into the tag; after an error or on sign-out the view stays.
      onUndo: () => nav.restore(),
      commit: async () => {
        await this.#tags.remove(id);
        this.#tags.unstage(token);
      },
      onError: (error) => ui.toasts.error(failText(error, m.error_undo())),
    });
  }
}

export const tagEdit = new TagEdit();
