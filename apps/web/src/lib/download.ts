/**
 * Files to download: the recovery codes of the invitation and under
 * Account › Security, attachments and source of the reading view.
 */
import { m } from '#lib/paraglide/messages.js';
import { devLog } from '#lib/state/devlog.svelte.ts';

/** Offers `blob` as file `name`; `false` if the browser cannot. */
export function downloadBlob(name: string, blob: Blob): boolean {
  try {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (error) {
    devLog.add('error', m.dev_log_download_failed({ message: error instanceof Error ? error.message : String(error) }));
    return false;
  }
}

/** Offers `text` as file `name`; `false` if the browser cannot. */
export function downloadText(name: string, text: string): boolean {
  return downloadBlob(name, new Blob([text], { type: 'text/plain' }));
}

/** "‹App› – recovery codes", the address and one code per line (`recovery-codes.txt`). */
export function downloadCodes(app: string, email: string, codes: readonly string[]): boolean {
  return downloadText(m.codes_file_name(), `${m.codes_file({ app })}\n${email}\n\n${codes.join('\n')}\n`);
}
