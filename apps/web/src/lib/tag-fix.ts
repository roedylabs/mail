/**
 * Values of the dialog "Fix tags" from the cases of `tags.problems()`, plus
 * the toast texts after an action.
 */
import { MA_COLORS } from '@roedy/tokens';
import { failText } from '#lib/errors.ts';
import { m } from '#lib/paraglide/messages.js';
import { problemKey, TagFixError, type Tag, type TagFix, type TagProblem } from '#lib/state/tags.svelte.ts';

/** Button (primary) or text button (secondary) of an entry. */
export interface TagFixAction {
  label: string;
  /** Action running: loading state. */
  spin: boolean;
  /** `aria-describedby`: id of the note if it belongs to this action. */
  desc: string | undefined;
  run: () => void;
}

export interface TagFixItem {
  key: string;
  /** Chip with colour dot (tag) or folder icon (mailbox without a tag). */
  isTag: boolean;
  /** Colour of the dot (`MA_COLORS`), empty for a mailbox without a tag. */
  dot: string;
  chip: string;
  text: string;
  /** Note below the actions, empty if none. */
  note: string;
  noteId: string;
  p: TagFixAction;
  s: TagFixAction | null;
  /** An action of the entry is running: entry locked. */
  busy: boolean;
}

/** Group per account; header like in the folder tree only in "All accounts". */
export interface TagFixGroup {
  key: string;
  head: boolean;
  letter: string;
  aBg: string;
  aInk: string;
  email: string;
  mt: string;
  items: TagFixItem[];
}

export interface TagFixValues {
  /** Subline in the header: email address of the account or "Alle Konten". */
  sub: string;
  groups: TagFixGroup[];
}

export interface TagFixAccount {
  id: string;
  email: string;
  letter: string;
  bg: string;
  ink: string;
}

export interface TagFixInput {
  problems: readonly TagProblem[];
  tags: readonly Tag[];
  /** Accounts of the view in their order. */
  accounts: readonly TagFixAccount[];
  allMode: boolean;
  busy: (key: string) => TagFix | undefined;
  run: (problem: TagProblem, action: TagFix) => void;
}

/** Colour of a tag like in the tag list: its own, otherwise that of the parent tag, otherwise 0. */
function colorOf(tags: readonly Tag[], id: string): number {
  const seen = new Set<string>();
  for (let t = tags.find((x) => x.id === id); t && !seen.has(t.id); t = tags.find((x) => x.id === t?.parent_id)) {
    if (t.color !== null) return t.color;
    seen.add(t.id);
  }
  return 0;
}

const nameOf = (tags: readonly Tag[], id: string | null): string => tags.find((t) => t.id === id)?.name ?? '';

/** Sentence, actions and note of a case; the note belongs to the action `noteAt`. */
function info(p: TagProblem, tags: readonly Tag[]) {
  switch (p.kind) {
    case 'missing':
      return { text: m.tagfix_missing(), note: '', noteAt: 0, acts: [['unlink', m.tagfix_unlink()]] as const };
    case 'outside':
      return {
        text: m.tagfix_outside({ path: p.path }),
        note: m.tagfix_note_keep(),
        noteAt: 1,
        acts: [
          ['back', m.tagfix_back()],
          ['unlink', m.tagfix_unlink()],
        ] as const,
      };
    case 'renamed': {
      const nameOnly = p.name !== null && p.path === null;
      return {
        text:
          p.name !== null && p.path !== null
            ? m.tagfix_renamed_both({ name: p.name, path: p.path })
            : p.name !== null
              ? m.tagfix_renamed_name({ name: p.name })
              : m.tagfix_renamed_path({ path: p.path ?? '' }),
        note: nameOnly ? m.tagfix_note_take({ name: p.name ?? '' }) : '',
        noteAt: 1,
        acts: nameOnly
          ? ([
              ['align', m.tagfix_align()],
              ['take', m.tagfix_take()],
            ] as const)
          : ([['align', m.tagfix_align()]] as const),
      };
    }
    case 'unlinked':
      return {
        text: m.tagfix_unlinked(),
        note: !p.kids ? '' : p.kids === 1 ? m.tagfix_note_kids_one() : m.tagfix_note_kids({ count: p.kids }),
        noteAt: 0,
        acts: [
          ['adopt', p.link ? m.tagfix_link({ name: nameOf(tags, p.link) }) : m.tagfix_adopt()],
          ['toFolder', m.tagfix_to_folder()],
        ] as const,
      };
  }
}

/** Values of the dialog: entries per account in the order of the accounts, with headers in "All accounts". */
export function tagFixValues(input: TagFixInput): TagFixValues {
  const { tags, allMode } = input;
  const item = (p: TagProblem): TagFixItem => {
    const key = problemKey(p);
    const running = input.busy(key);
    const { text, note, noteAt, acts } = info(p, tags);
    const noteId = `ts-n-${key}`;
    const action = ([act, label]: readonly [TagFix, string], i: number): TagFixAction => ({
      label,
      spin: running === act,
      desc: note && i === noteAt ? noteId : undefined,
      run: () => input.run(p, act),
    });
    const isTag = p.kind !== 'unlinked';
    return {
      key,
      isTag,
      dot: isTag ? (MA_COLORS[colorOf(tags, p.tag)]?.[1] ?? MA_COLORS[0][1]) : '',
      chip: isTag ? nameOf(tags, p.tag) : p.path,
      text,
      note,
      noteId,
      p: action(acts[0], 0),
      s: acts[1] ? action(acts[1], 1) : null,
      busy: running !== undefined,
    };
  };
  const groups: TagFixGroup[] = [];
  for (const a of input.accounts) {
    const items = input.problems.filter((p) => p.account === a.id).map(item);
    if (!items.length) continue;
    if (!allMode) {
      groups.push({ key: a.id, head: false, letter: '', aBg: '', aInk: '', email: '', mt: '0px', items });
      continue;
    }
    const mt = groups.length ? '10px' : '0px';
    groups.push({ key: a.id, head: true, letter: a.letter, aBg: a.bg, aInk: a.ink, email: a.email, mt, items });
  }
  return { sub: allMode ? m.switcher_all() : (input.accounts[0]?.email ?? ''), groups };
}

/** Toast after a successful action (without "Undo"). */
export function tagFixToast(p: TagProblem, action: TagFix, tags: readonly Tag[]): string {
  if (p.kind === 'unlinked')
    return action === 'toFolder'
      ? m.tagfix_done_to_folder({ name: p.name })
      : p.link
        ? m.tagfix_done_link({ name: nameOf(tags, p.link) })
        : m.tagfix_done_adopt({ name: p.name });
  if (action === 'take' && p.kind === 'renamed') return m.tagfix_done_take({ name: p.name ?? '' });
  const name = nameOf(tags, p.tag);
  if (action === 'back') return m.tagfix_done_back({ name });
  if (action === 'align') return m.tagfix_done_align({ name });
  return m.tagfix_done_unlink();
}

/** Error toast of an action: name already taken at that place, otherwise like other changes. */
export function tagFixError(error: unknown): string {
  if (error instanceof TagFixError)
    return error.reason === 'tag'
      ? m.tagfix_error_tag({ name: error.label })
      : m.tagfix_error_folder({ name: error.label });
  return failText(error, m.error_pref());
}
