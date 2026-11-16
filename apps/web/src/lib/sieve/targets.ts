/** Targets of the actions "move to" and "add tag" as paths for the Sieve script. */
import type { Mailbox } from '@roedy/jmap';
import type { SieveTargets } from '#lib/sieve/generate.ts';
import { TAG_ROOT } from '#lib/state/mailboxes.svelte.ts';
import { mailboxPath, type Tag } from '#lib/state/tags.svelte.ts';

/**
 * Targets of an account: folders with the full path, a tag via its mailbox in
 * the account, without one `Tags/<path of the tag>`.
 */
export function sieveTargets(account: string, boxes: readonly Mailbox[], list: readonly Tag[]): SieveTargets {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const tagById = new Map(list.map((t) => [t.id, t]));
  const folder = (id: string): string | null => {
    const box = byId.get(id);
    return box ? mailboxPath(byId, box) : null;
  };
  return {
    folder,
    tag(id) {
      const tag = tagById.get(id);
      if (!tag) return null;
      const link = tag.links.find((l) => l.mail_account_id === account);
      const linked = link ? folder(link.mailbox_id) : null;
      if (linked !== null) return linked;
      const names: string[] = [];
      const seen = new Set<string>();
      for (let t: Tag | undefined = tag; t && !seen.has(t.id); t = t.parent_id ? tagById.get(t.parent_id) : undefined) {
        seen.add(t.id);
        names.unshift(t.name);
      }
      return [TAG_ROOT, ...names].join('/');
    },
  };
}
