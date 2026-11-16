//! Preview of the mail templates for Administration › Email › Templates
//! (`system-mail/preview`).
//!
//! Rendering uses the same templates as sending, with the current branding
//! and fixed sample data: the recipient of most templates is the signed-in
//! administrator (first name in the greeting, their address, as inviter
//! their full name), times are relative to `ctx.now`. The test email
//! (`test`) goes to the administrator as well, like the default of the Test
//! section's address field.

use std::net::{IpAddr, Ipv4Addr};

use jiff::SignedDuration;
use serde_json::{Value, json};

use super::{
    Mail,
    format::first_name,
    templates::{
        Context, Digest, DigestInstant, EmailConfirm, Invite, Notice, Place, Reset, SecurityEmail,
        SecurityLogin, SecurityMfaReset, SecurityPassword, SecurityRecoveryCodes,
        SecurityRecoveryUsed, SecurityTotpAdded, SecurityTotpRemoved, SystemBackup, SystemTest,
        SystemUpdate,
    },
};
use crate::{
    auth::device,
    db::repo::users::Role,
    events::texts,
    i18n::{t, tf},
    jobs::notification_mailer::MAX_NOTICES,
};

/// Templates of the tab with their variants, in the order of the tab; the
/// first variant applies if none is given.
pub const TEMPLATES: [(&str, &[&str]); 7] = [
    ("invite", &[]),
    ("reset", &[]),
    ("email", &[]),
    (
        "security",
        &[
            "login",
            "login_no_place",
            "password",
            "password_sole_admin",
            "password_reset",
            "email",
            "mfa_reset",
            "totp_add",
            "totp_add_first",
            "totp_add_first_sole_admin",
            "totp_remove",
            "totp_remove_last",
            "recovery_used",
            "recovery_used_none",
            "recovery_used_new_device",
            "recovery_codes",
        ],
    ),
    ("digest", &["summary", "one", "over_50", "instant"]),
    ("system", &["backup", "update"]),
    ("test", &[]),
];

/// Who views the preview: recipient of most samples.
#[derive(Debug, Clone, Copy)]
pub struct Viewer<'a> {
    /// Display name; the greeting uses the first name.
    pub name: &'a str,
    pub email: &'a str,
}

/// Template and variant from [`TEMPLATES`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Choice {
    template: &'static str,
    /// Empty for templates without variants.
    variant: &'static str,
}

/// Place of the samples, as GeoIP stores it.
const PLACE: &str = "Hamburg, Germany";
const IP: IpAddr = IpAddr::V4(Ipv4Addr::new(198, 51, 100, 56));
/// New address of a pending change.
const NEW_EMAIL: &str = "max.mustermann@example.com";
/// Digest entries: topic, event, details and age in hours. Title and text are
/// built as in the bell (`events::texts`), i.e. in the preview's language.
fn notice_examples() -> [(&'static str, &'static str, Value, i64); 3] {
    [
        (
            "team",
            "team.invite_accepted",
            json!({ "name": "Sophie Hoffmann" }),
            5,
        ),
        // 1.2 GB
        (
            "system",
            "system.backup_ok",
            json!({ "size": 1_288_490_189_u64 }),
            9,
        ),
        ("news", "news.welcome", json!({}), 8 * 24),
    ]
}
/// Variant "over_50": this many entries three hours apart.
const OVER_50: i64 = 57;
/// Target of "Invitation accepted", button of the variant "instant".
const INSTANT_PATH: &str = "/admin/users";

impl Choice {
    /// Checks template and variant; without a variant the first applies. `None` for
    /// unknown ones and for a variant of a template without variants.
    pub fn parse(template: &str, variant: Option<&str>) -> Option<Self> {
        let (template, variants) = TEMPLATES.iter().find(|(key, _)| *key == template)?;
        let variant = match variant {
            None => variants.first().copied().unwrap_or_default(),
            Some(variant) => *variants.iter().find(|known| **known == variant)?,
        };
        Some(Self { template, variant })
    }

    /// Renders the template with the sample data.
    pub fn render(self, viewer: &Viewer<'_>, ctx: &Context<'_>) -> anyhow::Result<Mail> {
        let now = ctx.now;
        let hours = |n: i64| now - SignedDuration::from_hours(n);
        // Two hours ago, so usually "Today, …".
        let at = hours(2);
        let (to, name) = (viewer.email, viewer.name);
        let admin = Some(name).filter(|name| !name.trim().is_empty());
        let hamburg = Place {
            place: Some(PLACE),
            ip: IP,
        };
        let lang = ctx.format.lang();
        let device = device::label(Some("Safari"), Some("iPhone"), lang);
        let cx = texts::Context {
            lang,
            app: &ctx.brand.app,
        };
        let notices: Vec<Notice> = notice_examples()
            .iter()
            .map(|(topic, kind, params, age)| {
                let shown = texts::render(topic, kind, params, &cx);
                Notice {
                    title: shown.title,
                    text: shown.text,
                    at: hours(*age),
                }
            })
            .collect();
        let authenticator = t(lang, "totp.default_name");
        let digest = |notices: &[Notice], total| {
            Digest {
                to,
                name,
                notices,
                total,
            }
            .render(ctx)
        };
        let password = |reset, sole_admin| {
            SecurityPassword {
                to,
                name,
                device: &device,
                reset,
                sole_admin,
                at,
            }
            .render(ctx)
        };
        let totp_added = |first_app, sole_admin| {
            SecurityTotpAdded {
                to,
                name,
                app: authenticator,
                first_app,
                sole_admin,
                device: &device,
                place: hamburg,
                at,
            }
            .render(ctx)
        };
        // Name of the removed app.
        let first = first_name(name).unwrap_or_else(|| "Max".into());
        let iphone = tf(lang, "preview.phone_name", &[("name", &first)]);
        let totp_removed = |app: &str, last| {
            SecurityTotpRemoved {
                to,
                name,
                app,
                last,
                device: &device,
                place: hamburg,
                at,
            }
            .render(ctx)
        };
        let recovery_used = |remaining, new_device| {
            SecurityRecoveryUsed {
                to,
                name,
                remaining,
                total: 10,
                new_device,
                device: &device,
                place: hamburg,
                at,
            }
            .render(ctx)
        };
        match (self.template, self.variant) {
            ("invite", _) => Invite {
                to: "jonas.schulz@example.com",
                name: Some("Jonas"),
                inviter: admin,
                role: Role::User,
                token: "k7Qe2xR9",
                expires_at: now + SignedDuration::from_hours(7 * 24),
            }
            .render(ctx),
            ("reset", _) => Reset {
                to,
                name,
                token: "Zm4pT1",
            }
            .render(ctx),
            ("email", _) => EmailConfirm {
                to: NEW_EMAIL,
                name,
                token: "b3Xr8kQ2vN",
            }
            .render(ctx),
            ("security", "login") => SecurityLogin {
                to,
                name,
                device: &device,
                place: hamburg,
                at,
            }
            .render(ctx),
            ("security", "login_no_place") => SecurityLogin {
                to,
                name,
                device: &device,
                place: Place {
                    place: None,
                    ip: IP,
                },
                at,
            }
            .render(ctx),
            ("security", "password") => password(false, false),
            ("security", "password_sole_admin") => password(false, true),
            ("security", "password_reset") => password(true, false),
            ("security", "email") => SecurityEmail {
                to,
                name,
                new_email: NEW_EMAIL,
                device: &device::label(Some("Chrome"), Some("macOS"), lang),
                place: Place {
                    place: Some("Berlin, Germany"),
                    ip: IpAddr::V4(Ipv4Addr::new(203, 0, 113, 2)),
                },
                at,
            }
            .render(ctx),
            ("security", "mfa_reset") => SecurityMfaReset {
                to: "lukas.wagner@example.com",
                name: "Lukas Wagner",
                by: admin,
                at: now - SignedDuration::from_mins(20),
            }
            .render(ctx),
            ("security", "totp_add") => totp_added(false, false),
            ("security", "totp_add_first") => totp_added(true, false),
            ("security", "totp_add_first_sole_admin") => totp_added(true, true),
            ("security", "totp_remove") => totp_removed(&iphone, false),
            ("security", "totp_remove_last") => totp_removed(authenticator, true),
            ("security", "recovery_used") => recovery_used(9, false),
            ("security", "recovery_used_none") => recovery_used(0, false),
            ("security", "recovery_used_new_device") => recovery_used(9, true),
            ("security", "recovery_codes") => SecurityRecoveryCodes {
                to,
                name,
                device: &device,
                place: hamburg,
                at,
            }
            .render(ctx),
            ("digest", "summary") => digest(&notices, notices.len()),
            ("digest", "one") => digest(&notices[..1], 1),
            ("digest", "over_50") => {
                let many: Vec<Notice> = (1..=OVER_50)
                    .zip(notices.iter().cycle())
                    .map(|(n, notice)| Notice {
                        at: hours(3 * n),
                        ..notice.clone()
                    })
                    .collect();
                digest(&many[..MAX_NOTICES.min(many.len())], many.len())
            }
            ("digest", "instant") => DigestInstant {
                to,
                name,
                notice: &notices[0],
                path: Some(INSTANT_PATH),
            }
            .render(ctx),
            ("system", "backup") => SystemBackup {
                to,
                name,
                at: hours(9),
                // 1.2 GB
                size: 1_288_490_189,
                keep_days: 30,
            }
            .render(ctx),
            ("system", "update") => SystemUpdate {
                to,
                name,
                version: "0.2.0",
                previous: "0.1.0",
            }
            .render(ctx),
            ("test", _) => SystemTest { to }.render(ctx),
            (template, variant) => {
                anyhow::bail!("preview without a sample: {template} {variant}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use jiff::Timestamp;
    use url::Url;

    use super::*;
    use crate::{
        instance::APP_NAME,
        mailer::{
            format::Format,
            templates::{Accent, Brand, Theme, tests::assert_german},
        },
        settings::Language,
    };

    const VIEWER: Viewer<'static> = Viewer {
        name: "Max Mustermann",
        email: "max@example.net",
    };

    fn render(template: &str, variant: Option<&str>, theme: Theme) -> Mail {
        render_with(&Brand::default(), template, variant, theme)
    }

    fn render_with(brand: &Brand, template: &str, variant: Option<&str>, theme: Theme) -> Mail {
        render_in(brand, template, variant, theme, Language::English)
    }

    fn render_in(
        brand: &Brand,
        template: &str,
        variant: Option<&str>,
        theme: Theme,
        lang: Language,
    ) -> Mail {
        let format = Format::default().with_lang(lang);
        let public_url = Url::parse("https://app.example.com/").unwrap();
        let ctx = Context {
            brand,
            theme,
            format: &format,
            public_url: &public_url,
            // 24 October 2026, 18:00 in Berlin.
            now: "2026-10-24T16:00:00Z".parse::<Timestamp>().unwrap(),
            inline_logo: true,
        };
        Choice::parse(template, variant)
            .unwrap()
            .render(&VIEWER, &ctx)
            .unwrap()
    }

    /// Every template of the tab with each of its variants (`None` for
    /// templates without variants).
    fn choices() -> Vec<(&'static str, Option<&'static str>)> {
        TEMPLATES
            .iter()
            .flat_map(|(template, variants)| {
                let variants: Vec<Option<&'static str>> = if variants.is_empty() {
                    vec![None]
                } else {
                    variants.iter().copied().map(Some).collect()
                };
                variants
                    .into_iter()
                    .map(move |variant| (*template, variant))
            })
            .collect()
    }

    /// Every template and variant of the tab has a sample with its subject
    /// and recipient.
    #[test]
    fn every_template_and_variant_renders() {
        let seen: Vec<_> = choices()
            .into_iter()
            .map(|(template, variant)| {
                let mail = render(template, variant, Theme::Light);
                assert!(!mail.html.is_empty() && !mail.text.is_empty());
                (mail.template, mail.to, mail.subject)
            })
            .collect();
        let expected = [
            (
                "invite",
                "jonas.schulz@example.com",
                "Invitation to Roedy Mail",
            ),
            ("reset", VIEWER.email, "Reset your Roedy Mail password"),
            (
                "email_confirm",
                NEW_EMAIL,
                "Confirm your new email address for Roedy Mail",
            ),
        ];
        for (i, (template, to, subject)) in expected.into_iter().enumerate() {
            assert_eq!(seen[i], (template, to.to_owned(), subject.to_owned()));
        }
        let names: Vec<_> = seen.iter().map(|(template, ..)| *template).collect();
        assert_eq!(names.len(), 3 + 16 + 4 + 2 + 1);
        assert_eq!(
            names[3..],
            [
                "security_login",
                "security_login",
                "security_password",
                "security_password",
                "security_password",
                "security_email",
                "security_mfa_reset",
                "security_totp_add",
                "security_totp_add",
                "security_totp_add",
                "security_totp_remove",
                "security_totp_remove",
                "security_recovery_used",
                "security_recovery_used",
                "security_recovery_used",
                "security_recovery_codes",
                "digest",
                "digest",
                "digest",
                "digest_instant",
                "system_backup",
                "system_update",
                "system_test",
            ]
        );
        assert_eq!(seen[3 + 6].1, "lukas.wagner@example.com");
        assert_eq!(seen[3 + 16 + 3].2, "Invitation accepted");
        assert_eq!(
            seen[3 + 16 + 4..],
            [
                (
                    "system_backup",
                    VIEWER.email.to_owned(),
                    "Backup completed".to_owned()
                ),
                (
                    "system_update",
                    VIEWER.email.to_owned(),
                    "Update to version 0.2.0 installed".to_owned()
                ),
                (
                    "system_test",
                    VIEWER.email.to_owned(),
                    "Test email from Roedy Mail".to_owned()
                ),
            ]
        );
    }

    /// Every template and variant also renders in German, from the German
    /// templates and texts.
    #[test]
    fn every_template_and_variant_renders_in_german() {
        let brand = Brand::default();
        let (topic, kind, params, _) = &notice_examples()[0];
        let cx = texts::Context {
            lang: Language::German,
            app: APP_NAME,
        };
        let instant = texts::render(topic, kind, params, &cx).title;
        for (template, variant) in choices() {
            for theme in [Theme::Light, Theme::Dark] {
                let english = render_in(&brand, template, variant, theme, Language::English);
                let german = render_in(&brand, template, variant, theme, Language::German);
                assert_german(&english, &german, &brand.app, &instant);
            }
        }
    }

    #[test]
    fn first_variant_without_a_name_and_unknown_ones_rejected() {
        assert_eq!(
            Choice::parse("security", None),
            Choice::parse("security", Some("login"))
        );
        assert_eq!(Choice::parse("invite", None).unwrap().variant, "");
        for (template, variant) in [
            ("system_test", None),
            ("test", Some("")),
            ("security_login", None),
            ("invite", Some("")),
            ("invite", Some("login")),
            ("security", Some("")),
            ("security", Some("backup")),
            ("digest", Some("Instant")),
        ] {
            assert_eq!(
                Choice::parse(template, variant),
                None,
                "{template} {variant:?}"
            );
        }
    }

    /// "one" shows only the newest entry, "over_50" the newest 50 of 57 with
    /// the rest below.
    #[test]
    fn digest_variants() {
        let one = render("digest", Some("one"), Theme::Light).text;
        assert!(one.contains("1 new notification "), "{one}");
        assert!(one.contains("Invitation accepted") && !one.contains("Welcome"));
        let many = render("digest", Some("over_50"), Theme::Light).text;
        assert!(many.contains("57 new notifications"), "{many}");
        assert_eq!(many.matches("\n* ").count(), MAX_NOTICES);
        assert!(many.contains("… and 7 more notifications"), "{many}");
        let instant = render("digest", Some("instant"), Theme::Light).text;
        assert!(
            instant.contains("https://app.example.com/admin/users"),
            "{instant}"
        );
    }

    /// Samples with the signed-in administrator: greeting, inviter and
    /// who reset multi-factor.
    #[test]
    fn the_viewer_is_recipient_and_inviter() {
        let invite = render("invite", None, Theme::Light).text;
        assert!(invite.starts_with("Hi Jonas,"), "{invite}");
        assert!(invite.contains("Max Mustermann has invited you to Roedy Mail"));
        assert!(invite.contains("valid until 31 October 2026"), "{invite}");
        let reset = render("security", Some("mfa_reset"), Theme::Light).text;
        assert!(reset.starts_with("Hi Lukas,"), "{reset}");
        assert!(
            reset.contains("Max Mustermann reset multi-factor authentication for your Roedy Mail account on 24 October 2026 at 17:40"),
            "{reset}"
        );
        let removed = render("security", Some("totp_remove"), Theme::Light).text;
        assert!(
            removed.contains("\u{201c}Max’s iPhone\u{201d}"),
            "{removed}"
        );
        let login = render("security", Some("login"), Theme::Light).text;
        assert!(login.contains("Time: Today, 16:00"), "{login}");
    }

    #[test]
    fn logo_inline_and_dark() {
        let html = render("system", Some("update"), Theme::Dark).html;
        assert!(html.contains(r#"<img src="data:image/png;base64,iVBORw0KGgo"#));
        assert!(!html.contains("/branding/mail-logo.png"));
        assert!(html.contains("#221d19") && !html.contains("#ffffff"));
    }

    /// Branding as when sending: app name (escaped), brand colour, without
    /// a PNG only the plate.
    #[test]
    fn branding_without_png_shows_only_the_plate() {
        let brand = Brand {
            app: "Post & Co".into(),
            accent: Accent::named("sky"),
            logos: None,
            ..Brand::default()
        };
        let mail = render_with(&brand, "system", Some("update"), Theme::Light);
        assert!(!mail.html.contains("<img"), "{}", mail.html);
        assert!(
            mail.html.contains(r##"bgcolor="#82bbec""##),
            "{}",
            mail.html
        );
        assert!(
            mail.html.contains("Post &#38; Co is now running"),
            "{}",
            mail.html
        );
        assert!(
            mail.text
                .contains("Post & Co is now running version 0.2.0.")
        );
    }
}
