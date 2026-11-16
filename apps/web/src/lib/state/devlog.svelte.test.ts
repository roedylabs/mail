import { flushSync } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevLog, LOG_MAX, devLog } from '#lib/state/devlog.svelte.ts';
import { ui } from '#lib/state/ui.svelte.ts';

afterEach(() => {
  devLog.clear();
  ui.toasts.discard();
  vi.useRealTimers();
});

describe('DevLog', () => {
  it('puts new entries in front and records the timestamp', () => {
    vi.useFakeTimers({ now: 5000 });
    const log = new DevLog();
    log.add('info', 'One');
    log.add('error', 'Two');
    expect(log.entries.map((e) => e.msg)).toEqual(['Two', 'One']);
    expect(log.entries[0]).toMatchObject({ level: 'error', t: 5000 });
    expect(log.entries[0]?.id).not.toBe(log.entries[1]?.id);
  });

  it('keeps at most 120 entries and drops the oldest', () => {
    const log = new DevLog();
    for (let i = 0; i < LOG_MAX + 5; i++) log.add('debug', `Entry ${i}`);
    expect(log.entries).toHaveLength(LOG_MAX);
    expect(log.entries[0]?.msg).toBe(`Entry ${LOG_MAX + 4}`);
    expect(log.entries.at(-1)?.msg).toBe('Entry 5');
  });

  it('clears the log', () => {
    const log = new DevLog();
    log.add('info', 'One');
    log.clear();
    expect(log.entries).toEqual([]);
  });

  it('does not make an effect that writes depend on the log', () => {
    const log = new DevLog();
    let runs = 0;
    const stop = $effect.root(() => {
      $effect(() => {
        runs++;
        log.add('info', 'From the effect');
      });
    });
    flushSync();
    log.add('info', 'Afterwards');
    flushSync();
    stop();
    expect(runs).toBe(1);
  });

  it('records errors and unhandled promises until detached', () => {
    const log = new DevLog();
    const target = new EventTarget() as unknown as Window;
    const detach = log.attach(target);
    target.dispatchEvent(Object.assign(new Event('error'), { message: 'Broken' }));
    target.dispatchEvent(Object.assign(new Event('error'), { message: '' }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('Rejected') }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'As text' }));
    target.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: { code: 1 } }));
    expect(log.entries.map((e) => [e.level, e.msg])).toEqual([
      ['error', 'Unknown error'],
      ['error', 'As text'],
      ['error', 'Rejected'],
      ['error', 'Unknown error'],
      ['error', 'Broken'],
    ]);
    detach();
    target.dispatchEvent(Object.assign(new Event('error'), { message: 'Later' }));
    expect(log.entries).toHaveLength(5);
  });
});

describe('Toasts in the log', () => {
  it('writes notices as info and errors as error, but not dismissing', () => {
    ui.toasts.show('Saved');
    ui.toasts.error('Did not work');
    ui.toasts.dismiss();
    expect(devLog.entries.map((e) => [e.level, e.msg])).toEqual([
      ['error', 'Notice: Did not work'],
      ['info', 'Notice: Saved'],
    ]);
  });
});
