/**
 * Sound for new notifications: two short, quiet sine tones via Web Audio,
 * without an audio file.
 *
 * Browsers only allow sound after an interaction with the page: `armChime()`
 * creates the `AudioContext` at the first click or key press and wakes it
 * at every further interaction if the browser suspended it (Safari
 * and iOS after the background: `suspended` or `interrupted`). Without
 * interaction or without Web Audio it stays silent.
 */

type AudioContextClass = typeof AudioContext;

let context: AudioContext | null = null;

function audioClass(): AudioContextClass | undefined {
  const scope = globalThis as typeof globalThis & { webkitAudioContext?: AudioContextClass };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

function unlock(): void {
  try {
    const Context = audioClass();
    if (!Context) return;
    context ??= new Context();
    if (context.state !== 'running' && context.state !== 'closed') void context.resume().catch(() => {});
  } catch {
    // No sound without Web Audio.
  }
}

const EVENTS = ['pointerdown', 'keydown'] as const;

/** Creates or wakes the `AudioContext` on an interaction; returns the cleanup. */
export function armChime(target: Window = window): () => void {
  for (const type of EVENTS) target.addEventListener(type, unlock, true);
  return () => {
    for (const type of EVENTS) target.removeEventListener(type, unlock, true);
  };
}

/** For tests: forgets the `AudioContext`. */
export function resetChime(): void {
  context = null;
}

/** Plays the sound (A5, then E6) if the browser already allows it. */
export function chime(): void {
  const ctx = context;
  if (!ctx || ctx.state !== 'running') return;
  try {
    const start = ctx.currentTime;
    [880, 1318.5].forEach((frequency, i) => {
      const at = start + i * 0.12;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.4);
    });
  } catch {
    // Sound is an extra; errors stay silent.
  }
}
