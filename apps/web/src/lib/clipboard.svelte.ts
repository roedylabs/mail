/**
 * Copy to the clipboard (setup, invitation, error page).
 * Without a secure context (`http://` in the LAN) there is no `navigator.clipboard`;
 * then via a text field and `execCommand('copy')`. The pages show
 * "Copied" only if it worked (`Copied`).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyByCommand(text);
  }
}

/**
 * Copies text that is still being loaded (for example a link from the server).
 * Safari only allows the clipboard within the click gesture; a
 * `ClipboardItem` with a promise keeps the permission until the text is there.
 * Without `ClipboardItem` (or if it fails): load first, then `copyText`.
 * If loading fails, it throws the error of the promise.
 */
export async function copyPending(text: Promise<string>): Promise<boolean> {
  const clipboard = (navigator as Partial<Navigator>).clipboard;
  if (typeof ClipboardItem !== 'undefined' && typeof clipboard?.write === 'function') {
    try {
      const blob = text.then((t) => new Blob([t], { type: 'text/plain' }));
      await clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    } catch {
      // Try again below with the loaded text (or throw the load error).
    }
  }
  return copyText(await text);
}

function copyByCommand(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    // Deprecated, but the only way outside secure contexts.
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Duration of "Copied" on a button (`copied` of the guest pages). */
export const COPIED_MS = 2000;

/** "Copied" for one of several copy buttons of a page, only after success. */
export class Copied<K extends string> {
  /** Button that currently shows "Copied". */
  key = $state<K | null>(null);
  #timer: ReturnType<typeof setTimeout> | undefined;

  async copy(text: string, key: K): Promise<void> {
    if (!(await copyText(text))) return;
    clearTimeout(this.#timer);
    this.key = key;
    this.#timer = setTimeout(() => (this.key = null), COPIED_MS);
  }

  /** When leaving the page. */
  stop(): void {
    clearTimeout(this.#timer);
  }
}
