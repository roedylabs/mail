import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { DebugBarValues } from '#lib/developer.ts';
import DebugBar from './DebugBar.svelte';

const VALUES: DebugBarValues = { dbgText: 'Desktop · 1440×900 · /admin/developer', dbgB: '18px' };

afterEach(cleanup);

describe('DebugBar', () => {
  it('shows brand and version', () => {
    const { container } = render(DebugBar, VALUES);
    expect(container.querySelector('.tag')).toHaveTextContent('DEBUG');
    expect(container.querySelector('.text')).toHaveTextContent(VALUES.dbgText);
  });

  it('stays hidden from screen readers', () => {
    const { container } = render(DebugBar, VALUES);
    expect(container.querySelector('.bar')).toHaveAttribute('aria-hidden', 'true');
  });

  it('sits at the dbgB distance above the bottom edge', async () => {
    const { container, rerender } = render(DebugBar, VALUES);
    const bar = container.querySelector<HTMLElement>('.bar');
    expect(bar?.style.bottom).toBe('18px');
    await rerender({ ...VALUES, dbgB: '90px' });
    expect(bar?.style.bottom).toBe('90px');
  });
});
