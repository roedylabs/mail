import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import MessageBox from './MessageBox.svelte';

describe('MessageBox', () => {
  it('hides the running lock from screen readers: the text names the wait', () => {
    const view = render(MessageBox, {
      role: 'alert',
      icon: 'ti-lock',
      title: 'Too many attempts.',
      text: 'Try again in 15 minutes.',
      lock: { left: 900, total: 900 },
    });
    const alert = view.getByRole('alert');
    expect(alert).toHaveTextContent('Too many attempts.');
    expect(alert.querySelector('.msg-extra')).toHaveAttribute('aria-hidden', 'true');
    expect(alert.querySelector('.time')).toHaveTextContent('15:00');
    expect(alert.querySelector<HTMLElement>('.lock-bar span')?.style.width).toBe('100%');
  });

  it('reads the time where the text names no wait', () => {
    const view = render(MessageBox, {
      role: 'alert',
      icon: 'ti-lock',
      text: 'Entry is locked for a moment.',
      lock: { left: 12, total: 30, read: true },
    });
    const row = view.getByRole('alert').querySelector('.msg-extra')!;
    expect(row).not.toHaveAttribute('aria-hidden');
    expect(row.querySelector('.lock-bar')).toHaveAttribute('aria-hidden', 'true');
    expect(row.querySelector<HTMLElement>('.lock-bar span')?.style.width).toBe('40%');
    expect(row.querySelector('.time')).toHaveTextContent('0:12');
  });

  it('shows the short line under a field and a soft notice', () => {
    const line = render(MessageBox, {
      variant: 'line',
      role: 'alert',
      icon: 'ti-shield-x',
      text: 'Enter all 6 digits.',
    });
    expect(line.getByRole('alert')).toHaveClass('note', 'err');
    line.unmount();
    const soft = render(MessageBox, { role: 'status', tone: 'soft', icon: 'ti-info-circle', text: 'Maintenance.' });
    expect(soft.getByRole('status')).toHaveClass('msg', 'soft');
  });
});
