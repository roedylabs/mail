/**
 * Heading and intro of every form screen of the sign-in page in every
 * language, for the space the shell keeps for them on desktop: the overview
 * below them stays in the same place on every screen and in both languages.
 * "Sign in" uses the branding defaults (the page's own title and text lie in
 * the same cell anyway).
 */
import type { IntroParts, StepHead } from '#lib/auth-layout.ts';
import { m } from '#lib/paraglide/messages.js';
import { locales } from '#lib/paraglide/runtime.js';

export function signInHeads(): StepHead[] {
  return locales.flatMap((locale) => {
    const o = { locale };
    const head = (title: string, intro: string): StepHead => {
      const parts: IntroParts = [intro, '', ''];
      return { title, long: parts, short: parts };
    };
    return [
      head(m.branding_login_title_ph({}, o), m.branding_login_text_ph({}, o)),
      head(m.login_otp_title({}, o), m.login_otp_intro({}, o)),
      head(m.login_bc_title({}, o), m.login_bc_intro({}, o)),
      head(m.login_forgot_title({}, o), m.login_forgot_intro({}, o)),
      head(m.login_newpw_title({}, o), m.login_newpw_intro({}, o)),
    ];
  });
}
