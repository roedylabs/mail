//! When notifications by email (and Web Push) arrive: quiet hours (`nQuiet`,
//! `nFrom`, `nTo`) and digest (`nDigest`) in the recipient's time zone (`tz`).
//!
//! Start = end counts as off; the start belongs to the quiet hours, the end
//! does not. The digest arrives daily or on Mondays at 07:00 – if 07:00 lies
//! within the quiet hours, at their end. Security notices know neither quiet
//! hours nor digest.

use jiff::{
    Timestamp,
    civil::{self, Time, Weekday},
    tz::TimeZone,
};

use crate::{
    mailer::format::named_zone,
    settings::{Digest, Settings},
};

/// Time of the digest without quiet hours.
const DIGEST_AT: Time = civil::time(7, 0, 0, 0);

/// Quiet hours with different start and end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Quiet {
    from: Time,
    to: Time,
}

impl Quiet {
    /// `None` if start and end are equal (no quiet hours).
    pub fn new(from: Time, to: Time) -> Option<Self> {
        (from != to).then_some(Self { from, to })
    }

    /// Whether the time `time` lies within the quiet hours, also across
    /// midnight.
    pub fn contains(&self, time: Time) -> bool {
        if self.from < self.to {
            self.from <= time && time < self.to
        } else {
            time >= self.from || time < self.to
        }
    }
}

/// Delivery plan of a recipient.
#[derive(Debug, Clone)]
pub struct Schedule {
    pub digest: Digest,
    quiet: Option<Quiet>,
    tz: TimeZone,
}

impl Schedule {
    pub fn new(digest: Digest, quiet: Option<Quiet>, tz: TimeZone) -> Self {
        Self { digest, quiet, tz }
    }

    /// From the recipient's settings.
    pub fn of(settings: &Settings) -> Self {
        let quiet = settings
            .n_quiet
            .then(|| Quiet::new(settings.n_from.time(), settings.n_to.time()))
            .flatten();
        Self::new(settings.n_digest, quiet, named_zone(settings.tz.as_str()))
    }

    /// Whether sending is allowed at `now`: outside the quiet hours.
    pub fn open(&self, now: Timestamp) -> bool {
        self.quiet
            .is_none_or(|quiet| !quiet.contains(now.to_zoned(self.tz.clone()).time()))
    }

    /// Time of the digest: 07:00, within the quiet hours their
    /// end.
    pub fn digest_at(&self) -> Time {
        match self.quiet {
            Some(quiet) if quiet.contains(DIGEST_AT) => quiet.to,
            _ => DIGEST_AT,
        }
    }

    /// When an entry from time `at` goes out at the earliest: at once for
    /// [`Digest::Instant`], otherwise with the next digest from `at`. Whether
    /// quiet hours then apply is answered by [`Self::open`] (e.g. after a
    /// restart).
    pub fn due(&self, at: Timestamp) -> Timestamp {
        let weekly = match self.digest {
            Digest::Instant => return at,
            Digest::Daily => false,
            Digest::Weekly => true,
        };
        let time = self.digest_at();
        let mut day = at.to_zoned(self.tz.clone()).date();
        // By the eighth day at the latest there is a Monday after `at`.
        for _ in 0..8 {
            if !weekly || day.weekday() == Weekday::Monday {
                // In a daylight saving gap the time after it applies.
                if let Ok(slot) = day.to_datetime(time).to_zoned(self.tz.clone())
                    && slot.timestamp() >= at
                {
                    return slot.timestamp();
                }
            }
            match day.tomorrow() {
                Ok(next) => day = next,
                Err(_) => break,
            }
        }
        at
    }

    /// Whether an entry from time `at` may go out at `now`.
    pub fn ready(&self, at: Timestamp, now: Timestamp) -> bool {
        self.open(now) && self.due(at) <= now
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn berlin(digest: Digest, quiet: Option<(&str, &str)>) -> Schedule {
        let quiet = quiet.and_then(|(from, to)| Quiet::new(clock(from), clock(to)));
        Schedule::new(digest, quiet, TimeZone::get("Europe/Berlin").unwrap())
    }

    fn clock(text: &str) -> Time {
        text.parse().unwrap()
    }

    /// Local time Berlin as a point in time.
    fn at(local: &str) -> Timestamp {
        local
            .parse::<civil::DateTime>()
            .unwrap()
            .to_zoned(TimeZone::get("Europe/Berlin").unwrap())
            .unwrap()
            .timestamp()
    }

    #[test]
    fn quiet_hours_over_midnight_and_within_a_day() {
        let night = Quiet::new(clock("22:00"), clock("07:00")).unwrap();
        assert!(night.contains(clock("22:00")), "start belongs to it");
        assert!(night.contains(clock("03:00")));
        assert!(night.contains(clock("06:59:59")));
        assert!(!night.contains(clock("07:00")), "end does not");
        assert!(!night.contains(clock("12:00")));
        let noon = Quiet::new(clock("12:00"), clock("14:00")).unwrap();
        assert!(noon.contains(clock("13:00")));
        assert!(!noon.contains(clock("14:00")));
        assert!(!noon.contains(clock("23:00")));
        assert_eq!(
            Quiet::new(clock("22:00"), clock("22:00")),
            None,
            "equal counts as off"
        );
    }

    #[test]
    fn instant_goes_at_once_outside_quiet_hours() {
        let s = berlin(Digest::Instant, Some(("22:00", "07:00")));
        let event = at("2026-11-04T23:10:00");
        assert_eq!(s.due(event), event);
        assert!(!s.ready(event, at("2026-11-04T23:11:00")), "quiet hours");
        assert!(!s.ready(event, at("2026-11-05T06:59:00")));
        assert!(s.ready(event, at("2026-11-05T07:00:00")), "at their end");
        let s = berlin(Digest::Instant, None);
        assert!(s.ready(event, event));
    }

    #[test]
    fn daily_at_seven_local_time() {
        let s = berlin(Digest::Daily, None);
        assert_eq!(s.due(at("2026-11-04T06:59:00")), at("2026-11-04T07:00:00"));
        assert_eq!(s.due(at("2026-11-04T07:00:00")), at("2026-11-04T07:00:00"));
        assert_eq!(s.due(at("2026-11-04T07:01:00")), at("2026-11-05T07:00:00"));
        // Daylight saving time ends on 2026-10-25: 07:00 stays 07:00 local time.
        assert_eq!(
            s.due(at("2026-10-24T20:00:00")),
            "2026-10-25T06:00:00Z".parse().unwrap()
        );
        assert_eq!(
            s.due(at("2026-10-23T20:00:00")),
            "2026-10-24T05:00:00Z".parse().unwrap()
        );
    }

    #[test]
    fn weekly_on_monday() {
        let s = berlin(Digest::Weekly, None);
        // 2026-11-04 is a Wednesday.
        assert_eq!(s.due(at("2026-11-04T12:00:00")), at("2026-11-09T07:00:00"));
        assert_eq!(s.due(at("2026-11-09T06:00:00")), at("2026-11-09T07:00:00"));
        assert_eq!(s.due(at("2026-11-09T07:30:00")), at("2026-11-16T07:00:00"));
    }

    #[test]
    fn digest_at_the_end_of_quiet_hours_when_seven_is_inside() {
        let s = berlin(Digest::Daily, Some(("22:00", "08:30")));
        assert_eq!(s.digest_at(), clock("08:30"));
        assert_eq!(s.due(at("2026-11-04T09:00:00")), at("2026-11-05T08:30:00"));
        assert!(!s.ready(at("2026-11-04T09:00:00"), at("2026-11-05T08:29:00")));
        assert!(s.ready(at("2026-11-04T09:00:00"), at("2026-11-05T08:30:00")));
        let s = berlin(Digest::Daily, Some(("22:00", "06:00")));
        assert_eq!(s.digest_at(), clock("07:00"), "07:00 is not inside");
        let s = berlin(Digest::Weekly, Some(("06:00", "07:00")));
        assert_eq!(
            s.digest_at(),
            clock("07:00"),
            "the end does not belong to it"
        );
    }

    #[test]
    fn late_digest_waits_for_the_end_of_quiet_hours() {
        // The server was off at 07:00 and runs again at 23:00.
        let s = berlin(Digest::Daily, Some(("22:00", "07:00")));
        let event = at("2026-11-03T15:00:00");
        assert!(!s.ready(event, at("2026-11-04T23:00:00")));
        assert!(s.ready(event, at("2026-11-04T21:59:00")));
    }

    #[test]
    fn of_reads_the_settings() {
        let mut settings = Settings {
            n_quiet: true,
            n_from: "22:00".to_owned().try_into().unwrap(),
            n_to: "08:00".to_owned().try_into().unwrap(),
            n_digest: Digest::Weekly,
            tz: "America/New_York".to_owned().try_into().unwrap(),
            ..Settings::default()
        };
        let s = Schedule::of(&settings);
        assert_eq!(s.digest_at(), clock("08:00"));
        assert_eq!(
            s.due("2026-11-04T17:00:00Z".parse().unwrap()),
            "2026-11-09T13:00:00Z".parse().unwrap(),
            "Monday 08:00 in New York"
        );
        settings.n_to = "22:00".to_owned().try_into().unwrap();
        assert_eq!(Schedule::of(&settings).digest_at(), clock("07:00"));
    }
}
