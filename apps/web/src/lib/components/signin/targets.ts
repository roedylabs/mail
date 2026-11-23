/**
 * Elements of the sign-in page the page reaches into: the fields of every
 * screen and the heading (focus), and the card that shakes on an error.
 */
import type { Attachment } from 'svelte/attachments';
import type { Field } from '#lib/login.svelte.ts';

export type SignInTarget = Field | 'heading' | 'card';

/** Registry of the targets; `reg` as an attachment on the element. */
export class SignInTargets {
  private readonly els = new Map<SignInTarget, HTMLElement>();

  readonly reg = (key: SignInTarget): Attachment<HTMLElement> => {
    return (el) => {
      this.els.set(key, el);
      return () => {
        if (this.els.get(key) === el) this.els.delete(key);
      };
    };
  };

  get(key: SignInTarget): HTMLElement | undefined {
    return this.els.get(key);
  }

  /** Registers a component's bound element as `key` until the returned cleanup runs (for `$effect`). */
  hold(key: SignInTarget, el: HTMLElement | undefined): () => void {
    if (el) this.els.set(key, el);
    return () => {
      if (el && this.els.get(key) === el) this.els.delete(key);
    };
  }
}
