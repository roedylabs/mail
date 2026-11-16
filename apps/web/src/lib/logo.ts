/** Logo of the app: values object `logo` from the branding. */
import type { Branding } from '#lib/state/session.svelte.ts';

/** Props of the logo component. */
export interface LogoValues {
  isMark?: boolean;
  isInit?: boolean;
  isIcon?: boolean;
  isFill?: boolean;
  isPad?: boolean;
  text?: string;
  fs?: string;
  icon?: string;
  src?: string;
}

/** Logo values from the branding. */
export function mkLogo(b: Branding, name: string): LogoValues {
  const img = b.kind === 'image' && !!b.image;
  const icon = b.kind === 'icon';
  const mark = b.kind === 'standard';
  const text = b.letter.trim() || (name.trim()[0] ?? 'A').toUpperCase();
  return {
    isMark: mark,
    isInit: !img && !icon && !mark,
    isIcon: icon,
    isFill: img && b.fit === 'fill',
    isPad: img && b.fit !== 'fill',
    text,
    fs: text.length > 1 ? '38cqmin' : '50cqmin',
    icon: b.icon,
    src: img ? (b.image ?? '') : '',
  };
}
