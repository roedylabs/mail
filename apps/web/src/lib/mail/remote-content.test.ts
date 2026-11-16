import { afterEach, describe, expect, it } from 'vitest';
import { m } from '#lib/paraglide/messages.js';
import { prefs } from '#lib/state/prefs.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';
import {
  allowSender,
  canAllow,
  MAX_SENDERS,
  extListNote,
  extSummary,
  loadsRemote,
  remoteBanner,
  removeSender,
  senderKey,
} from './remote-content.ts';

afterEach(() => {
  ui.reset();
  prefs.reset();
});

describe('loadsRemote', () => {
  const ask = { extMode: 'ask', extAllow: ['news@example.com'] } as const;

  it('asks, except for allowed senders (case does not matter)', () => {
    expect(loadsRemote({ ...ask, extAllow: [...ask.extAllow] }, 'anna@example.com', false)).toBe(false);
    expect(loadsRemote({ ...ask, extAllow: [...ask.extAllow] }, ' News@Example.com', false)).toBe(true);
    expect(loadsRemote({ ...ask, extAllow: [...ask.extAllow] }, undefined, false)).toBe(false);
  });

  it('loads once, always or never', () => {
    expect(loadsRemote({ extMode: 'ask', extAllow: [] }, 'anna@example.com', true)).toBe(true);
    expect(loadsRemote({ extMode: 'always', extAllow: [] }, 'anna@example.com', false)).toBe(true);
    // "Never load" also applies to allowed senders, "Load once" works anyway.
    expect(loadsRemote({ extMode: 'never', extAllow: ['news@example.com'] }, 'news@example.com', false)).toBe(false);
    expect(loadsRemote({ extMode: 'never', extAllow: [] }, 'news@example.com', true)).toBe(true);
  });
});

describe('remoteBanner', () => {
  const ask = { extMode: 'ask' as const, extAllow: [] };
  const never = { extMode: 'never' as const, extAllow: [] };

  it('appears only with blocked content', () => {
    expect(remoteBanner(ask, 0, 'a@b.example').showBar).toBe(false);
    expect(remoteBanner(ask, 3, 'a@b.example')).toEqual({
      showBar: true,
      barTitle: m.read_ext_blocked(),
      barSub: m.read_ext_sub({ n: 3 }),
      canAlways: true,
    });
    expect(remoteBanner(ask, 1, 'a@b.example').barSub).toBe(m.read_ext_sub_one());
  });

  it('switched off with "Never load" and without allowing, likewise without a valid sender', () => {
    expect(remoteBanner(never, 2, 'a@b.example')).toMatchObject({
      barTitle: m.read_ext_off(),
      canAlways: false,
    });
    expect(remoteBanner(ask, 2, '').canAlways).toBe(false);
    expect(remoteBanner(ask, 2, 'MAILER-DAEMON').canAlways).toBe(false);
  });
});

describe('canAllow', () => {
  it('accepts only senders the backend stores', () => {
    const none = { extAllow: [] };
    expect(canAllow(none, 'root@localhost')).toBe(true);
    expect(canAllow(none, '"jane doe"@example.com')).toBe(true);
    for (const bad of [
      '',
      'MAILER-DAEMON',
      '@example.com',
      'max@',
      'max@exam\nple.com',
      `${'a'.repeat(250)}@b.example`,
    ])
      expect(canAllow(none, bad), bad).toBe(false);
  });

  it('does not let a full list grow', () => {
    const full = { extAllow: Array.from({ length: MAX_SENDERS }, (_, i) => `a${i}@b.example`) };
    expect(canAllow(full, 'new@b.example')).toBe(false);
    expect(canAllow(full, 'a1@b.example')).toBe(true);
  });
});

describe('texts of the setting', () => {
  it('describes the setting and the list', () => {
    expect(extSummary('ask')).toBe(m.ext_sum_ask());
    expect(extSummary('always')).toBe(m.ext_sum_always());
    expect(extSummary('never')).toBe(m.ext_sum_never());
    expect(extListNote('ask')).toBe(m.ext_list_note());
    expect(extListNote('never')).toBe(m.ext_list_note_inactive());
  });

  it('compares senders in lower case', () => {
    expect(senderKey('  Hello@OSS-Week.example ')).toBe('hello@oss-week.example');
    expect(senderKey(null)).toBe('');
  });
});

describe('allowances', () => {
  it('allows a sender, undo reverts it', () => {
    allowSender('Hello@OSS-Week.example');
    expect(prefs.values.extAllow).toEqual(['hello@oss-week.example']);
    expect(ui.toast).toMatchObject({ text: m.read_ext_allowed({ email: 'hello@oss-week.example' }), undo: true });
    ui.toasts.undo();
    expect(prefs.values.extAllow).toEqual([]);
  });

  it('does not add an already allowed sender twice and keeps it on undo', () => {
    prefs.set({ extAllow: ['a@b.example'] });
    allowSender('A@b.example');
    expect(prefs.values.extAllow).toEqual(['a@b.example']);
    ui.toasts.undo();
    expect(prefs.values.extAllow).toEqual(['a@b.example']);
  });

  it('removes an allowance, undo puts it back at its position', () => {
    prefs.set({ extAllow: ['a@b.example', 'c@d.example', 'e@f.example'] });
    removeSender('c@d.example');
    expect(prefs.values.extAllow).toEqual(['a@b.example', 'e@f.example']);
    expect(ui.toast).toMatchObject({ text: m.ext_removed({ email: 'c@d.example' }), undo: true });
    ui.toasts.undo();
    expect(prefs.values.extAllow).toEqual(['a@b.example', 'c@d.example', 'e@f.example']);
  });
});
