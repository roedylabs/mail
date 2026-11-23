//! Schedule of the update check: interval, weekday and time of day.

use jiff::{
    SignedDuration, Timestamp,
    civil::{Time, Weekday},
    tz::TimeZone,
};
use serde::{Deserialize, Serialize};

/// Interval between two checks.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Every {
    #[serde(rename = "hourly")]
    Hourly,
    #[default]
    #[serde(rename = "daily")]
    Daily,
    #[serde(rename = "weekly")]
    Weekly,
}

/// Weekday of a weekly check.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Day {
    #[default]
    #[serde(rename = "monday")]
    Mon,
    #[serde(rename = "tuesday")]
    Tue,
    #[serde(rename = "wednesday")]
    Wed,
    #[serde(rename = "thursday")]
    Thu,
    #[serde(rename = "friday")]
    Fri,
    #[serde(rename = "saturday")]
    Sat,
    #[serde(rename = "sunday")]
    Sun,
}

impl Day {
    fn weekday(self) -> Weekday {
        match self {
            Self::Mon => Weekday::Monday,
            Self::Tue => Weekday::Tuesday,
            Self::Wed => Weekday::Wednesday,
            Self::Thu => Weekday::Thursday,
            Self::Fri => Weekday::Friday,
            Self::Sat => Weekday::Saturday,
            Self::Sun => Weekday::Sunday,
        }
    }
}

/// Next check after the last one (`last`): hourly one hour later,
/// otherwise the next slot at `time` in `tz`. If it lies in the past, for
/// example after a restart or a changed schedule, the check is due.
pub fn next(every: Every, day: Day, time: Time, tz: &TimeZone, last: Timestamp) -> Timestamp {
    let weekday = match every {
        Every::Hourly => {
            return last
                .checked_add(SignedDuration::from_hours(1))
                .unwrap_or(last);
        }
        Every::Daily => None,
        Every::Weekly => Some(day.weekday()),
    };
    let mut date = last.to_zoned_datetime(tz.clone()).date();
    // By the ninth day at the latest, every weekday lies after `last`.
    for _ in 0..9 {
        if weekday.is_none_or(|weekday| date.weekday() == weekday)
            // In a daylight saving gap, the time after it applies.
            && let Ok(slot) = date.to_datetime(time).to_zoned_datetime(tz.clone())
            && slot.timestamp() > last
        {
            return slot.timestamp();
        }
        match date.tomorrow() {
            Ok(tomorrow) => date = tomorrow,
            Err(_) => break,
        }
    }
    last
}

#[cfg(test)]
mod tests {
    use jiff::civil;

    use super::*;

    fn berlin() -> TimeZone {
        TimeZone::get("Europe/Berlin").unwrap()
    }

    fn at(text: &str) -> Timestamp {
        text.parse().unwrap()
    }

    const THREE: Time = civil::time(3, 0, 0, 0);

    #[test]
    fn hourly_counts_from_the_last_check() {
        assert_eq!(
            next(
                Every::Hourly,
                Day::Mon,
                THREE,
                &berlin(),
                at("2026-11-05T10:12:00Z")
            ),
            at("2026-11-05T11:12:00Z")
        );
    }

    #[test]
    fn daily_takes_the_next_time_in_the_zone() {
        let daily = |last| next(Every::Daily, Day::Mon, THREE, &berlin(), at(last));
        // 03:00 in Berlin is 02:00 UTC in winter.
        assert_eq!(daily("2026-11-05T01:00:00Z"), at("2026-11-05T02:00:00Z"));
        assert_eq!(daily("2026-11-05T02:00:00Z"), at("2026-11-06T02:00:00Z"));
        assert_eq!(daily("2026-11-05T15:00:00Z"), at("2026-11-06T02:00:00Z"));
        // Across midnight the date of the zone counts: 23:30 UTC is already the
        // next day in Berlin, and 03:00 is still ahead.
        assert_eq!(daily("2026-11-05T23:30:00Z"), at("2026-11-06T02:00:00Z"));
    }

    #[test]
    fn daily_survives_the_clock_change() {
        let daily = |time, last| next(Every::Daily, Day::Mon, time, &berlin(), at(last));
        // In the night to 2027-03-28, 02:30 does not exist: the time after it applies.
        assert_eq!(
            daily(civil::time(2, 30, 0, 0), "2027-03-27T12:00:00Z"),
            at("2027-03-28T01:30:00Z")
        );
        // Daylight saving time: 03:00 is 01:00 UTC.
        assert_eq!(
            daily(THREE, "2027-03-28T12:00:00Z"),
            at("2027-03-29T01:00:00Z")
        );
    }

    #[test]
    fn weekly_waits_for_the_weekday() {
        let weekly = |day, last| next(Every::Weekly, day, THREE, &berlin(), at(last));
        // 2026-11-05 is a Thursday.
        assert_eq!(
            weekly(Day::Mon, "2026-11-05T10:00:00Z"),
            at("2026-11-09T02:00:00Z")
        );
        assert_eq!(
            weekly(Day::Thu, "2026-11-05T01:00:00Z"),
            at("2026-11-05T02:00:00Z")
        );
        assert_eq!(
            weekly(Day::Thu, "2026-11-05T02:00:00Z"),
            at("2026-11-12T02:00:00Z")
        );
        assert_eq!(
            weekly(Day::Sun, "2026-11-05T10:00:00Z"),
            at("2026-11-08T02:00:00Z")
        );
    }

    #[test]
    fn names_are_the_stored_values() {
        for (every, name) in [
            (Every::Hourly, "hourly"),
            (Every::Daily, "daily"),
            (Every::Weekly, "weekly"),
        ] {
            assert_eq!(serde_json::to_value(every).unwrap(), name);
        }
        assert_eq!(serde_json::to_value(Day::Fri).unwrap(), "friday");
        assert_eq!(serde_json::to_value(Day::Sun).unwrap(), "sunday");
    }
}
