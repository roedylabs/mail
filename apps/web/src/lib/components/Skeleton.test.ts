import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Skeleton from './Skeleton.svelte';
import { skeletonValues } from '#lib/shell.ts';

describe('skeleton', () => {
  it('computes rows and paragraphs like the shell', () => {
    const v = skeletonValues('pfA');
    expect(v).toMatchObject({ skPf: true, skPfA: true, skPfB: false, skSet: false });
    expect(v.skRows).toHaveLength(7);
    expect(v.skRows[1]).toEqual({ a: '30%', b: '74%', d: '110ms', sep: true });
    expect(v.skRows3[0]).toEqual({ a: '48%', b: '62%', d: '0ms', sep: false });
    expect(v.skParas[3]).toEqual({ w: '58%', mb: '14px', d: '270ms' });
    expect(skeletonValues('set', 'ueb')).toMatchObject({ skSet: true, skSetUeb: true, skSetList: false });
  });

  it.each([
    ['pfA', false, 'Loading messages'],
    ['pfB', false, 'Loading messages'],
    ['rd', false, 'Loading message'],
    ['home', false, 'Loading'],
    ['srch', false, 'Loading search results'],
    ['set', false, 'Loading data from the server'],
    ['pfB', true, 'Loading messages'],
    ['rd', true, 'Loading message'],
    ['home', true, 'Loading'],
    ['srch', true, 'Loading search'],
    ['set', true, 'Loading data from the server'],
  ] as const)('%s (mobile: %s) reports "%s"', (kind, isMobile, label) => {
    const { getAllByRole } = render(Skeleton, { kind, isMobile });
    expect(getAllByRole('status').map((s) => s.getAttribute('aria-label'))).toEqual([label]);
  });

  it('shows a custom hint when the data does not come from the mail server', () => {
    const { getByText, queryByText } = render(Skeleton, { kind: 'set', set: 'list', note: 'Loading data …' });
    expect(getByText('Loading data …')).toBeInTheDocument();
    expect(queryByText('Loading data from the mail server …')).not.toBeInTheDocument();
  });

  it('names the mail server for settings', () => {
    const { getByText, container } = render(Skeleton, { kind: 'set', set: 'list' });
    expect(getByText('Loading data from the mail server …')).toBeInTheDocument();
    expect(container.querySelectorAll('.list-row')).toHaveLength(3);
  });
});
