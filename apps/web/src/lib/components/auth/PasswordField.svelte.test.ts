import { fireEvent, render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { overwriteGetLocale, type Locale } from '#lib/paraglide/runtime.js';
import PasswordField from './PasswordField.svelte';

let lang: Locale = 'en';
overwriteGetLocale(() => lang);

const base = {
  id: 'pw',
  label: 'Password',
  name: 'password',
  autocomplete: 'current-password' as const,
  value: '',
  oninput: () => {},
};

/** Alt+Shift+P as a keydown, with Option's character on macOS as `key`. */
const altShiftP = { key: '∏', code: 'KeyP', altKey: true, shiftKey: true };

/** Two fields as on the pages with a confirmation, each keeping its value. */
function twoFields() {
  const view = render(PasswordField, { ...base, value: 'secret' });
  const second = render(PasswordField, {
    ...base,
    id: 'pw2',
    label: 'Confirm password',
    name: 'confirm-password',
    value: 'secret',
    showLabel: 'Show confirmed password',
    hideLabel: 'Hide confirmed password',
  });
  return {
    first: view.getByLabelText('Password') as HTMLInputElement,
    second: second.getByLabelText('Confirm password') as HTMLInputElement,
    eye: within(view.container).getByRole('button'),
    eye2: within(second.container).getByRole('button'),
  };
}

afterEach(() => {
  lang = 'en';
  vi.unstubAllGlobals();
});

describe('PasswordField', () => {
  it('describes the field by its error line while it shows, besides the page’s ids, and the shortcut last', () => {
    const plain = render(PasswordField, { ...base, describedby: 'hint' });
    expect(plain.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'hint pw-kbd');
    plain.unmount();
    const failed = render(PasswordField, { ...base, describedby: 'hint', error: 'Wrong password.' });
    expect(failed.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'hint pw-err pw-kbd');
    expect(failed.getByRole('alert')).toHaveAttribute('id', 'pw-err');
    failed.unmount();
    const once = render(PasswordField, { ...base, describedby: 'pw-err hint', error: 'Wrong password.' });
    expect(once.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'pw-err hint pw-kbd');
    once.unmount();
    const bare = render(PasswordField, base);
    expect(bare.getByLabelText('Password')).toHaveAttribute('aria-describedby', 'pw-kbd');
  });

  it('names the shortcut in a visually hidden hint and in the eye’s tooltip, out of the Tab order', () => {
    vi.stubGlobal('navigator', { platform: 'Win32' });
    const view = render(PasswordField, base);
    expect(view.getByLabelText('Password')).toHaveAccessibleDescription('Alt+Shift+P shows or hides the password');
    expect(view.container.querySelector('#pw-kbd')).toHaveClass('sr-only');
    const eye = view.getByRole('button', { name: 'Show password' });
    expect(eye).toHaveAttribute('title', 'Show password (Alt+Shift+P)');
    expect(eye).toHaveAttribute('tabindex', '-1');
  });

  it('says Option on macOS, Wahltaste in German', () => {
    vi.stubGlobal('navigator', { userAgentData: { platform: 'macOS' }, platform: 'MacIntel' });
    const en = render(PasswordField, base);
    expect(en.getByLabelText('Password')).toHaveAccessibleDescription('Option+Shift+P shows or hides the password');
    expect(en.getByRole('button', { name: 'Show password' })).toHaveAttribute(
      'title',
      'Show password (Option+Shift+P)',
    );
    en.unmount();

    lang = 'de';
    const de = render(PasswordField, { ...base, label: 'Passwort' });
    expect(de.getByLabelText('Passwort')).toHaveAccessibleDescription(
      'Wahltaste+Shift+P zeigt oder verbirgt das Passwort',
    );
    expect(de.getByRole('button', { name: 'Passwort anzeigen' })).toHaveAttribute(
      'title',
      'Passwort anzeigen (Wahltaste+Shift+P)',
    );
    de.unmount();

    vi.stubGlobal('navigator', { platform: 'Linux x86_64' });
    const deAlt = render(PasswordField, { ...base, label: 'Passwort' });
    expect(deAlt.getByLabelText('Passwort')).toHaveAccessibleDescription(
      'Alt+Shift+P zeigt oder verbirgt das Passwort',
    );
    expect(deAlt.getByRole('button', { name: 'Passwort anzeigen' })).toHaveAttribute(
      'title',
      'Passwort anzeigen (Alt+Shift+P)',
    );
  });

  it('shows and hides the focused field’s password with Alt+Shift+P, never the other one', async () => {
    const { first, second, eye, eye2 } = twoFields();
    first.focus();
    expect(await fireEvent.keyDown(first, altShiftP)).toBe(false);
    await tick();
    expect(first).toHaveAttribute('type', 'text');
    expect(second).toHaveAttribute('type', 'password');
    expect(eye).toHaveAccessibleName('Hide password');
    expect(eye).toHaveAttribute('aria-pressed', 'true');
    expect(eye).toHaveAttribute('title', 'Hide password (Alt+Shift+P)');
    expect(eye2).toHaveAttribute('aria-pressed', 'false');
    expect(document.activeElement).toBe(first);

    second.focus();
    await fireEvent.keyDown(second, altShiftP);
    await tick();
    expect(second).toHaveAttribute('type', 'text');
    expect(eye2).toHaveAccessibleName('Hide confirmed password');
    expect(first).toHaveAttribute('type', 'text');

    first.focus();
    await fireEvent.keyDown(first, { ...altShiftP, key: 'P' });
    await tick();
    expect(first).toHaveAttribute('type', 'password');
    expect(eye).toHaveAccessibleName('Show password');
    expect(eye).toHaveAttribute('aria-pressed', 'false');
    expect(eye).toHaveAttribute('title', 'Show password (Alt+Shift+P)');
    expect(second).toHaveAttribute('type', 'text');
  });

  it('types no character for the shortcut, also not while the key is held', async () => {
    const { first } = twoFields();
    first.focus();
    expect(await fireEvent.keyDown(first, { ...altShiftP, repeat: true })).toBe(false);
    await tick();
    // A held key repeats: nothing more toggles.
    expect(first).toHaveAttribute('type', 'password');
  });

  it('does nothing on keyup, with Ctrl or Meta, without Shift or Alt, or for another key', async () => {
    const { first } = twoFields();
    first.focus();
    const others = [
      { ...altShiftP, ctrlKey: true },
      { ...altShiftP, metaKey: true },
      { ...altShiftP, shiftKey: false, key: 'π' },
      { ...altShiftP, altKey: false, key: 'P' },
      { ...altShiftP, code: 'KeyO', key: 'Ø' },
    ];
    for (const init of others) {
      expect(await fireEvent.keyDown(first, init)).toBe(true);
      await tick();
      expect(first).toHaveAttribute('type', 'password');
    }
    expect(await fireEvent.keyUp(first, altShiftP)).toBe(true);
    await tick();
    expect(first).toHaveAttribute('type', 'password');
  });

  it('keeps the caret and the selection where they were', async () => {
    const { first } = twoFields();
    first.focus();
    first.setSelectionRange(2, 2);
    await fireEvent.keyDown(first, altShiftP);
    await tick();
    expect(first).toHaveAttribute('type', 'text');
    expect([first.selectionStart, first.selectionEnd]).toEqual([2, 2]);

    first.setSelectionRange(1, 4, 'backward');
    await fireEvent.keyDown(first, altShiftP);
    await tick();
    expect(first).toHaveAttribute('type', 'password');
    expect([first.selectionStart, first.selectionEnd, first.selectionDirection]).toEqual([1, 4, 'backward']);
  });

  it('still shows and hides with a click on the eye', async () => {
    const { first, eye } = twoFields();
    await fireEvent.click(eye);
    expect(first).toHaveAttribute('type', 'text');
    expect(eye).toHaveAttribute('aria-pressed', 'true');
  });
});
