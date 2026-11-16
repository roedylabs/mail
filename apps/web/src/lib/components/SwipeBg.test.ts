import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { swipeAction } from '#lib/swipe.ts';
import SwipeBg from './SwipeBg.svelte';

const row = { unread: true, star: false };
const inbox = { role: 'inbox' } as const;

describe('SwipeBg', () => {
  it('shows the action to the right on the left (icon, text), the one to the left on the right (text, icon)', () => {
    const left = swipeAction('del', row, inbox);
    const right = swipeAction('read', row, inbox);
    const { container } = render(SwipeBg, { left, right });
    const bg = container.querySelector<HTMLElement>('[data-sw-bg]')!;
    expect(bg).toHaveAttribute('aria-hidden', 'true');
    expect(bg.children).toHaveLength(2);
    const [r, l] = [...bg.children] as HTMLElement[];
    expect(r).toHaveTextContent('Read');
    expect(r!.firstElementChild).toHaveClass('tabler-icon-mail-opened');
    expect(l).toHaveTextContent('Delete');
    expect(l!.lastElementChild).toHaveClass('tabler-icon-trash');
  });

  it('leaves the side of a direction without an action empty, but keeps both children', () => {
    const { container } = render(SwipeBg, { left: null, right: swipeAction('star', row, inbox) });
    const bg = container.querySelector<HTMLElement>('[data-sw-bg]')!;
    expect(bg.children).toHaveLength(2);
    expect(bg.children[0]).toHaveTextContent('Flag');
    expect(bg.children[1]).toBeEmptyDOMElement();
  });
});
