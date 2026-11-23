/**
 * Elements of the setup wizard the page reaches into: the focus targets of a
 * step (its fields and heading), the card that shakes and the step graphic's
 * tile that wobbles on an error.
 */
import type { Attachment } from 'svelte/attachments';
import type { Focus } from '#lib/setup.svelte.ts';

export type SetupTarget = Focus | 'card' | 'tile';

/** Registry of the targets; `reg` as an attachment on the element. */
export class SetupTargets {
  private readonly els = new Map<SetupTarget, HTMLElement>();

  readonly reg = (key: SetupTarget): Attachment<HTMLElement> => {
    return (el) => {
      this.els.set(key, el);
      return () => {
        if (this.els.get(key) === el) this.els.delete(key);
      };
    };
  };

  get(key: SetupTarget): HTMLElement | undefined {
    return this.els.get(key);
  }

  /** For `bind:` of a component's element (`FormField`'s input). */
  put(key: SetupTarget, el: HTMLElement | undefined): void {
    if (el) this.els.set(key, el);
    else this.els.delete(key);
  }

  /** Registers a component's bound element as `key` until the returned cleanup runs (for `$effect`). */
  hold(key: SetupTarget, el: HTMLElement | undefined): () => void {
    if (el) this.els.set(key, el);
    return () => {
      if (el && this.els.get(key) === el) this.els.delete(key);
    };
  }

  /** The input registered as `key` (getter of a function binding). */
  input(key: SetupTarget): HTMLInputElement | undefined {
    const el = this.els.get(key);
    return el instanceof HTMLInputElement ? el : undefined;
  }
}
