//! Format of a backup: a `.tar.zst` with `manifest.json` and the
//! snapshot of the database. The logo lives in the table `assets`
//! and comes along with it; `secret.key` never goes in.
//!
//! Only these two entries are read, and only into a file the caller names: no
//! path from the archive ever reaches the file system.

use std::{
    fs::File,
    io::{self, Read, Write as _},
    path::Path,
};

use anyhow::Context as _;
use jiff::Timestamp;
use serde::{Deserialize, Serialize};

use super::restore::Refused;
use crate::db;

/// Version of the format; this program does not read a newer one.
const FORMAT: u32 = 1;
const MANIFEST: &str = "manifest.json";
/// Enough for the details; anything larger is not a manifest.
const MAX_MANIFEST: u64 = 64 * 1024;
/// Level 3 is the zstd default: fast, and small enough for a database without
/// mails.
const LEVEL: i32 = 3;
/// Buffer while unpacking.
const CHUNK: usize = 64 * 1024;

/// Details of the backup. The list does without them (it reads the file
/// name); they explain the file even when it has a different name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    pub format: u32,
    /// Program version.
    pub version: String,
    /// Schema version of the database.
    pub schema: i64,
    pub created_at: String,
    pub auto: bool,
    /// Fingerprint of the instance key ([`super::key_mark`]).
    pub key: String,
}

impl Manifest {
    pub fn new(at: Timestamp, auto: bool, key: String, schema: i64) -> Self {
        Self {
            format: FORMAT,
            version: crate::updates::VERSION.to_owned(),
            schema,
            created_at: at.to_string(),
            auto,
            key,
        }
    }
}

/// Packs `database` and `manifest` into `target` (mode 0600) and flushes the
/// file to disk; returns its size. Blocks.
pub fn write(database: &Path, manifest: &Manifest, target: &Path) -> anyhow::Result<u64> {
    let mut encoder = zstd::Encoder::new(private_file(target)?, LEVEL)?;
    // Checksum over the content: this way `read` notices any damaged spot.
    encoder.include_checksum(true)?;
    let mut tar = tar::Builder::new(encoder);
    let mtime = u64::try_from(Timestamp::now().as_second()).unwrap_or(0);
    let text = serde_json::to_vec_pretty(manifest)?;
    append(
        &mut tar,
        MANIFEST,
        text.as_slice(),
        text.len() as u64,
        mtime,
    )?;
    let file = File::open(database)?;
    let size = file.metadata()?.len();
    append(&mut tar, db::DB_FILE, file, size, mtime)?;
    let file = tar.into_inner()?.finish()?;
    file.sync_all()?;
    Ok(file.metadata()?.len())
}

/// Creates `path` with mode 0600.
fn private_file(path: &Path) -> anyhow::Result<File> {
    db::create_private_file(path)
        .with_context(|| format!("cannot create file {}", path.display()))?;
    Ok(File::options().write(true).open(path)?)
}

fn append<W: io::Write>(
    tar: &mut tar::Builder<W>,
    name: &str,
    data: impl Read,
    size: u64,
    mtime: u64,
) -> io::Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(size);
    header.set_mode(0o600);
    header.set_mtime(mtime);
    tar.append_data(&mut header, name, data)
}

/// Reads the whole archive (including the checksum at the end) and unpacks the
/// database into `database` (mode 0600). Whatever cannot be read is
/// [`Refused::Invalid`]; an error while writing stays a server error. Blocks.
pub fn read(archive: &Path, database: &Path) -> anyhow::Result<Manifest> {
    let decoder = zstd::Decoder::new(File::open(archive)?).map_err(invalid)?;
    let mut tar = tar::Archive::new(decoder);
    let (mut manifest, mut unpacked) = (None, false);
    for entry in tar.entries().map_err(invalid)? {
        let mut entry = entry.map_err(invalid)?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(invalid)?.into_owned();
        if path == Path::new(MANIFEST) && manifest.is_none() {
            manifest = Some(read_manifest(&mut entry)?);
        } else if path == Path::new(db::DB_FILE) && !unpacked {
            unpack(&mut entry, database)?;
            unpacked = true;
        }
    }
    // The entries end before the zstd frame does; the checksum comes after.
    io::copy(&mut tar.into_inner(), &mut io::sink()).map_err(invalid)?;
    anyhow::ensure!(unpacked, Refused::Invalid);
    manifest.ok_or_else(|| Refused::Invalid.into())
}

/// Only the version: whatever else a newer format changes, this program does
/// not know.
#[derive(Deserialize)]
struct Format {
    format: u32,
}

fn read_manifest(entry: impl Read) -> anyhow::Result<Manifest> {
    let mut text = Vec::new();
    entry
        .take(MAX_MANIFEST)
        .read_to_end(&mut text)
        .map_err(invalid)?;
    let Format { format } = serde_json::from_slice(&text).map_err(invalid)?;
    anyhow::ensure!(format <= FORMAT, Refused::Newer);
    serde_json::from_slice(&text).map_err(invalid)
}

/// Copies in chunks instead of `io::copy` to separate errors reading the
/// archive from errors writing (full disk).
fn unpack(mut entry: impl Read, database: &Path) -> anyhow::Result<()> {
    let mut file = private_file(database)?;
    let mut chunk = vec![0; CHUNK];
    loop {
        let read = entry.read(&mut chunk).map_err(invalid)?;
        if read == 0 {
            return Ok(());
        }
        file.write_all(&chunk[..read])?;
    }
}

fn invalid(error: impl std::fmt::Display) -> anyhow::Error {
    tracing::warn!("backup not readable: {error}");
    Refused::Invalid.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        Manifest::new(Timestamp::UNIX_EPOCH, true, "fingerprint".to_owned(), 16)
    }

    fn packed(dir: &Path) -> std::path::PathBuf {
        let database = dir.join("source");
        std::fs::write(&database, vec![7; 100_000]).unwrap();
        let archive = dir.join("archive.tar.zst");
        write(&database, &manifest(), &archive).unwrap();
        archive
    }

    fn refused(result: anyhow::Result<Manifest>) -> Refused {
        *result.unwrap_err().downcast_ref::<Refused>().unwrap()
    }

    #[test]
    fn reads_what_it_wrote() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = packed(tmp.path());
        let database = tmp.path().join("target");

        assert_eq!(read(&archive, &database).unwrap(), manifest());
        assert_eq!(std::fs::read(&database).unwrap(), vec![7; 100_000]);
    }

    #[cfg(unix)]
    #[test]
    fn files_stay_private() {
        use std::os::unix::fs::PermissionsExt as _;

        let tmp = tempfile::tempdir().unwrap();
        let archive = packed(tmp.path());
        let database = tmp.path().join("target");
        read(&archive, &database).unwrap();

        for path in [archive, database] {
            let mode = std::fs::metadata(path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn notices_damage_anywhere_in_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = packed(tmp.path());
        let good = std::fs::read(&archive).unwrap();

        // Truncated, even if only by the checksum at the end.
        for cut in [good.len() / 2, good.len() - 1] {
            std::fs::write(&archive, &good[..cut]).unwrap();
            let result = read(&archive, &tmp.path().join("target"));
            assert_eq!(refused(result), Refused::Invalid, "at {cut}");
        }
        // One bit flipped.
        let mut bad = good.clone();
        *bad.last_mut().unwrap() ^= 1;
        std::fs::write(&archive, &bad).unwrap();
        assert_eq!(
            refused(read(&archive, &tmp.path().join("target"))),
            Refused::Invalid
        );
    }

    /// Builds an archive with the entries `(name, content)`.
    fn archive(path: &Path, entries: &[(&str, &[u8])]) {
        let encoder = zstd::Encoder::new(File::create(path).unwrap(), LEVEL).unwrap();
        let mut tar = tar::Builder::new(encoder);
        for (name, data) in entries {
            append(&mut tar, name, *data, data.len() as u64, 0).unwrap();
        }
        tar.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn needs_a_current_manifest_and_the_database() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("archive.tar.zst");
        let target = tmp.path().join("target");
        let good = serde_json::to_vec(&manifest()).unwrap();

        for entries in [
            vec![(MANIFEST, good.as_slice())],
            vec![(db::DB_FILE, b"data".as_slice())],
            vec![(MANIFEST, b"{".as_slice()), (db::DB_FILE, b"data")],
        ] {
            archive(&path, &entries);
            assert_eq!(refused(read(&path, &target)), Refused::Invalid);
            let _ = std::fs::remove_file(&target);
        }
    }

    #[test]
    fn a_newer_format_is_no_damage() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("archive.tar.zst");
        let manifest = br#"{ "format": 2, "barely": "known" }"#;
        archive(&path, &[(MANIFEST, manifest), (db::DB_FILE, b"data")]);

        assert_eq!(
            refused(read(&path, &tmp.path().join("target"))),
            Refused::Newer
        );
    }

    #[test]
    fn writes_nothing_outside_the_target() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("archive.tar.zst");
        let good = serde_json::to_vec(&manifest()).unwrap();
        archive(
            &path,
            &[
                ("other/file", b"foreign"),
                (MANIFEST, good.as_slice()),
                (db::DB_FILE, b"data"),
                ("second", b"foreign"),
            ],
        );
        let unpacked = tmp.path().join("empty");
        std::fs::create_dir(&unpacked).unwrap();

        read(&path, &unpacked.join("target")).unwrap();

        let names: Vec<_> = std::fs::read_dir(&unpacked)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["target"]);
    }
}
