import { fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { focustrap, tabbables } from './focustrap.ts';

type Inertable = HTMLElement & { inert?: boolean };

/** Open traps, so that the module-wide stack is empty after each test. */
let open: { destroy: () => void }[] = [];

function trap(node: HTMLElement): { destroy: () => void } {
  const handle = focustrap(node);
  let done = false;
  const wrapped = {
    destroy() {
      if (done) return;
      done = true;
      handle.destroy();
    },
  };
  open.push(wrapped);
  return wrapped;
}

function $(id: string): Inertable {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

/** Background with an opener, next to it a dialog with three buttons. */
function page(): void {
  document.body.innerHTML = `
    <div id="app">
      <header id="head"><button id="opener">Open</button></header>
      <main id="main"><button id="other">Other</button></main>
      <div id="wrap">
        <p id="sib">Beside</p>
        <div id="dialog" role="dialog" aria-modal="true" tabindex="-1">
          <button id="first">First</button>
          <button id="middle">Middle</button>
          <button id="last">Last</button>
        </div>
      </div>
    </div>
    <aside id="behind">Already inert</aside>
    <script id="script"></script>
  `;
}

/** Waits until MutationObserver and microtasks have run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  for (const handle of open.reverse()) handle.destroy();
  open = [];
  (document.activeElement as HTMLElement | null)?.blur();
  document.body.innerHTML = '';
});

describe('tabbables', () => {
  it('skips disabled, hidden and tabindex=-1 elements', () => {
    document.body.innerHTML = `
      <div id="root">
        <button id="ok">Button</button>
        <button disabled>Disabled</button>
        <button tabindex="-1">No tab stop</button>
        <button hidden>Hidden</button>
        <input type="hidden" />
        <a>No href</a>
        <a id="link" href="#x">Link</a>
        <div id="inert-box"><button>Inert</button></div>
        <input id="field" />
        <div id="custom" tabindex="0">Custom element</div>
        <select id="choice"><option>1</option></select>
        <textarea id="text" disabled></textarea>
      </div>
    `;
    $('inert-box').inert = true;
    expect(tabbables($('root')).map((el) => el.id)).toEqual(['ok', 'link', 'field', 'custom', 'choice']);
  });

  it('evaluates inert only inside the dialog, not on its ancestors', () => {
    document.body.innerHTML = `<div id="outer"><div id="root"><button id="ok">Button</button></div></div>`;
    // A dialog below an inert ancestor (level 1 sheet behind level 2) keeps its elements.
    $('outer').inert = true;
    expect(tabbables($('root')).map((el) => el.id)).toEqual(['ok']);
  });
});

describe('use:focustrap', () => {
  describe('background', () => {
    it('makes everything next to the dialog inert and releases it on close', () => {
      page();
      $('behind').inert = true;
      const handle = trap($('dialog'));

      for (const id of ['head', 'main', 'sib', 'behind']) expect($(id).inert, id).toBe(true);
      // The dialog, its ancestors and parts without rendering stay untouched.
      for (const id of ['dialog', 'wrap', 'app', 'script']) expect($(id).inert, id).toBeFalsy();

      // What appears next to it later (toast) stays operable.
      const toast = document.createElement('div') as Inertable;
      document.body.append(toast);
      expect(toast.inert).toBeFalsy();

      handle.destroy();
      for (const id of ['head', 'main', 'sib']) expect($(id).inert, id).toBe(false);
      // What was inert before stays so.
      expect($('behind').inert).toBe(true);
    });
  });

  describe('live regions and tabindex', () => {
    it('keeps an already visible toast, other live regions and the backdrop next to it operable', () => {
      page();
      const toast = document.createElement('div') as Inertable;
      toast.setAttribute('role', 'status');
      const alert = document.createElement('div') as Inertable;
      alert.setAttribute('role', 'alert');
      const announcer = document.createElement('div') as Inertable;
      announcer.setAttribute('aria-live', 'assertive');
      // A backdrop next to the dialog (sheet) closes on click.
      const scrim = document.createElement('div') as Inertable;
      scrim.dataset.scrim = '';
      $('wrap').prepend(scrim);
      $('app').append(toast, alert, announcer);
      const handle = trap($('dialog'));
      for (const el of [toast, alert, announcer, scrim]) expect(el.inert).toBeFalsy();
      expect($('main').inert).toBe(true);
      handle.destroy();
    });

    it('makes a dialog without tabindex focusable and keeps an existing one', async () => {
      page();
      const plain = document.createElement('div');
      plain.innerHTML = '<button id="gone">Check</button>';
      document.body.append(plain);
      trap(plain);
      expect(plain.getAttribute('tabindex')).toBe('-1');
      // Content change: the focused button disappears, the dialog takes focus.
      $('gone').focus();
      $('gone').remove();
      await settle();
      expect(document.activeElement).toBe(plain);

      const own = document.createElement('div');
      own.tabIndex = 0;
      document.body.append(own);
      trap(own);
      expect(own.getAttribute('tabindex')).toBe('0');
    });
  });

  describe('Tab at the edge', () => {
    it('jumps with Tab from the last to the first element', async () => {
      page();
      trap($('dialog'));
      $('last').focus();
      expect(await fireEvent.keyDown($('last'), { key: 'Tab' })).toBe(false);
      expect(document.activeElement).toBe($('first'));
    });

    it('jumps with Shift+Tab from the first to the last element and from the dialog itself', async () => {
      page();
      trap($('dialog'));
      $('first').focus();
      expect(await fireEvent.keyDown($('first'), { key: 'Tab', shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe($('last'));

      $('dialog').focus();
      expect(await fireEvent.keyDown($('dialog'), { key: 'Tab', shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe($('last'));
    });

    it('also redirects from elements without a tab stop before the first or after the last', async () => {
      page();
      const after = document.createElement('pre');
      after.tabIndex = -1;
      $('dialog').append(after);
      const before = document.createElement('pre');
      before.tabIndex = -1;
      $('dialog').prepend(before);
      trap($('dialog'));
      after.focus();
      expect(await fireEvent.keyDown(after, { key: 'Tab' })).toBe(false);
      expect(document.activeElement).toBe($('first'));
      before.focus();
      expect(await fireEvent.keyDown(before, { key: 'Tab', shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe($('last'));
      // Tab from the dialog itself goes to the first element in the browser anyway.
      $('dialog').focus();
      expect(await fireEvent.keyDown($('dialog'), { key: 'Tab' })).toBe(true);
    });

    it('leaves Tab inside the dialog to the browser', async () => {
      page();
      trap($('dialog'));
      $('first').focus();
      expect(await fireEvent.keyDown($('first'), { key: 'Tab' })).toBe(true);
      $('middle').focus();
      expect(await fireEvent.keyDown($('middle'), { key: 'Tab', shiftKey: true })).toBe(true);
      expect(document.activeElement).toBe($('middle'));
    });

    it('pulls focus from body into the dialog', async () => {
      page();
      trap($('dialog'));
      expect(document.activeElement).toBe(document.body);
      expect(await fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
      expect(document.activeElement).toBe($('first'));

      $('first').blur();
      expect(await fireEvent.keyDown(document.body, { key: 'Tab', shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe($('last'));
    });

    it('sets focus on the dialog if it contains nothing focusable', async () => {
      document.body.innerHTML = `
        <button id="opener">Open</button>
        <div id="dialog" role="dialog" tabindex="-1"><p>Text only</p></div>
      `;
      trap($('dialog'));
      expect(await fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(false);
      expect(document.activeElement).toBe($('dialog'));
      expect(await fireEvent.keyDown($('dialog'), { key: 'Tab', shiftKey: true })).toBe(false);
      expect(document.activeElement).toBe($('dialog'));
    });

    it('skips Tab with Ctrl, Alt or Meta and already handled events', async () => {
      page();
      trap($('dialog'));
      $('last').focus();
      for (const mod of ['ctrlKey', 'altKey', 'metaKey']) {
        expect(await fireEvent.keyDown($('last'), { key: 'Tab', [mod]: true }), mod).toBe(true);
        expect(document.activeElement).toBe($('last'));
      }
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      event.preventDefault();
      $('last').dispatchEvent(event);
      expect(document.activeElement).toBe($('last'));
    });

    it('stops listening to Tab after the last trap closes', async () => {
      page();
      trap($('dialog')).destroy();
      $('last').focus();
      expect(await fireEvent.keyDown($('last'), { key: 'Tab' })).toBe(true);
      expect(document.activeElement).toBe($('last'));
    });
  });

  describe('return', () => {
    it('returns focus to the opener on close', () => {
      page();
      $('opener').focus();
      const handle = trap($('dialog'));
      $('middle').focus();
      handle.destroy();
      expect(document.activeElement).toBe($('opener'));
    });

    it('also returns if the dialog is already removed and focus is on body', () => {
      page();
      $('opener').focus();
      const handle = trap($('dialog'));
      $('middle').focus();
      $('dialog').remove();
      expect(document.activeElement).toBe(document.body);
      handle.destroy();
      expect(document.activeElement).toBe($('opener'));
    });

    it('takes the last left element if the component moves focus into the dialog first', () => {
      page();
      $('opener').focus();
      // The component focuses its field before the action runs.
      $('first').focus();
      const handle = trap($('dialog'));
      handle.destroy();
      expect(document.activeElement).toBe($('opener'));
    });

    it('takes no earlier left element if focus is on body when opening', () => {
      page();
      // Focused earlier, then left (e.g. Safari: a clicked button takes no focus).
      $('other').focus();
      $('other').blur();
      expect(document.activeElement).toBe(document.body);
      const handle = trap($('dialog'));
      $('middle').focus();
      handle.destroy();
      expect(document.activeElement).not.toBe($('other'));
    });

    it('leaves focus where it is if it is outside the dialog by now', () => {
      page();
      $('opener').focus();
      const handle = trap($('dialog'));
      // For example a button in a toast that appeared after opening.
      const toast = document.createElement('button');
      toast.textContent = 'Undo';
      document.body.append(toast);
      toast.focus();
      handle.destroy();
      expect(document.activeElement).toBe(toast);
    });

    it('tries again after a microtask while the opener is still inert', async () => {
      page();
      $('opener').focus();
      // The opener lies in an area the component itself keeps inert (`behind`).
      $('head').inert = true;
      const handle = trap($('dialog'));
      $('middle').focus();
      handle.destroy();
      expect(document.activeElement).toBe($('middle'));
      // Svelte releases the area right afterwards.
      $('head').inert = false;
      await Promise.resolve();
      expect(document.activeElement).toBe($('opener'));
    });

    it('wins even if the dialog below has focused itself meanwhile', async () => {
      // Level 1 sheet with the opener, inert while level 2 is open (`behind`).
      page();
      const lower = $('dialog');
      const upper = document.createElement('div');
      upper.innerHTML = '<button>Yes</button>';
      document.body.append(upper);
      trap(lower);
      $('middle').focus();
      const handle = trap(upper);
      lower.inert = true;
      upper.querySelector('button')?.focus();
      handle.destroy();
      expect(document.activeElement).not.toBe($('middle'));
      // In the same pass: Svelte releases level 1, its effect focuses the panel.
      lower.inert = false;
      lower.focus();
      await Promise.resolve();
      expect(document.activeElement).toBe($('middle'));
    });

    it('does not jump to an opener that is no longer in the document', () => {
      page();
      $('opener').focus();
      const handle = trap($('dialog'));
      $('middle').focus();
      $('opener').remove();
      handle.destroy();
      expect(document.activeElement).toBe($('middle'));
    });
  });

  describe('stack', () => {
    function stacked(): void {
      page();
      const second = document.createElement('div');
      second.id = 'dialog2';
      second.setAttribute('role', 'dialog');
      second.tabIndex = -1;
      second.innerHTML = `<button id="yes">Yes</button><button id="no">No</button>`;
      document.body.append(second);
    }

    it('makes the lower dialog inert and releases it with focus on the opener', () => {
      stacked();
      $('opener').focus();
      trap($('dialog'));
      $('middle').focus();
      const top = trap($('dialog2'));
      $('yes').focus();

      expect($('app').inert).toBe(true);
      expect($('dialog2').inert).toBeFalsy();

      top.destroy();
      expect($('app').inert).toBe(false);
      expect($('dialog').inert).toBeFalsy();
      // The background of the lower dialog stays inert, now also the closed upper one.
      expect($('head').inert).toBe(true);
      expect($('dialog2').inert).toBe(true);
      expect(document.activeElement).toBe($('middle'));
    });

    it('takes the last one in the document as topmost dialog, not the most recently mounted', () => {
      stacked();
      trap($('dialog2'));
      // The lower dialog remounts (e.g. when switching between desktop and mobile).
      trap($('dialog'));
      expect($('dialog2').inert).toBeFalsy();
      expect($('app').inert).toBe(true);
    });

    it('redirects Tab only in the topmost dialog', async () => {
      stacked();
      trap($('dialog'));
      trap($('dialog2'));
      $('no').focus();
      expect(await fireEvent.keyDown($('no'), { key: 'Tab' })).toBe(false);
      expect(document.activeElement).toBe($('yes'));
      // If focus is in the lower dialog (jsdom does not know inert), Tab pulls it into the upper one.
      $('last').focus();
      expect(await fireEvent.keyDown($('last'), { key: 'Tab' })).toBe(false);
      expect(document.activeElement).toBe($('yes'));
    });

    it('keeps the upper trap when a lower dialog closes', () => {
      stacked();
      $('opener').focus();
      const lower = trap($('dialog'));
      $('middle').focus();
      trap($('dialog2'));
      $('yes').focus();
      lower.destroy();
      expect(document.activeElement).toBe($('yes'));
      expect($('app').inert).toBe(true);
      expect($('dialog2').inert).toBeFalsy();
    });
  });

  describe('content change', () => {
    it('sets focus on the dialog if the focused element disappears', async () => {
      page();
      trap($('dialog'));
      $('middle').focus();
      $('middle').remove();
      expect(document.activeElement).toBe(document.body);
      await settle();
      expect(document.activeElement).toBe($('dialog'));
    });

    it('keeps focus on a content change while it stays in the dialog', async () => {
      page();
      trap($('dialog'));
      $('first').focus();
      $('dialog').append(document.createElement('p'));
      await settle();
      expect(document.activeElement).toBe($('first'));
    });

    it('reacts only in the topmost dialog', async () => {
      page();
      const second = document.createElement('div');
      second.id = 'dialog2';
      second.tabIndex = -1;
      second.innerHTML = `<button id="yes">Yes</button>`;
      document.body.append(second);
      trap($('dialog'));
      trap($('dialog2'));

      $('first').remove();
      await settle();
      expect(document.activeElement).toBe(document.body);

      $('yes').remove();
      await settle();
      expect(document.activeElement).toBe($('dialog2'));
    });

    it('stops observing after close', async () => {
      page();
      trap($('dialog')).destroy();
      $('middle').focus();
      $('middle').remove();
      await settle();
      expect(document.activeElement).toBe(document.body);
    });
  });
});
