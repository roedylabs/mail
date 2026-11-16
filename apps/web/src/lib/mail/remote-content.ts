/**
 * External content: whether an email loads
 * images from foreign servers (`extMode` and `extAllow` from `prefs`, the
 * one-time permission from `message`), the banner of the reading view (`rd.msgs[].hb`), the
 * values of the "External content" section in Settings › General and allowing
 * a sender with undo. Senders are stored in lower case in `extAllow`, as the
 * backend stores them.
 */
import { m } from '#lib/paraglide/messages.js';
import { EXT_MODES } from '#lib/settings-choices.ts';
import { prefs, type Settings } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

export { EXT_MODES };

export type ExtMode = Settings['extMode'];

/** Sender as in `extAllow`: address without surrounding whitespace, lower case. */
export function senderKey(email: string | null | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/** Maximum number of allowed senders and length of an address (like `settings::Senders` in the backend). */
export const MAX_SENDERS = 1000;
const MAX_LEN = 254;

/**
 * Sender the backend accepts in `extAllow`: `@` with parts before and
 * after it, without control characters, at most 254 characters; plus room in the list.
 */
export function canAllow(settings: Pick<Settings, 'extAllow'>, sender: string | null | undefined): boolean {
  const key = senderKey(sender);
  const at = key.lastIndexOf('@');
  // Length in bytes (UTF-8) like the backend.
  const valid =
    new TextEncoder().encode(key).length <= MAX_LEN &&
    at > 0 &&
    at < key.length - 1 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f-\u009f]/.test(key);
  return valid && (settings.extAllow.includes(key) || settings.extAllow.length < MAX_SENDERS);
}

/**
 * Load images from foreign servers: allowed once, "Always load" or, with
 * "Ask", an allowed sender; "Never load" only once.
 */
export function loadsRemote(
  settings: Pick<Settings, 'extMode' | 'extAllow'>,
  sender: string | null | undefined,
  once: boolean,
): boolean {
  if (once || settings.extMode === 'always') return true;
  const key = senderKey(sender);
  return settings.extMode === 'ask' && !!key && settings.extAllow.includes(key);
}

/** Banner above an HTML email with blocked content (`hb.showBar` etc.). */
export interface RemoteBanner {
  showBar: boolean;
  barTitle: string;
  barSub: string;
  /** "Always load from this sender": not with "Never load" and not without a valid sender (`canAllow`). */
  canAlways: boolean;
}

export function remoteBanner(
  settings: Pick<Settings, 'extMode' | 'extAllow'>,
  blocked: number,
  sender: string | null | undefined,
): RemoteBanner {
  const never = settings.extMode === 'never';
  return {
    showBar: blocked > 0,
    barTitle: never ? m.read_ext_off() : m.read_ext_blocked(),
    barSub: blocked === 1 ? m.read_ext_sub_one() : m.read_ext_sub({ n: blocked }),
    canAlways: !never && canAllow(settings, sender),
  };
}

/** Description of the chosen setting (`extSum`). */
export function extSummary(mode: ExtMode): string {
  if (mode === 'always') return m.ext_sum_always();
  if (mode === 'never') return m.ext_sum_never();
  return m.ext_sum_ask();
}

/** Notice above the list of allowed senders (`extListNote`); it only applies with "Ask". */
export function extListNote(mode: ExtMode): string {
  return mode === 'ask' ? m.ext_list_note() : m.ext_list_note_inactive();
}

/** Label of the setting in the segment. */
export function extModeLabel(mode: ExtMode): string {
  if (mode === 'always') return m.ext_mode_always();
  if (mode === 'never') return m.ext_mode_never();
  return m.ext_mode_ask();
}

/** "Always load from this sender": allow, toast with undo. */
export function allowSender(sender: string): void {
  const key = senderKey(sender);
  if (!canAllow(prefs.values, key)) return;
  const added = !prefs.values.extAllow.includes(key);
  if (added) prefs.set({ extAllow: [...prefs.values.extAllow, key] });
  ui.toasts.defer({
    text: m.read_ext_allowed({ email: key }),
    revert: () => {
      if (added) prefs.set({ extAllow: prefs.values.extAllow.filter((x) => x !== key) });
    },
  });
}

/** Remove an allowance (Settings › General), toast with undo at the old position. */
export function removeSender(sender: string): void {
  const list = prefs.values.extAllow;
  const at = list.indexOf(sender);
  if (at < 0) return;
  prefs.set({ extAllow: list.filter((x) => x !== sender) });
  ui.toasts.defer({
    text: m.ext_removed({ email: sender }),
    revert: () => {
      const now = prefs.values.extAllow;
      if (now.includes(sender)) return;
      prefs.set({ extAllow: [...now.slice(0, at), sender, ...now.slice(at)] });
    },
  });
}
