import { goto } from '$app/navigation';
import { resolve } from '$app/paths';
import { compose, draftRef, type ComposeReturn } from '#lib/state/compose.svelte.ts';
import { search } from '#lib/state/search.svelte.ts';

/**
 * Compose with a draft once it has loaded (`cmpFromDraft`): row, J/K, search hit, "Cancel send" and "Send now".
 * Only without another navigation since `since` (`search.mark()`, by default now): a draft that loads after the
 * user went elsewhere opens nothing. `sendAt` prefills "Send later".
 */
export async function openDraft(
  account: string,
  id: string,
  ret: ComposeReturn,
  { sendAt, since = search.mark() }: { sendAt?: number | undefined; since?: number } = {},
): Promise<void> {
  const ok = await compose.openDraft(account, id, ret, sendAt);
  if (ok && search.stays(since))
    void goto(resolve('/compose/[draft]', { draft: encodeURIComponent(draftRef({ account, id })) }));
}
