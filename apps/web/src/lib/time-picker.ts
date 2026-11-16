/**
 * Time picker (first use: quiet hours in Settings › Notifications): field
 * with input in the time format (24 hours "22:00", 12 hours "10:00 PM"; always stored as
 * HH:MM), on the desktop a popover with hour and minute columns at the field,
 * on mobile a sheet with the same columns and "Done".
 *
 * Keyboard in the field: ↑/↓ ±5 minutes, with ⇧ ±60 (across midnight), Enter
 * and Escape leave the field and close, Tab closes. Typed text stays in the
 * field as long as it has focus; every valid time applies
 * immediately.
 */
import type { KeyInput } from '#lib/keys.ts';
import { minutesOf } from '#lib/quiet-hours.ts';

const pad = (n: number) => String(n).padStart(2, '0');

/** Minutes of a day. */
const DAY = 24 * 60;

/**
 * Time HH:MM as text in the time format: "07:00"
 * or "7:00 AM". AM and PM are abbreviations of the format, not UI text.
 */
export function clockLabel(value: string, h12: boolean): string {
  const [h = 0, mi = 0] = (value || '00:00').split(':').map(Number);
  const hh = h || 0;
  const mm = pad(mi || 0);
  return h12 ? `${hh % 12 || 12}:${mm} ${hh < 12 ? 'AM' : 'PM'}` : `${pad(hh)}:${mm}`;
}

/**
 * Typed time as HH:MM: "22:30", "22.30", "2230", "7",
 * with AM/PM ("10:30 pm", "7a"); `null` if it is not a valid time.
 */
export function parseTime(text: string): string | null {
  const suffix = /\s*([ap])\.?\s*m?\.?$/i;
  const ap = suffix.exec(text)?.[1];
  const t = ap ? text.replace(suffix, '') : text;
  const parts = /^(\d{1,2})[:.](\d{1,2})$/.exec(t);
  let h: number;
  let mi: number;
  if (parts) {
    h = Number(parts[1]);
    mi = Number(parts[2]);
  } else if (/^\d{3,4}$/.test(t)) {
    h = Number(t.slice(0, -2));
    mi = Number(t.slice(-2));
  } else if (/^\d{1,2}$/.test(t)) {
    h = Number(t);
    mi = 0;
  } else return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap.toLowerCase() === 'p' ? 12 : 0);
  }
  return h < 24 && mi < 60 ? `${pad(h)}:${pad(mi)}` : null;
}

/** Time shifted by `delta` minutes, across midnight. */
export function stepTime(value: string, delta: number): string {
  const t = (((minutesOf(value) + delta) % DAY) + DAY) % DAY;
  return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
}

/** Allowed characters in the field: digits, ":" and ".", in the 12-hour format also AM/PM; at most 5 or 8 characters. */
export function cleanInput(raw: string, h12: boolean): string {
  return h12 ? raw.replace(/[^\d:.apmAPM ]/g, '').slice(0, 8) : raw.replace(/[^\d:.]/g, '').slice(0, 5);
}

/** Cell of a column (hour or minute); `on` is the selected one (background and colour as a class). */
export interface TimeCell {
  label: string;
  on: boolean;
  fw: number;
  onClick: () => void;
}

/** Key in the field; `blur` takes the focus out of the field (Enter, Escape). */
export interface TimeKeyEvent extends KeyInput {
  shiftKey: boolean;
  blur: () => void;
}

/** Values of a time picker. */
export interface TimePickValues {
  /** Title of the popover or sheet and label of the field. */
  title: string;
  /** Selected time in the time format. */
  label: string;
  hh: string;
  mm: string;
  /** Text in the field: the typed one while the field has focus, otherwise `label`. */
  inputVal: string;
  /** 24-hour format: "Uhr" after the field. */
  h24: boolean;
  /** Popover at the field open (desktop only; on mobile the page shows the sheet). */
  open: boolean;
  disabled: boolean;
  close: () => void;
  toggle: () => void;
  onFocus: () => void;
  /** Typed text; returns the cleaned one the field should show. */
  onInput: (raw: string) => string;
  onBlur: () => void;
  onKey: (event: TimeKeyEvent) => void;
  hours: TimeCell[];
  mins: TimeCell[];
}

export interface TimePickInput {
  title: string;
  /** Stored time HH:MM. */
  value: string;
  disabled: boolean;
  /** 12-hour time format. */
  h12: boolean;
  /** This time picker is open (the popover on the desktop, the sheet on mobile). */
  open: boolean;
  /** Typed text in the field; `null` = none. */
  edit: string | null;
  isMobile: boolean;
}

export interface TimePickContext {
  set: (value: string) => void;
  /** Open or close (`false`); closing also discards the typed text. */
  show: (open: boolean) => void;
  /** Remember or discard (`null`) the typed text. */
  edit: (text: string | null) => void;
}

export function timePickValues(input: TimePickInput, ctx: TimePickContext): TimePickValues {
  const { h12, disabled, isMobile } = input;
  const [H = '00', M = '00'] = (input.value || '00:00').split(':');
  const label = h12 ? clockLabel(`${H}:${M}`, true) : `${H}:${M}`;
  const close = () => ctx.show(false);
  const cell = (text: string, on: boolean, onClick: () => void): TimeCell => ({
    label: text,
    on,
    fw: on ? 800 : 600,
    onClick,
  });
  return {
    title: input.title,
    label,
    hh: H,
    mm: M,
    inputVal: input.edit ?? label,
    h24: !h12,
    open: input.open && !isMobile,
    disabled,
    close,
    toggle: () => {
      if (disabled) return;
      ctx.edit(null);
      ctx.show(!input.open);
    },
    onFocus: () => {
      if (!disabled && !isMobile) ctx.show(true);
    },
    onInput: (raw) => {
      const text = cleanInput(raw, h12);
      if (disabled) return text;
      const parsed = parseTime(text.trim());
      if (parsed) ctx.set(parsed);
      ctx.edit(text);
      return text;
    },
    onBlur: () => ctx.edit(null),
    onKey: (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        event.blur();
        close();
      } else if (event.key === 'Escape') {
        event.blur();
        close();
      } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (disabled) return;
        ctx.set(stepTime(input.value, (event.key === 'ArrowUp' ? 1 : -1) * (event.shiftKey ? 60 : 5)));
        ctx.edit(null);
      } else if (event.key === 'Tab') close();
    },
    hours: Array.from({ length: 24 }, (_, i) => {
      const v = pad(i);
      return cell(h12 ? `${i % 12 || 12} ${i < 12 ? 'AM' : 'PM'}` : v, v === H, () => {
        ctx.set(`${v}:${M}`);
        ctx.edit(null);
      });
    }),
    mins: Array.from({ length: 60 }, (_, i) => {
      const v = pad(i);
      return cell(v, v === M, () => {
        ctx.set(`${H}:${v}`);
        // On mobile the sheet stays open ("Done"), on the desktop the minute closes the popover.
        if (isMobile) ctx.edit(null);
        else close();
      });
    }),
  };
}
