import { afterEach, describe, expect, it } from 'vitest';
import { focusback } from './focusback.ts';

afterEach(() => {
  document.body.innerHTML = '';
});

/** Row with an edit button and a box with two buttons. */
function setup() {
  document.body.innerHTML = `
    <div id="row"><button id="edit" class="edit">Edit</button>
      <div id="box"><button id="a">A</button><button id="b">B</button></div>
    </div>
    <button id="elsewhere">Elsewhere</button>`;
  const box = document.getElementById('box') as HTMLElement;
  const action = focusback(box, 'button.edit');
  return { box, action, $: (id: string) => document.getElementById(id) as HTMLElement };
}

const tick = () => new Promise((resolve) => setTimeout(resolve));

describe('focusback', () => {
  it('moves the focus to the target when the focused box disappears', async () => {
    const { box, action, $ } = setup();
    $('b').focus();
    box.remove();
    action.destroy();
    await tick();
    expect(document.activeElement).toBe($('edit'));
  });

  it('leaves the focus alone if it was not in the box', async () => {
    const { box, action, $ } = setup();
    $('a').focus();
    $('elsewhere').focus();
    await tick();
    box.remove();
    action.destroy();
    await tick();
    expect(document.activeElement).toBe($('elsewhere'));
  });
});

describe('focusback in the profile email row', () => {
  const target = 'button.edit, input.row-input';
  // Desktop: the box follows the row; mobile: the box sits inside the row.
  const layouts = {
    desktop: (field: string) =>
      `<div><div class="row">${field}</div><div id="box"><button id="discard">D</button></div></div>`,
    mobile: (field: string) =>
      `<div><div class="row">${field}<div id="box"><button id="discard">D</button></div></div></div>`,
  };
  const fields = {
    reading: '<button id="field" class="edit">Edit</button>',
    editing: '<input id="field" class="row-input" />',
  };

  for (const [layout, html] of Object.entries(layouts)) {
    for (const [mode, field] of Object.entries(fields)) {
      it(`${layout}, ${mode}: focus goes to the row's ${mode === 'reading' ? 'edit button' : 'input'}`, async () => {
        document.body.innerHTML = html(field);
        const box = document.getElementById('box') as HTMLElement;
        const action = focusback(box, target);
        (document.getElementById('discard') as HTMLElement).focus();
        box.remove();
        action.destroy();
        await tick();
        expect(document.activeElement).toBe(document.getElementById('field'));
      });
    }
  }
});
