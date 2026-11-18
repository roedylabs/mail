import { fireEvent, render } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { formatOtp, formatRecovery } from '#lib/login.svelte.ts';
import CodeBoxes from './CodeBoxes.svelte';

/** Field with formatting like the pages that use the boxes. */
function renderBoxes(kind: 'otp' | 'bc', format: (v: string) => string) {
  const props = $state({
    id: 'code',
    kind,
    value: '',
    active: true,
    bad: false,
    gap: '10px',
    height: '64px',
    oninput: (v: string) => (props.value = format(v)),
  });
  return { view: render(CodeBoxes, props), props };
}

describe('code boxes', () => {
  it('takes pasted codes with spaces in full and shows one digit per box', async () => {
    const { view, props } = renderBoxes('otp', formatOtp);
    const input = view.container.querySelector('input') as HTMLInputElement;
    expect(input).not.toHaveAttribute('maxlength');
    await fireEvent.input(input, { target: { value: '123 456' } });
    expect(props.value).toBe('123456');
    expect(input.value).toBe('123456');
    const boxes = view.container.querySelectorAll('.box');
    expect(boxes).toHaveLength(6);
    expect([...boxes].map((b) => b.textContent?.trim())).toEqual(['1', '2', '3', '4', '5', '6']);
  });

  it('shows recovery codes in two groups of four and removes rejected characters from the field', async () => {
    const { view } = renderBoxes('bc', formatRecovery);
    const input = view.container.querySelector('input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'ab!c' } });
    expect(input.value).toBe('ABC');
    expect(view.container.querySelectorAll('.box')).toHaveLength(8);
    expect(view.container.querySelectorAll('.sep')).toHaveLength(1);
    expect(view.container.querySelector('.box.active .caret')).not.toBeNull();
  });

  it('fades locked boxes unless the page keeps them opaque', () => {
    const base = {
      id: 'code',
      kind: 'otp' as const,
      value: '',
      active: true,
      bad: false,
      gap: '10px',
      height: '64px',
      oninput: () => {},
    };
    const faded = render(CodeBoxes, { ...base, locked: true });
    expect(faded.container.querySelector<HTMLElement>('.code-ctl')?.style.opacity).toBe('0.5');
    expect(faded.container.querySelector('input')).toBeDisabled();
    faded.unmount();
    const opaque = render(CodeBoxes, { ...base, locked: true, fadeLocked: false });
    expect(opaque.container.querySelector<HTMLElement>('.code-ctl')?.style.opacity).toBe('1');
    expect(opaque.container.querySelector('input')).toBeDisabled();
  });
});
