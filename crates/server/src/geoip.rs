//! Location of a client IP from a GeoIP database: only
//! with `ROEDY_GEOIP_DB` (MaxMind DB format such as GeoLite2 or DB-IP Lite, as
//! a volume, not in the image). Without it, sessions, audit log and security
//! mails show the shortened IP address.
//!
//! The file is kept in memory: a City database costs as much RAM as its size
//! (GeoLite2-City ≈ 60 MB, -Country ≈ 9 MB). With `mmap` it would be less, but
//! `maxminddb` opens that only as `unsafe`, and the backend forbids `unsafe`
//! (workspace lints). When a tool such as `geoipupdate` replaces the file,
//! [`GeoIp::reload_if_changed`] reloads it (job `geoip_reload`, daily).

use std::{
    net::IpAddr,
    path::{Path, PathBuf},
    sync::RwLock,
    time::SystemTime,
};

use anyhow::{Context as _, ensure};
use maxminddb::{Reader, geoip2};

pub struct GeoIp {
    path: PathBuf,
    loaded: RwLock<Loaded>,
}

struct Loaded {
    reader: Reader<Vec<u8>>,
    modified: Option<SystemTime>,
}

impl GeoIp {
    /// Loads the database; a wrong path or a different kind of file is an error
    /// at startup so that a wrong setting gets noticed.
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        let loaded = load(path)?;
        Ok(Self {
            path: path.to_owned(),
            loaded: RwLock::new(loaded),
        })
    }

    /// Location ("Berlin, Germany"): city and country, otherwise one of them,
    /// each in English or German. Private networks are in no database (then `None`).
    pub fn place(&self, ip: IpAddr) -> Option<String> {
        let loaded = self.loaded.read().unwrap_or_else(|e| e.into_inner());
        let city: geoip2::City<'_> = loaded.reader.lookup(ip).ok()?.decode().ok()??;
        place_of(&city)
    }

    /// Reloads the file if it has changed; `true` after reloading. Until then
    /// the old one applies.
    pub fn reload_if_changed(&self) -> anyhow::Result<bool> {
        let modified = modified(&self.path)?;
        let current = self
            .loaded
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .modified;
        if modified.is_some() && modified == current {
            return Ok(false);
        }
        let loaded = load(&self.path)?;
        *self.loaded.write().unwrap_or_else(|e| e.into_inner()) = loaded;
        Ok(true)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn load(path: &Path) -> anyhow::Result<Loaded> {
    let modified = modified(path)?;
    let reader = Reader::open_readfile(path).with_context(|| {
        format!(
            "GeoIP database {} not readable (ROEDY_GEOIP_DB)",
            path.display()
        )
    })?;
    // An ASN or Anonymous IP database would also load but never name a
    // location.
    let kind = &reader.metadata().database_type;
    ensure!(
        is_place_database(kind),
        "GeoIP database {} contains no locations (type {kind}, expected City or \
         Country; ROEDY_GEOIP_DB)",
        path.display()
    );
    Ok(Loaded { reader, modified })
}

/// GeoLite2/GeoIP2 City and Country, DB-IP City/Country Lite.
fn is_place_database(kind: &str) -> bool {
    kind.contains("City") || kind.contains("Country")
}

fn modified(path: &Path) -> anyhow::Result<Option<SystemTime>> {
    let meta = std::fs::metadata(path)
        .with_context(|| format!("GeoIP database {} missing (ROEDY_GEOIP_DB)", path.display()))?;
    Ok(meta.modified().ok())
}

/// "City, Country" ("Hamburg, Germany"); without a city only the country;
/// English names, German ones where the database has no English name.
fn place_of<'a>(record: &geoip2::City<'a>) -> Option<String> {
    let name = |names: &geoip2::Names<'a>| -> Option<&'a str> {
        names
            .english
            .or(names.german)
            .map(str::trim)
            .filter(|name| !name.is_empty())
    };
    match (name(&record.city.names), name(&record.country.names)) {
        (Some(city), Some(country)) => Some(format!("{city}, {country}")),
        (city, country) => city.or(country).map(str::to_owned),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record<'a>(city: geoip2::Names<'a>, country: geoip2::Names<'a>) -> geoip2::City<'a> {
        let mut record = geoip2::City::default();
        record.city.names = city;
        record.country.names = country;
        record
    }

    fn names<'a>(de: Option<&'a str>, en: Option<&'a str>) -> geoip2::Names<'a> {
        geoip2::Names {
            german: de,
            english: en,
            ..Default::default()
        }
    }

    #[test]
    fn city_and_country_english_before_german() {
        let both = record(
            names(Some("city-de"), Some("Munich")),
            names(Some("country-de"), Some("Germany")),
        );
        assert_eq!(place_of(&both).as_deref(), Some("Munich, Germany"));
        let german = record(names(Some("Lyon"), None), names(None, Some("France")));
        assert_eq!(place_of(&german).as_deref(), Some("Lyon, France"));
        let city = record(names(None, Some("Vienna")), names(None, None));
        assert_eq!(place_of(&city).as_deref(), Some("Vienna"));
        let country = record(names(None, None), names(None, Some("Austria")));
        assert_eq!(place_of(&country).as_deref(), Some("Austria"));
        let blank = record(names(Some(" "), None), names(None, None));
        assert_eq!(place_of(&blank), None);
    }

    #[test]
    fn only_city_and_country_databases() {
        for kind in [
            "GeoLite2-City",
            "GeoIP2-City",
            "GeoLite2-Country",
            "DBIP-City-Lite",
            "DBIP-Country-Lite",
        ] {
            assert!(is_place_database(kind), "{kind}");
        }
        for kind in ["GeoLite2-ASN", "GeoIP2-Anonymous-IP", "GeoIP2-ISP"] {
            assert!(!is_place_database(kind), "{kind}");
        }
    }

    #[test]
    fn missing_file_is_an_error() {
        let error = GeoIp::open(Path::new("/does/not/exist.mmdb"))
            .err()
            .unwrap();
        assert!(format!("{error:#}").contains("ROEDY_GEOIP_DB"), "{error:#}");
    }
}
