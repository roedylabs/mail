import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { isIconName } from '#lib/icons.ts';
import Icon from './Icon.svelte';

describe('Icon', () => {
  it('is decorative without a label', () => {
    const { container } = render(Icon, { name: 'ti-lock' });
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('width', '1em');
    expect(svg).toHaveAttribute('stroke-width', '2');
    expect(svg).toHaveClass('tabler-icon', 'tabler-icon-lock');
  });

  it('is announced as an image with a label', () => {
    const { getByRole } = render(Icon, { name: 'ti-bug', label: 'Error', size: 24 });
    expect(getByRole('img', { name: 'Error' })).toHaveAttribute('width', '24');
  });
});

describe('isIconName', () => {
  it('knows only registered icons', () => {
    expect(isIconName('ti-mountain')).toBe(true);
    expect(isIconName('ti-does-not-exist')).toBe(false);
    expect(isIconName('toString')).toBe(false);
  });
});
