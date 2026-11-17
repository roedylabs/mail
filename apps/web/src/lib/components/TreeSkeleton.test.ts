import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import TreeSkeleton from './TreeSkeleton.svelte';

describe('placeholder rows of folder tree and tag list', () => {
  it.each([
    ['folders', 'Loading folders', 4],
    ['tags', 'Loading tags', 3],
  ] as const)('%s: busy status with its rows', (kind, label, n) => {
    const { getByRole } = render(TreeSkeleton, { kind, isMobile: false, lblOp: 1 });
    const status = getByRole('status', { name: label });
    expect(status).toHaveAttribute('aria-busy', 'true');
    const rows = status.querySelectorAll('.row');
    expect(rows).toHaveLength(n);
    expect([...rows].map((r) => (r.querySelector('.bar') as HTMLElement).style.width)).toEqual(
      ['58%', '42%', '50%', '36%'].slice(0, n),
    );
    expect([...rows].map((r) => (r.querySelector('.tile') as HTMLElement).style.animationDelay)).toEqual(
      ['0ms', '150ms', '300ms', '450ms'].slice(0, n),
    );
  });

  it('hides the label bars in the collapsed sidebar and grows the rows on mobile', () => {
    const { getByRole } = render(TreeSkeleton, { kind: 'tags', isMobile: true, lblOp: 0 });
    const status = getByRole('status');
    expect(status).toHaveClass('mobile');
    expect(status.style.getPropertyValue('--lbl-op')).toBe('0');
  });
});
