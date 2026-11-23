import { render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import PasswordField from './PasswordField.svelte';

const base = {
  id: 'pw',
  label: 'Password',
  name: 'password',
  autocomplete: 'current-password' as const,
  value: '',
  oninput: () => {},
};

describe('PasswordField', () => {
  it('describes the field by its error line while it shows, besides the page’s ids', () => {
    const plain = render(PasswordField, { ...base, describedby: 'hint' });
    expect(plain.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'hint');
    plain.unmount();
    const failed = render(PasswordField, { ...base, describedby: 'hint', error: 'Wrong password.' });
    expect(failed.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'hint pw-err');
    expect(failed.getByRole('alert')).toHaveAttribute('id', 'pw-err');
    failed.unmount();
    const once = render(PasswordField, { ...base, describedby: 'pw-err hint', error: 'Wrong password.' });
    expect(once.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'pw-err hint');
  });
});
