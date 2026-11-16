import { MA_COLORS } from '@roedy/tokens';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '#lib/api.ts';
import { mockApi } from '#lib/state/fetch-mock.ts';
import { TagEdit, type TagLeaveNav, type TagOpenNav } from '#lib/state/tag-edit.svelte.ts';
import { Tags, type Tag } from '#lib/state/tags.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { m } from '#lib/paraglide/messages.js';

function tag(id: string, name: string, overrides: Partial<Tag> = {}): Tag {
  return { id, name, parent_id: null, color: null, position: 0, links: [], created_at: '', ...overrides };
}

const LIST = [
  tag('f', 'Finance', { color: 1 }),
  tag('r', 'Invoices', { parent_id: 'f' }),
  tag('q', 'Quarter', { parent_id: 'r' }),
  tag('p', 'Private', { color: 4, position: 1 }),
];

/** Tags from `LIST`; the tests replace the calls to the server. */
async function setup(list: Tag[] = LIST) {
  mockApi({ 'GET tags': [{ body: { tags: list } }] });
  const tags = new Tags(() => null);
  await tags.ensure();
  const nav = { open: vi.fn(), inbox: vi.fn(), restore: vi.fn() } satisfies TagOpenNav & TagLeaveNav;
  return { tags, edit: new TagEdit(tags), nav };
}

describe('name dialog for tags', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    ui.reset();
    vi.useRealTimers();
  });

  it('shows "New tag" with the next color, a subtag with the parent tag\'s color', async () => {
    const { edit, nav } = await setup();
    edit.add();
    const v = edit.values(() => nav);
    expect(v).toMatchObject({
      nameIsTag: true,
      nameTitle: 'New tag',
      nameSub: 'For all email accounts',
      nameIcon: 'ti-tag',
      namePh: 'e.g. Invoices',
      nameBtnLabel: 'Create',
      nameOk: false,
      namePickLabel: 'Top level',
      namePickIcon: 'ti-tags',
      nameTileBg: MA_COLORS[2][1],
    });
    expect(v?.nameSw.map((s) => s.on)).toEqual([false, false, true, false, false, false]);
    expect(v?.namePickOpts.map((o) => [o.label, o.depth, o.dot])).toEqual([
      ['Top level', 0, null],
      ['Finance', 1, MA_COLORS[1][1]],
      ['Invoices', 2, MA_COLORS[1][1]],
      ['Quarter', 3, MA_COLORS[1][1]],
      ['Private', 1, MA_COLORS[4][1]],
    ]);
    // A parent tag brings its color along as long as none is chosen.
    v?.namePickOpts[4]?.onClick();
    expect(edit.dialog).toMatchObject({ parent: 'p', color: 4, pick: false });
    expect(edit.values(() => nav)).toMatchObject({ nameTitle: 'New subtag', namePickLabel: 'Private' });
    edit.values(() => nav)?.nameSw[0]?.onClick();
    edit.values(() => nav)?.namePickOpts[2]?.onClick();
    expect(edit.dialog).toMatchObject({ parent: 'r', color: 0, colorSet: true });
    expect(edit.values(() => nav)?.namePickLabel).toBe('Finance › Invoices');
  });

  it('creates immediately, shows the tag and deletes it again with undo', async () => {
    const { tags, edit, nav } = await setup();
    const create = vi.spyOn(tags, 'create').mockResolvedValue(tag('n', 'New', { parent_id: 'r' }));
    const remove = vi.spyOn(tags, 'remove').mockResolvedValue();
    edit.add('r');
    edit.setName(' New ');
    await edit.commit(nav);
    expect(create).toHaveBeenCalledWith('New', 'r', 1);
    expect(edit.dialog).toBeNull();
    expect(nav.open).toHaveBeenCalledWith('n');
    expect(tags.isOpen('f') && tags.isOpen('r')).toBe(true);
    expect(ui.toast).toMatchObject({ text: m.tags_created({ name: 'New' }), undo: true });
    ui.toasts.undo();
    expect(nav.restore).toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('n');
  });

  it('reports a taken name on the level and reopens after an error', async () => {
    const { tags, edit, nav } = await setup();
    const create = vi.spyOn(tags, 'create');
    edit.add('f');
    edit.setName('invoices');
    await edit.commit(nav);
    expect(create).not.toHaveBeenCalled();
    expect(edit.dialog).not.toBeNull();
    expect(ui.toast).toMatchObject({ text: m.tagfix_error_tag({ name: 'invoices' }), error: true });

    create.mockRejectedValue(new ApiError(422, { error: 'invalid', fields: { name: { code: 'taken' } } }));
    edit.setName('New');
    await edit.commit(nav);
    expect(edit.dialog).toMatchObject({ name: 'New', parent: 'f' });
    expect(ui.toast).toMatchObject({ text: m.tagfix_error_tag({ name: 'New' }), error: true });
    create.mockRejectedValue(new ApiError(422, { error: 'too_many', max: 1000 }));
    edit.setName('More');
    await edit.commit(nav);
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
  });

  it('edits after the toast, with undo without a call; unchanged changes nothing', async () => {
    const { tags, edit, nav } = await setup();
    const save = vi.spyOn(tags, 'edit').mockResolvedValue();
    edit.edit('r');
    const v = edit.values(() => nav);
    expect(v).toMatchObject({
      nameTitle: 'Edit tag',
      nameBtnLabel: 'Save',
      nameVal: 'Invoices',
      namePickLabel: 'Finance',
      nameTileBg: MA_COLORS[1][1],
    });
    // The tag itself and its subtags are not offered.
    expect(v?.namePickOpts.map((o) => o.label)).toEqual(['Top level', 'Finance', 'Private']);

    edit.setName('Receipts');
    await edit.commit(nav);
    expect(ui.toast).toMatchObject({ text: m.tags_saved({ name: 'Receipts' }), undo: true });
    expect(tags.tree([])[0]?.children[0]?.name).toBe('Receipts');
    ui.toasts.undo();
    expect(tags.tree([])[0]?.children[0]?.name).toBe('Invoices');
    expect(save).not.toHaveBeenCalled();

    // Unchanged (also the inherited color): no toast.
    ui.toasts.dismiss();
    edit.edit('r');
    await edit.commit(nav);
    expect(ui.toast).toBeNull();

    // Moving takes the inherited color along so that the tag looks as before.
    edit.edit('r');
    edit.setParent('p', 4);
    await edit.commit(nav);
    expect(edit.dialog).toBeNull();
    expect(ui.toast).toMatchObject({ text: m.tags_moved({ name: 'Invoices' }) });
    expect(tags.tree([]).map((t) => t.name)).toEqual(['Finance', 'Private']);
    expect(tags.isOpen('p')).toBe(true);
    ui.toasts.dismiss();
    expect(save).toHaveBeenCalledWith('r', { parent_id: 'p', color: 1 }, false);
  });

  it('reverts the display after a failed save', async () => {
    const { tags, edit, nav } = await setup();
    vi.spyOn(tags, 'edit').mockRejectedValue(
      new ApiError(422, { error: 'invalid', fields: { name: { code: 'taken' } } }),
    );
    edit.edit('p');
    edit.values(() => nav)?.nameSw[3]?.onClick();
    edit.setName('Family');
    await edit.commit(nav);
    ui.toasts.dismiss();
    await vi.advanceTimersByTimeAsync(0);
    expect(tags.list?.find((t) => t.id === 'p')).toMatchObject({ name: 'Private', color: 4 });
    expect(ui.toast).toMatchObject({ text: m.tagfix_error_tag({ name: 'Family' }), error: true });
  });

  it('deletes after confirmation with messages and subtags, undo leads back', async () => {
    const { tags, edit, nav } = await setup();
    vi.spyOn(tags, 'usage').mockResolvedValue({ sub: 2, mails: 5 });
    const remove = vi.spyOn(tags, 'remove').mockResolvedValue();
    await edit.remove('f', () => nav);
    expect(ui.confirm).toMatchObject({
      title: m.tags_delete_title({ name: 'Finance' }),
      text: `${m.tags_delete_mail({ n: 5 })} ${m.tags_delete_sub({ n: 2 })}`,
      icon: 'ti-tag-off',
      ok: 'Delete tag',
      danger: true,
    });
    ui.confirmOk();
    expect(nav.inbox).toHaveBeenCalled();
    expect(tags.tree([]).map((t) => t.name)).toEqual(['Private']);
    expect(ui.toast).toMatchObject({ text: m.tags_deleted({ name: 'Finance' }), undo: true });
    ui.toasts.undo();
    expect(nav.restore).toHaveBeenCalled();
    expect(tags.tree([]).map((t) => t.name)).toEqual(['Finance', 'Private']);
    expect(remove).not.toHaveBeenCalled();

    vi.spyOn(tags, 'usage').mockResolvedValue({ sub: 0, mails: 1 });
    await edit.remove('q', () => nav);
    expect(ui.confirm?.text).toBe('The tag will be removed from one message.');
    ui.confirmOk();
    ui.toasts.dismiss();
    expect(remove).toHaveBeenCalledWith('q');
    vi.spyOn(tags, 'usage').mockResolvedValue({ sub: 1, mails: 0 });
    await edit.remove('r', () => nav);
    expect(ui.confirm?.text).toBe(`${m.tags_delete_none()} ${m.tags_delete_sub_one()}`);
  });

  it('does not ask when the view has left the tag, counts only once and reports errors of the count', async () => {
    const { tags, edit, nav } = await setup();
    let done: (v: { sub: number; mails: number }) => void = () => undefined;
    const usage = vi.spyOn(tags, 'usage').mockReturnValue(new Promise((r) => (done = r)));
    const first = edit.remove('p', () => null);
    void edit.remove('p', () => nav);
    done({ sub: 0, mails: 0 });
    await first;
    expect(usage).toHaveBeenCalledTimes(1);
    expect(ui.confirm).toBeNull();

    usage.mockRejectedValue(new Error('broken'));
    await edit.remove('p', () => nav);
    expect(ui.confirm).toBeNull();
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
  });
});
