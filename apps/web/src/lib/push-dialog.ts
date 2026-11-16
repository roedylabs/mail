/**
 * Values of the push dialog: icon, title, text, steps and buttons per state
 * of `push.status`. Pure and without state; the component `PushDialog` and
 * the notifications page (title of the mobile sheet) call
 * `pushDialogValues()` with the state of `push`.
 */
import type { IconName } from '#lib/icons.ts';
import { m } from '#lib/paraglide/messages.js';
import type { PushStatus } from '#lib/push.svelte.ts';
import { overlayClose, type OverlayEvent } from '#lib/shell.ts';

export interface PushDialogInput {
  status: PushStatus;
  /** Device name of the subscription (`push.current?.device`). */
  device: string | null;
  /** Name of the app (`session.appName`). */
  appName: string;
  /** Address of the app (`location.host`). */
  host: string;
}

export interface PushDialogContext {
  request: () => void;
  retry: () => void;
  test: () => void;
  off: () => void;
  close: () => void;
}

/** Step of an instruction. */
export interface PushStep {
  n: string;
  x: string;
}

/**
 * Tile at the top left: `danger` when denied and not supported, `accent`
 * when active, otherwise `soft`.
 */
export type PushTileTone = 'danger' | 'accent' | 'soft';

export interface PushDialogValues {
  st: PushStatus;
  isAsk: boolean;
  isBusy: boolean;
  isDenied: boolean;
  isNone: boolean;
  isIos: boolean;
  isActive: boolean;
  /** "Later" and "Grant permission" (also while the browser asks). */
  canAsk: boolean;
  icon: IconName;
  title: string;
  text: string;
  steps: PushStep[];
  hasSteps: boolean;
  tileTone: PushTileTone;
  /** "Grant permission" or "Waiting …"; the icon spins and the cursor is `progress` while `isBusy`. */
  btn: string;
  btnIcon: IconName;
  /** Notice for iPhone and iPad for `ask` and `none`. */
  iosNote: boolean;
  iosText: string;
  request: () => void;
  retry: () => void;
  test: () => void;
  off: () => void;
  close: () => void;
  /** Click on the backdrop, not on the dialog. */
  overlay: (event: OverlayEvent) => void;
}

/** Icon, title, text and steps per state. */
function content(input: PushDialogInput): [IconName, string, string, string[]] {
  const app = input.appName;
  switch (input.status) {
    case 'ask':
      return ['ti-bell-ringing', m.push_ask_title(), m.push_ask_text({ app }), []];
    case 'busy':
      return ['ti-hourglass', m.push_busy_title(), m.push_busy_text(), []];
    case 'denied':
      return [
        'ti-bell-off',
        m.push_denied_title(),
        m.push_denied_text({ host: input.host }),
        [m.push_denied_step1(), m.push_denied_step2(), m.push_denied_step3()],
      ];
    case 'none':
      return ['ti-device-desktop-off', m.push_none_title(), m.push_none_text(), []];
    case 'ios':
      return [
        'ti-device-mobile-share',
        m.push_ios_title(),
        m.push_ios_text({ app }),
        [m.push_ios_step1(), m.push_ios_step2(), m.push_ios_step3({ app })],
      ];
    case 'active':
      // Active requires a subscription; without a device name "This device".
      return [
        'ti-bell-check',
        m.push_active_title(),
        m.push_active_text({ device: input.device || m.security_this_device() }),
        [],
      ];
  }
}

export function pushDialogValues(input: PushDialogInput, ctx: PushDialogContext): PushDialogValues {
  const st = input.status;
  const [icon, title, text, steps] = content(input);
  const isBusy = st === 'busy';
  return {
    st,
    isAsk: st === 'ask',
    isBusy,
    isDenied: st === 'denied',
    isNone: st === 'none',
    isIos: st === 'ios',
    isActive: st === 'active',
    canAsk: st === 'ask' || isBusy,
    icon,
    title,
    text,
    steps: steps.map((x, i) => ({ n: String(i + 1), x })),
    hasSteps: steps.length > 0,
    tileTone: st === 'denied' || st === 'none' ? 'danger' : st === 'active' ? 'accent' : 'soft',
    btn: isBusy ? m.push_btn_wait() : m.push_btn_grant(),
    btnIcon: isBusy ? 'ti-loader-2' : 'ti-bell-ringing',
    iosNote: st === 'ask' || st === 'none',
    iosText: m.push_ios_note({ app: input.appName }),
    request: ctx.request,
    retry: ctx.retry,
    test: ctx.test,
    off: ctx.off,
    close: ctx.close,
    overlay: overlayClose(ctx.close),
  };
}
