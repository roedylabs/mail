import { render, within } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { describe, expect, it } from 'vitest';
import type { PasswordRuleId } from '#lib/password.ts';
import PasswordCheck from './PasswordCheck.svelte';

function check(password: string, failed: PasswordRuleId[] = []) {
  const props = $state({ password, confirm: '', rulesId: 'rules', tile: 48, failed });
  return { view: render(PasswordCheck, props), props };
}

const rule = (view: { container: HTMLElement }, name: RegExp): HTMLElement =>
  within(within(view.container).getByRole('list', { name: 'Password requirements' }))
    .getAllByRole('listitem')
    .find((li) => name.test(li.textContent ?? ''))!;

describe('PasswordCheck', () => {
  it('marks the rules met while typing and "Passwords match"', () => {
    const { view, props } = check('Lakeside-Harbor-2026');
    expect(rule(view, /10 characters/)).toHaveClass('ok');
    expect(rule(view, /match/)).not.toHaveClass('ok');
    props.confirm = 'Lakeside-Harbor-2026';
    flushSync();
    expect(rule(view, /match/)).toHaveClass('ok');
  });

  it('shows the rules the server rejected red until the password changes', () => {
    const { view, props } = check('Lakeside-Harbor-2026', ['len']);
    const len = rule(view, /10 characters/);
    expect(len).toHaveClass('bad');
    expect(len).not.toHaveClass('ok');
    expect(len).toHaveTextContent('not met yet');
    props.password = 'Lakeside-Harbor-2027';
    flushSync();
    expect(rule(view, /10 characters/)).not.toHaveClass('bad');
    expect(rule(view, /10 characters/)).toHaveClass('ok');
  });
});
