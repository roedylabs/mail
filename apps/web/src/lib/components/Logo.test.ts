import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Logo from './Logo.svelte';

describe('Logo', () => {
  it('shows the mark by default with unique masks per instance', () => {
    const first = render(Logo).container;
    const second = render(Logo).container;
    const ids = [first, second].flatMap((c) => [...c.querySelectorAll('mask')].map((mask) => mask.id));
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    const paths = first.querySelectorAll('svg > path');
    expect(paths[0]).toHaveAttribute('mask', `url(#${ids[0]})`);
    expect(paths[1]).toHaveAttribute('mask', `url(#${ids[1]})`);
  });

  it('shows the initial in the given size', () => {
    const { getByText, container } = render(Logo, { logo: { isInit: true, text: 'RM', fs: '47cqmin' } });
    expect(getByText('RM')).toHaveInlineStyle({ fontSize: '47cqmin' });
    expect(container.querySelector('svg')).toBeNull();
  });

  it('shows known icons and skips unknown ones', () => {
    expect(
      render(Logo, { logo: { isIcon: true, icon: 'ti-mountain' } }).container.querySelector('.tabler-icon-mountain'),
    ).not.toBeNull();
    expect(render(Logo, { logo: { isIcon: true, icon: 'ti-unknown' } }).container.querySelector('svg')).toBeNull();
  });

  it('shows images filled or with a border', () => {
    const { container } = render(Logo, { logo: { isPad: true, src: '/logo.png' } });
    expect(container.querySelector('img')).toHaveClass('pad');
    expect(container.querySelector('img')).toHaveAttribute('src', '/logo.png');
  });
});
