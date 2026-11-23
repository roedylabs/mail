/**
 * Heading and intro of every invitation step in every language, for the
 * space the shell keeps for them in two columns: the step overview below
 * them stays in the same place on every step and in both languages. Step 1
 * comes twice: with the inviter's name and with "Your administrator" (an
 * invitation whose inviter was deleted).
 */
import type { IntroParts, StepHead } from '#lib/auth-layout.ts';
import { m } from '#lib/paraglide/messages.js';
import { locales } from '#lib/paraglide/runtime.js';

export function inviteHeads(app: string, inviter: string | null): StepHead[] {
  return locales.flatMap((locale) => {
    const o = { locale };
    const plain = (text: string): IntroParts => [text, '', ''];
    const head = (title: string, intro: string): StepHead => ({ title, long: plain(intro), short: plain(intro) });
    const froms = [...new Set([inviter, m.invite_from_fallback_subject({}, o)].filter((f): f is string => !!f))];
    return [
      ...froms.map((from) => head(m.invite_title({ app }, o), m.invite_intro({ from }, o))),
      head(m.invite_setup_title({}, o), m.invite_setup_intro({}, o)),
      head(m.invite_mfa_title({}, o), m.invite_mfa_intro({}, o)),
      head(m.invite_codes_title({}, o), m.invite_codes_intro({}, o)),
    ];
  });
}
