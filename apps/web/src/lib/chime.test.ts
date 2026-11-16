import { afterEach, describe, expect, it, vi } from 'vitest';
import { armChime, chime, resetChime } from '#lib/chime.ts';

/** AudioContext with a counter for tones; the test sets `state`. */
class FakeContext {
  static made = 0;
  state: string = 'suspended';
  currentTime = 0;
  destination = {};
  tones: number[] = [];
  resume = vi.fn(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  constructor() {
    FakeContext.made++;
    made.push(this);
  }
  createOscillator() {
    const osc = {
      type: '',
      frequency: { value: 0 },
      connect: (node: unknown) => node,
      start: () => this.tones.push(osc.frequency.value),
      stop: () => {},
    };
    return osc;
  }
  createGain() {
    const gain = {
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} },
      connect: (node: unknown) => node,
    };
    return gain;
  }
}

const made: FakeContext[] = [];
const last = () => made.at(-1);

afterEach(() => {
  resetChime();
  FakeContext.made = 0;
  made.length = 0;
  vi.unstubAllGlobals();
});

describe('chime', () => {
  it('stays silent without interaction and then plays two tones', () => {
    vi.stubGlobal('AudioContext', FakeContext);
    chime();
    expect(FakeContext.made).toBe(0);
    const disarm = armChime();
    window.dispatchEvent(new Event('pointerdown'));
    expect(FakeContext.made).toBe(1);
    expect(last()?.resume).toHaveBeenCalledOnce();
    chime();
    expect(last()?.tones).toEqual([880, 1318.5]);
    disarm();
  });

  it('wakes a suspended context at the next interaction', () => {
    vi.stubGlobal('AudioContext', FakeContext);
    const disarm = armChime();
    window.dispatchEvent(new Event('keydown'));
    const ctx = last()!;
    // Safari/iOS after the background.
    ctx.state = 'interrupted';
    chime();
    expect(ctx.tones).toEqual([]);
    window.dispatchEvent(new Event('pointerdown'));
    expect(FakeContext.made).toBe(1);
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    chime();
    expect(ctx.tones).toHaveLength(2);
    disarm();
    ctx.state = 'suspended';
    window.dispatchEvent(new Event('pointerdown'));
    expect(ctx.resume).toHaveBeenCalledTimes(2);
  });

  it('stays silent without Web Audio', () => {
    vi.stubGlobal('AudioContext', undefined);
    const disarm = armChime();
    window.dispatchEvent(new Event('pointerdown'));
    expect(() => chime()).not.toThrow();
    disarm();
  });
});
