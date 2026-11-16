import type { JmapClient, Mailbox } from '@roedy/jmap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accounts, type MailAccount } from '#lib/state/accounts.svelte.ts';
import { Folders, type FolderLeaveNav, type FolderOpenNav } from '#lib/state/folders.svelte.ts';
import { FolderError, Mailboxes } from '#lib/state/mailboxes.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import { m } from '#lib/paraglide/messages.js';

function box(id: string, name: string, overrides: Partial<Mailbox> = {}): Mailbox {
  return {
    id,
    name,
    parentId: null,
    role: null,
    sortOrder: 0,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: true,
      mayDelete: true,
      maySubmit: true,
    },
    isSubscribed: true,
    ...overrides,
  };
}

const LIST = [
  box('m-in', 'Inbox', { role: 'inbox' }),
  box('m-trash', 'Trash', { role: 'trash' }),
  box('p', 'Projects', { totalEmails: 2 }),
  box('w', 'Website', { parentId: 'p', totalEmails: 3 }),
  box('r', 'Relaunch', { parentId: 'w' }),
  box('k', 'Customers'),
  box('t-root', 'Tags'),
  box('t1', 'Important', { parentId: 't-root' }),
];

/** Mailboxes from `LIST`; the tests replace the calls to the server. */
async function setup(list: Mailbox[] = LIST) {
  const client = {
    accountId: () => Promise.resolve('j1'),
    call: () => Promise.resolve({ accountId: 'j1', state: 's1', list, notFound: [] }),
  } as unknown as JmapClient;
  const boxes = new Mailboxes(() => Promise.resolve(client));
  await boxes.load('a1');
  const nav = { open: vi.fn(), inbox: vi.fn(), restore: vi.fn() } satisfies FolderOpenNav & FolderLeaveNav;
  return { boxes, folders: new Folders(boxes), nav };
}

describe('name dialog for folders', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    accounts.list = [{ id: 'a1', email: 'a1@example.com' } as MailAccount];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    ui.reset();
    accounts.list = null;
    vi.useRealTimers();
  });

  it('shows "New folder" with the selection "Location" and chooses a location', async () => {
    const { folders, nav } = await setup();
    folders.add('a1');
    const v = folders.values(() => nav);
    expect(v).toMatchObject({
      nameIsTag: false,
      nameTitle: 'New folder',
      nameSub: 'in a1@example.com',
      nameIcon: 'ti-folder-plus',
      nameBtnLabel: 'Create',
      namePh: 'e.g. Projects',
      nameOk: false,
      namePickLabel: 'Top level',
      namePickIcon: 'ti-folders',
      namePickOpen: false,
      nameSw: [],
    });
    // Without role mailboxes and tags, indented by depth.
    expect(v?.namePickOpts.map((o) => [o.label, o.depth, o.on])).toEqual([
      ['Top level', 0, true],
      ['Customers', 1, false],
      ['Projects', 1, false],
      ['Website', 2, false],
      ['Relaunch', 3, false],
    ]);
    v?.namePickToggle();
    expect(folders.values(() => nav)?.namePickOpen).toBe(true);
    v?.namePickOpts[3]?.onClick();
    v?.onNameInput('  New ');
    expect(folders.values(() => nav)).toMatchObject({
      nameTitle: 'New subfolder',
      namePickLabel: 'Projects › Website',
      namePickIcon: 'ti-folder',
      namePickOpen: false,
      nameOk: true,
    });
    folders.values(() => nav)?.nameClose();
    expect(folders.values(() => nav)).toBeNull();
  });

  it('creates immediately, shows the folder and deletes it again with undo', async () => {
    const { boxes, folders, nav } = await setup();
    const create = vi.spyOn(boxes, 'create').mockResolvedValue('n');
    const destroy = vi.spyOn(boxes, 'destroy').mockResolvedValue();
    folders.add('a1', 'w');
    folders.setName(' New ');
    await folders.commit(nav);
    expect(create).toHaveBeenCalledWith('a1', 'New', 'w');
    expect(folders.dialog).toBeNull();
    expect(nav.open).toHaveBeenCalledWith('a1', 'n');
    // Parent folder with ancestors expanded.
    expect(boxes.isOpen('a1', 'p') && boxes.isOpen('a1', 'w')).toBe(true);
    expect(ui.toast).toMatchObject({ text: m.folders_created({ name: 'New' }), undo: true });
    ui.toasts.undo();
    expect(nav.restore).toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledWith('a1', ['n']);
  });

  it('reports a taken name and keeps the dialog open', async () => {
    const { boxes, folders, nav } = await setup();
    const create = vi.spyOn(boxes, 'create');
    folders.add('a1', 'p');
    folders.setName('website');
    await folders.commit(nav);
    expect(create).not.toHaveBeenCalled();
    expect(folders.dialog).not.toBeNull();
    expect(ui.toast).toMatchObject({ text: m.folders_error_taken({ name: 'website' }), error: true });
  });

  it('reports a failed creation', async () => {
    const { boxes, folders, nav } = await setup();
    vi.spyOn(boxes, 'create').mockRejectedValue(new FolderError('Mailbox/set', [{ type: 'forbidden' }]));
    folders.add('a1');
    folders.setName('New');
    await folders.commit(nav);
    expect(nav.open).not.toHaveBeenCalled();
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
    // The input is not lost.
    expect(folders.dialog).toMatchObject({ name: 'New', parent: null });
  });

  it('renames and moves after the toast, with undo without a call', async () => {
    const { boxes, folders, nav } = await setup();
    const update = vi.spyOn(boxes, 'update').mockResolvedValue();
    folders.edit('a1', 'w');
    const v = folders.values(() => nav);
    expect(v).toMatchObject({
      nameTitle: 'Edit folder',
      nameIcon: 'ti-folder-cog',
      nameBtnLabel: 'Save',
      nameVal: 'Website',
      namePickLabel: 'Projects',
    });
    // The folder itself and its subfolders are not offered.
    expect(v?.namePickOpts.map((o) => o.label)).toEqual(['Top level', 'Customers', 'Projects']);

    folders.setName('Web presence');
    await folders.commit(nav);
    expect(ui.toast).toMatchObject({ text: m.folders_renamed({ name: 'Web presence' }), undo: true });
    expect(boxes.tree('a1')[1]?.children[0]?.name).toBe('Web presence');
    ui.toasts.undo();
    expect(boxes.tree('a1')[1]?.children[0]?.name).toBe('Website');
    expect(update).not.toHaveBeenCalled();

    folders.edit('a1', 'w');
    folders.setParent('k');
    await folders.commit(nav);
    expect(ui.toast).toMatchObject({ text: m.folders_moved({ name: 'Website' }) });
    expect(boxes.tree('a1')[0]).toMatchObject({ id: 'k', children: [{ id: 'w' }] });
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledWith('a1', 'w', { parentId: 'k' }, false);
    expect(boxes.tree('a1')[0]).toMatchObject({ id: 'k', children: [] });
  });

  it('reverts a rename if the server rejects it', async () => {
    const { boxes, folders, nav } = await setup();
    vi.spyOn(boxes, 'update').mockRejectedValue(new FolderError('Mailbox/set', [{ type: 'forbidden' }]));
    const error = vi.spyOn(ui.toasts, 'error');
    folders.edit('a1', 'k');
    folders.setName('Clientele');
    await folders.commit(nav);
    // Unchanged: nothing to do.
    folders.edit('a1', 'k');
    await folders.commit(nav);
    await vi.runAllTimersAsync();
    expect(boxes.tree('a1')[0]?.name).toBe('Customers');
    expect(error).toHaveBeenCalledWith(m.error_undo());
  });

  it('deletes after confirmation with subfolders and messages, the view goes to the inbox', async () => {
    const { boxes, folders, nav } = await setup();
    const remove = vi.spyOn(boxes, 'remove').mockResolvedValue();
    folders.remove('a1', 'p', nav);
    expect(ui.confirm).toMatchObject({
      title: m.folders_delete_title({ name: 'Projects' }),
      text: `${m.folders_delete_sub({ n: 2 })} ${m.folders_delete_mail({ n: 5 })}`,
      icon: 'ti-folder-x',
      ok: 'Delete folder',
      danger: true,
    });
    ui.confirmOk();
    expect(nav.inbox).toHaveBeenCalled();
    expect(boxes.tree('a1').map((f) => f.id)).toEqual(['k']);
    expect(ui.toast).toMatchObject({ text: m.folders_deleted({ name: 'Projects' }), undo: true });
    ui.toasts.undo();
    expect(nav.restore).toHaveBeenCalled();
    expect(boxes.tree('a1').map((f) => f.id)).toEqual(['k', 'p']);
    expect(remove).not.toHaveBeenCalled();

    folders.remove('a1', 'r', nav);
    expect(ui.confirm?.text).toBe('The folder is empty.');
    ui.confirmOk();
    await vi.runAllTimersAsync();
    expect(remove).toHaveBeenCalledWith('a1', 'r', 'm-trash', expect.any(Function));
    const keep = remove.mock.calls[0]?.[3];
    expect([keep?.('t1'), keep?.('t-root'), keep?.('m-in')]).toEqual([true, true, false]);
  });

  it('counts one subfolder and one message in the singular and stays where the view is on an error', async () => {
    const list = [
      box('m-in', 'Inbox', { role: 'inbox' }),
      box('a', 'Archiv', { totalEmails: 1 }),
      box('b', 'Old', { parentId: 'a' }),
    ];
    const { boxes, folders, nav } = await setup(list);
    vi.spyOn(boxes, 'remove').mockRejectedValue(new Error('Trash missing'));
    const error = vi.spyOn(ui.toasts, 'error');
    folders.remove('a1', 'a', nav);
    expect(ui.confirm?.text).toBe(`${m.folders_delete_sub_one()} ${m.folders_delete_mail_one()}`);
    ui.confirmOk();
    await vi.runAllTimersAsync();
    expect(nav.restore).not.toHaveBeenCalled();
    expect(boxes.tree('a1').map((f) => f.id)).toEqual(['a']);
    expect(error).toHaveBeenCalledWith(m.error_undo());
  });

  it('does not delete a created folder on sign-out', async () => {
    const { boxes, folders, nav } = await setup();
    vi.spyOn(boxes, 'create').mockResolvedValue('n');
    const destroy = vi.spyOn(boxes, 'destroy').mockResolvedValue();
    folders.add('a1');
    folders.setName('New');
    await folders.commit(nav);
    ui.reset();
    expect(destroy).not.toHaveBeenCalled();
    expect(nav.restore).not.toHaveBeenCalled();
  });

  it('does not delete branches with a role or without the right to delete', async () => {
    const list = [
      ...LIST,
      box('a', 'Archiv', { role: 'archive', parentId: 'k' }),
      box('g', 'Geteilt', { myRights: { ...LIST[0]!.myRights, mayDelete: false } }),
    ];
    const { folders, nav } = await setup(list);
    folders.remove('a1', 'k', nav);
    expect(ui.confirm).toBeNull();
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
    folders.remove('a1', 'g', nav);
    expect(ui.confirm).toBeNull();
    expect(nav.inbox).not.toHaveBeenCalled();
  });

  it('checks names of a folder with a foreign parent at its location at the server', async () => {
    const list = [...LIST, box('old', 'Old', { parentId: 'm-in' }), box('new', 'New', { parentId: 'm-in' })];
    const { boxes, folders, nav } = await setup(list);
    const update = vi.spyOn(boxes, 'update').mockResolvedValue();
    // The tree shows "Old" at the top; under the inbox there is no "Projects".
    folders.edit('a1', 'old');
    expect(folders.dialog).toMatchObject({ parent: null, origin: null });
    folders.setName('Projects');
    await folders.commit(nav);
    expect(ui.toast).toMatchObject({ text: m.folders_renamed({ name: 'Projects' }) });
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledWith('a1', 'old', { name: 'Projects' }, false);
    // "New" already lies there.
    folders.edit('a1', 'old');
    folders.setName('new');
    await folders.commit(nav);
    expect(folders.dialog).not.toBeNull();
    expect(ui.toast).toMatchObject({ text: m.folders_error_taken({ name: 'new' }), error: true });
  });

  it('does not move back on rename what was moved elsewhere, and reports deleted folders', async () => {
    const { boxes, folders, nav } = await setup();
    const update = vi.spyOn(boxes, 'update').mockResolvedValue();
    folders.edit('a1', 'w');
    // In the meantime "Website" lies under "Customers" (e.g. from another device).
    const moved = boxes.stage('a1', { id: 'w', name: 'Website', parentId: 'k' });
    folders.setName('Web presence');
    await folders.commit(nav);
    await vi.runAllTimersAsync();
    expect(update).toHaveBeenCalledWith('a1', 'w', { name: 'Web presence' }, false);
    boxes.unstage(moved);

    folders.edit('a1', 'k');
    boxes.stage('a1', { hide: ['k'] });
    folders.setName('Clientele');
    await folders.commit(nav);
    expect(update).toHaveBeenCalledTimes(1);
    expect(ui.toast).toMatchObject({ text: m.error_act(), error: true });
  });
});
