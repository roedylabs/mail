import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { codeOf, type CodeFilter } from './code.ts';
import CodeField from './CodeField.svelte';

/** A field whose page keeps the plain code (`codeOf`). */
function field(groups: number[], filter: CodeFilter, extra: Record<string, unknown> = {}) {
  const total = groups.reduce((a, b) => a + b, 0);
  const props = $state({
    id: 'code',
    name: 'code',
    label: 'Code',
    groups,
    filter,
    value: '',
    height: '52px',
    oninput: (v: string) => (props.value = codeOf(v, filter, total)),
    ...extra,
  });
  const view = render(CodeField, props);
  return { view, props, input: view.getByLabelText('Code') as HTMLInputElement };
}

const shown = (root: HTMLElement) => [...root.querySelectorAll('.box')].map((b) => b.textContent?.trim() ?? '');

describe('CodeField', () => {
  it('lays the boxes out in their groups with a separator between them', () => {
    expect(field([3, 3], 'digits').view.container.querySelectorAll('.sep')).toHaveLength(1);
    const twelve = field([4, 4, 4], 'alnum').view.container;
    expect(twelve.querySelectorAll('.box')).toHaveLength(12);
    expect(twelve.querySelectorAll('.sep')).toHaveLength(2);
    expect(twelve.querySelector('.boxes')).toHaveAttribute('aria-hidden', 'true');
  });

  it('takes a pasted code with a space in full (digits)', async () => {
    const { view, props, input } = field([3, 3], 'digits');
    expect(input).not.toHaveAttribute('maxlength');
    expect(input).toHaveAttribute('type', 'text');
    await fireEvent.input(input, { target: { value: '123 456' } });
    expect(props.value).toBe('123456');
    expect(input.value).toBe('123456');
    expect(shown(view.container)).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('upper-cases letters and drops dashes (alnum)', async () => {
    const { view, input } = field([4, 4], 'alnum');
    await fireEvent.input(input, { target: { value: 'abcd-efgh' } });
    expect(input.value).toBe('ABCDEFGH');
    expect(shown(view.container)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  });

  it('removes rejected characters and goes back with Backspace', async () => {
    const { view, input } = field([3, 3], 'digits');
    await fireEvent.input(input, { target: { value: '12a3' } });
    expect(input.value).toBe('123');
    await fireEvent.focus(input);
    // Backspace: the field loses its last character.
    await fireEvent.input(input, { target: { value: '12' } });
    expect(shown(view.container)).toEqual(['1', '2', '', '', '', '']);
    const boxes = view.container.querySelectorAll('.box');
    expect(boxes[2]).toHaveClass('active');
    expect(boxes[2]!.querySelector('.caret')).not.toBeNull();
  });

  it('marks an error on every box and fades and disables the field while locked', () => {
    const bad = field([3, 3], 'digits', { invalid: true });
    expect(bad.input).toHaveAttribute('aria-invalid', 'true');
    expect(bad.view.container.querySelectorAll('.box.bad')).toHaveLength(6);
    bad.view.unmount();
    const locked = field([3, 3], 'digits', { locked: true, invalid: true, bad: false });
    expect(locked.input).toBeDisabled();
    expect(locked.view.container.querySelector<HTMLElement>('.boxes')?.style.opacity).toBe('0.5');
    expect(locked.view.container.querySelectorAll('.box.bad')).toHaveLength(0);
  });
});
