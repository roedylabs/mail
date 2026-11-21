/**
 * Heading and intro of every setup step in every language, for the space the
 * shell keeps for them on desktop: the step overview below them stays in the
 * same place on every step and in both languages. An intro is three parts,
 * the middle one bold (the administrator's email on the password step).
 */
import { m } from '#lib/paraglide/messages.js';
import { locales } from '#lib/paraglide/runtime.js';

export type IntroParts = readonly [string, string, string];

export interface StepHead {
  title: string;
  long: IntroParts;
  short: IntroParts;
}

export function setupHeads(app: string, email: string): StepHead[] {
  return locales.flatMap((locale) => {
    const o = { locale };
    const plain = (text: string): IntroParts => [text, '', ''];
    const before = m.setup_pw_intro_before({}, o);
    return [
      {
        title: m.setup_welcome_title({ app }, o),
        long: plain(m.setup_welcome_intro({ app }, o)),
        short: plain(m.setup_welcome_intro_short({}, o)),
      },
      {
        title: m.setup_token_title({ app }, o),
        long: plain(m.setup_token_intro({}, o)),
        short: plain(m.setup_token_intro_short({}, o)),
      },
      {
        title: m.setup_admin_title({}, o),
        long: plain(m.setup_admin_intro({}, o)),
        short: plain(m.setup_admin_intro_short({ app }, o)),
      },
      {
        title: m.setup_pw_title({}, o),
        long: [before, email, m.setup_pw_intro_after({}, o)],
        short: [before, email, m.setup_pw_intro_after_short({}, o)],
      },
      {
        title: m.setup_review_title({}, o),
        long: plain(m.setup_review_intro({}, o)),
        short: plain(m.setup_review_intro_short({}, o)),
      },
    ];
  });
}
