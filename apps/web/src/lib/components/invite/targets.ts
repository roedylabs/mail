/**
 * Elements of the invitation page the page reaches into: the heading and the
 * card of the shell (focus and shake), "Try again" of the load error and the
 * fields of the steps.
 */
import type { Attachment } from 'svelte/attachments';
import type { InviteField } from '#lib/invite.svelte.ts';

export type InviteTarget = 'heading' | 'card' | 'retry' | InviteField;

/** Registry of the targets; `reg` as an attachment on the element. */
export class InviteTargets {
  private readonly els = new Map<InviteTarget, HTMLElement>();

  readonly reg = (key: InviteTarget): Attachment<HTMLElement> => {
    return (el) => {
      this.els.set(key, el);
      return () => {
        if (this.els.get(key) === el) this.els.delete(key);
      };
    };
  };

  get(key: InviteTarget): HTMLElement | undefined {
    return this.els.get(key);
  }

  /** Registers a component's bound element as `key` until the returned cleanup runs (for `$effect`). */
  hold(key: InviteTarget, el: HTMLElement | undefined): () => void {
    if (el) this.els.set(key, el);
    return () => {
      if (el && this.els.get(key) === el) this.els.delete(key);
    };
  }
}
