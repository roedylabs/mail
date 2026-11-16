import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import Splash from './Splash.svelte';

describe('splash screen', () => {
  it('reports the loading state with the app name', () => {
    const { getByRole, getByText } = render(Splash, { appName: 'Roedy Mail', logo: { isMark: true }, splash: 'on' });
    expect(getByRole('status', { name: 'Loading Roedy Mail' })).not.toHaveClass('out');
    expect(getByText('Roedy Mail')).toBeInTheDocument();
  });

  it('fades out with "out"', () => {
    const { getByRole } = render(Splash, { appName: 'Post', logo: { isInit: true, text: 'P' }, splash: 'out' });
    expect(getByRole('status')).toHaveClass('out');
  });
});
