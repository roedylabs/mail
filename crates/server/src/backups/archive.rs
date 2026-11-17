//! Format of a backup: a `.tar.zst` with `manifest.json` and the
//! snapshot of the database. The logo lives in the table `assets`
//! and comes along with it; `secret.key` never goes in.
//!
//! Only these two entries are read, and only into a file the caller names: no
//! path from the archive ever reaches the file system.
//!
//! The manifest carries an HMAC with the instance key over all of its fields
//! and the SHA-256 of the database ([`Manifest::mac`]). Whoever can write to
//! the backup directory (it may be a share) but does not have the key cannot
//! pack a database of their own: [`read`] rejects it.

use std::{
    cell::Cell,
    fs::{self, File},
    io::{self, Read, Write as _},
    path::{Path, PathBuf},
    rc::Rc,
};

use anyhow::Context as _;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use jiff::Timestamp;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use super::{key_mark, restore::Refused};
use crate::{broker::crypto::SecretKey, db};

/// Version of the format; this program reads only this one. Format 1 had no
/// MAC and is rejected ([`Refused::Older`]).
const FORMAT: u32 = 2;
const MANIFEST: &str = "manifest.json";
/// Purpose of the MAC over manifest and database.
const MAC_PURPOSE: &str = "backups.manifest";
/// Enough for the details; anything larger is not a manifest.
const MAX_MANIFEST: u64 = 64 * 1024;
/// The database unpacks to at most this many times the size of the archive,
/// but always to [`MIN_LIMIT`]. zstd packs runs of equal bytes more than a
/// thousandfold; a database with a large audit log compresses about 6:1, a
/// nearly empty one about 40:1, and that one is small.
const MAX_RATIO: u64 = 64;
/// Lower bound of the limit, so that small backups never reach it.
pub const MIN_LIMIT: u64 = 64 * 1024 * 1024;
/// Decompressed bytes an archive may hold besides the database: tar headers,
/// padding, end blocks and the manifest ([`MAX_MANIFEST`]).
const OVERHEAD: u64 = MAX_MANIFEST + 64 * 1024;
/// Level 3 is the zstd default: fast, and small enough for a database without
/// mails.
const LEVEL: i32 = 3;
/// Buffer while hashing and unpacking.
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
    /// Fingerprint of the instance key ([`super::key_mark`]). Proves nothing;
    /// it only tells a backup of another instance apart from a forged one.
    pub key: String,
    /// HMAC-SHA-256 (Base64) with the instance key over all fields above and
    /// the SHA-256 of the database. [`write`] sets it, [`read`] checks it.
    pub mac: String,
}

impl Manifest {
    /// Without key and MAC: [`write`] fills them in.
    pub fn new(at: Timestamp, auto: bool, schema: i64) -> Self {
        Self {
            format: FORMAT,
            version: crate::updates::VERSION.to_owned(),
            schema,
            created_at: at.to_string(),
            auto,
            key: String::new(),
            mac: String::new(),
        }
    }

    /// The parts of the MAC: every field except the MAC itself, in a fixed
    /// order, and the hash of the database. [`SecretKey::mac`] puts the length
    /// in front of each part, so no field can shift into the next one.
    fn mac_parts<T>(&self, database: &[u8; 32], f: impl FnOnce(&[&[u8]]) -> T) -> T {
        f(&[
            &self.format.to_be_bytes(),
            self.version.as_bytes(),
            &self.schema.to_be_bytes(),
            self.created_at.as_bytes(),
            &[u8::from(self.auto)],
            self.key.as_bytes(),
            database,
        ])
    }

    fn sign(&mut self, secrets: &SecretKey, database: &[u8; 32]) {
        self.key = key_mark(secrets);
        let mac = self.mac_parts(database, |parts| secrets.mac(MAC_PURPOSE, parts));
        self.mac = STANDARD.encode(mac);
    }

    /// Whether the manifest and the database with the hash `database` come
    /// from this instance and are unchanged.
    fn check(&self, secrets: &SecretKey, database: &[u8; 32]) -> anyhow::Result<()> {
        let mac = STANDARD.decode(&self.mac).map_err(invalid)?;
        if self.mac_parts(database, |parts| secrets.verify(MAC_PURPOSE, parts, &mac)) {
            return Ok(());
        }
        anyhow::ensure!(self.key == key_mark(secrets), Refused::OtherKey);
        tracing::warn!("backup not authentic: manifest or database changed");
        Err(Refused::Invalid.into())
    }
}

/// Packs `database` and `manifest` into `target` (mode 0600) and flushes the
/// file to disk; returns its size. The manifest gets the key fingerprint and
/// the MAC of `secrets`. Blocks.
pub fn write(
    database: &Path,
    manifest: &Manifest,
    secrets: &SecretKey,
    target: &Path,
) -> anyhow::Result<u64> {
    let mut manifest = manifest.clone();
    manifest.sign(secrets, &hash(File::open(database)?)?);
    let mut encoder = zstd::Encoder::new(private_file(target)?, LEVEL)?;
    // Checksum over the content: this way `read` notices any damaged spot.
    encoder.include_checksum(true)?;
    let mut tar = tar::Builder::new(encoder);
    let mtime = u64::try_from(Timestamp::now().as_second()).unwrap_or(0);
    let text = serde_json::to_vec_pretty(&manifest)?;
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
    let packed = file.metadata()?.len();
    // A backup that `read` would refuse must not look like a success.
    anyhow::ensure!(
        size <= limit(packed),
        "database ({size} bytes) packs to {packed} bytes, more than {MAX_RATIO}:1; \
         restoring this backup would be refused"
    );
    file.sync_all()?;
    Ok(packed)
}

/// How large the database of an archive of `packed` bytes may unpack.
fn limit(packed: u64) -> u64 {
    packed.saturating_mul(MAX_RATIO).max(MIN_LIMIT)
}

fn hash(mut data: impl Read) -> io::Result<[u8; 32]> {
    let mut hasher = Sha256::new();
    let mut chunk = vec![0; CHUNK];
    loop {
        match data.read(&mut chunk)? {
            0 => return Ok(hasher.finalize().into()),
            read => hasher.update(&chunk[..read]),
        }
    }
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

/// Packs the entries `(name, content)` as they are, without checks and without
/// MAC: for tests that build a file by hand, such as a forged backup.
#[doc(hidden)]
pub fn pack(path: &Path, entries: &[(&str, &[u8])]) -> anyhow::Result<()> {
    let encoder = zstd::Encoder::new(File::create(path)?, LEVEL)?;
    let mut tar = tar::Builder::new(encoder);
    for (name, data) in entries {
        append(&mut tar, name, *data, data.len() as u64, 0)?;
    }
    tar.into_inner()?.finish()?;
    Ok(())
}

/// Reads the whole archive (including the checksum at the end), unpacks the
/// database into `database` (mode 0600) and checks the MAC with `secrets`.
/// Whatever cannot be read, unpacks to more than the limit or does not carry
/// a valid MAC is [`Refused::Invalid`] (or [`Refused::OtherKey`],
/// [`Refused::Newer`], [`Refused::Older`]); an error while writing stays a
/// server error. After any error `database` is gone again. Blocks.
pub fn read(archive: &Path, database: &Path, secrets: &SecretKey) -> anyhow::Result<Manifest> {
    let file = File::open(archive)?;
    let limit = limit(file.metadata()?.len());
    read_limited(file, database, secrets, limit)
}

/// The unpacked stream, cut off at a budget: [`OVERHEAD`] plus the declared
/// size of the database once its entry comes. It applies before tar parses
/// anything, because tar reads extension members (long names) into memory
/// before an entry reaches [`read_limited`]; a small archive could otherwise
/// fill the memory with them.
struct Budgeted<R> {
    inner: R,
    left: Rc<Cell<u64>>,
}

impl<R: Read> Read for Budgeted<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let left = self.left.get();
        if left == 0 {
            // Tell the end of the stream from more than the budget.
            return match self.inner.read(&mut [0])? {
                0 => Ok(0),
                _ => Err(io::Error::other("backup unpacks to more than the limit")),
            };
        }
        let max = buf.len().min(usize::try_from(left).unwrap_or(usize::MAX));
        let read = self.inner.read(&mut buf[..max])?;
        self.left.set(left - read as u64);
        Ok(read)
    }
}

fn read_limited(
    archive: File,
    database: &Path,
    secrets: &SecretKey,
    limit: u64,
) -> anyhow::Result<Manifest> {
    let left = Rc::new(Cell::new(OVERHEAD));
    let decoder = zstd::Decoder::new(archive).map_err(invalid)?;
    let mut tar = tar::Archive::new(Budgeted {
        inner: decoder,
        left: Rc::clone(&left),
    });
    let (mut manifest, mut unpacked) = (None, None);
    for entry in tar.entries().map_err(invalid)? {
        let mut entry = entry.map_err(invalid)?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(invalid)?.into_owned();
        if path == Path::new(MANIFEST) && manifest.is_none() {
            let read = read_manifest(&mut entry)?;
            // Saves unpacking a database whose MAC cannot fit anyway.
            anyhow::ensure!(read.key == key_mark(secrets), Refused::OtherKey);
            manifest = Some(read);
        } else if path == Path::new(db::DB_FILE) && unpacked.is_none() {
            if entry.size() > limit {
                return Err(too_large(limit));
            }
            left.set(left.get().saturating_add(entry.size()));
            unpacked = Some(unpack(&mut entry, database, limit)?);
        }
    }
    // The entries end before the zstd frame does; the checksum comes after.
    io::copy(&mut tar.into_inner(), &mut io::sink()).map_err(invalid)?;
    let (Some(manifest), Some((partial, digest))) = (manifest, unpacked) else {
        return Err(Refused::Invalid.into());
    };
    manifest.check(secrets, &digest)?;
    partial.keep();
    Ok(manifest)
}

/// Only the version: whatever else another format changes, this program does
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
    anyhow::ensure!(format == FORMAT, Refused::Older);
    serde_json::from_slice(&text).map_err(invalid)
}

/// A file being unpacked; deleted again unless [`Self::keep`] is called.
struct Partial(Option<PathBuf>);

impl Partial {
    fn keep(mut self) {
        self.0 = None;
    }
}

impl Drop for Partial {
    fn drop(&mut self) {
        if let Some(path) = self.0.take()
            && let Err(error) = fs::remove_file(&path)
        {
            tracing::warn!("unpacked backup database not deleted: {error}");
        }
    }
}

/// Unpacks at most `limit` bytes and hashes them along the way. Copies in
/// chunks instead of `io::copy` to separate errors reading the archive from
/// errors writing (full disk).
fn unpack(
    entry: &mut tar::Entry<'_, impl Read>,
    database: &Path,
    limit: u64,
) -> anyhow::Result<(Partial, [u8; 32])> {
    // The header names the size up front; the count below does not rely on it.
    if entry.size() > limit {
        return Err(too_large(limit));
    }
    let mut file = private_file(database)?;
    let partial = Partial(Some(database.to_owned()));
    let (mut hasher, mut total) = (Sha256::new(), 0_u64);
    let mut chunk = vec![0; CHUNK];
    loop {
        let read = entry.read(&mut chunk).map_err(invalid)?;
        if read == 0 {
            return Ok((partial, hasher.finalize().into()));
        }
        total += read as u64;
        if total > limit {
            return Err(too_large(limit));
        }
        hasher.update(&chunk[..read]);
        file.write_all(&chunk[..read])?;
    }
}

fn too_large(limit: u64) -> anyhow::Error {
    tracing::warn!(limit, "backup database larger than the limit");
    Refused::Invalid.into()
}

fn invalid(error: impl std::fmt::Display) -> anyhow::Error {
    tracing::warn!("backup not readable: {error}");
    Refused::Invalid.into()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DATA: &[u8] = b"data";

    fn refused(result: anyhow::Result<Manifest>) -> Refused {
        *result.unwrap_err().downcast_ref::<Refused>().unwrap()
    }

    /// Packs `data` as database the regular way; returns the archive.
    fn packed(dir: &Path, secrets: &SecretKey, data: &[u8]) -> PathBuf {
        let database = dir.join("source");
        std::fs::write(&database, data).unwrap();
        let archive = dir.join("archive.tar.zst");
        let manifest = Manifest::new(Timestamp::UNIX_EPOCH, true, 16);
        write(&database, &manifest, secrets, &archive).unwrap();
        std::fs::remove_file(database).unwrap();
        archive
    }

    /// The signed manifest for the database `data`.
    fn signed(secrets: &SecretKey, data: &[u8]) -> Manifest {
        let tmp = tempfile::tempdir().unwrap();
        let archive = packed(tmp.path(), secrets, data);
        read(&archive, &tmp.path().join("target"), secrets).unwrap()
    }

    fn json(manifest: &Manifest) -> Vec<u8> {
        serde_json::to_vec(manifest).unwrap()
    }

    #[test]
    fn reads_what_it_wrote() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretKey::random().unwrap();
        let archive = packed(tmp.path(), &secrets, &[7; 100_000]);
        let database = tmp.path().join("target");

        let manifest = read(&archive, &database, &secrets).unwrap();

        assert_eq!(manifest.format, FORMAT);
        assert_eq!(manifest.schema, 16);
        assert!(manifest.auto);
        assert_eq!(manifest.key, key_mark(&secrets));
        assert_eq!(STANDARD.decode(&manifest.mac).unwrap().len(), 32);
        assert_eq!(std::fs::read(&database).unwrap(), vec![7; 100_000]);
    }

    #[cfg(unix)]
    #[test]
    fn files_stay_private() {
        use std::os::unix::fs::PermissionsExt as _;

        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretKey::random().unwrap();
        let archive = packed(tmp.path(), &secrets, DATA);
        let database = tmp.path().join("target");
        read(&archive, &database, &secrets).unwrap();

        for path in [archive, database] {
            let mode = std::fs::metadata(path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn notices_damage_anywhere_in_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretKey::random().unwrap();
        let archive = packed(tmp.path(), &secrets, &[7; 100_000]);
        let good = std::fs::read(&archive).unwrap();
        let target = tmp.path().join("target");

        // Truncated, even if only by the checksum at the end.
        for cut in [good.len() / 2, good.len() - 1] {
            std::fs::write(&archive, &good[..cut]).unwrap();
            let result = read(&archive, &target, &secrets);
            assert_eq!(refused(result), Refused::Invalid, "at {cut}");
            assert!(!target.exists(), "at {cut}");
        }
        // One bit flipped.
        let mut bad = good.clone();
        *bad.last_mut().unwrap() ^= 1;
        std::fs::write(&archive, &bad).unwrap();
        assert_eq!(refused(read(&archive, &target, &secrets)), Refused::Invalid);
        assert!(!target.exists());
    }

    #[test]
    fn needs_a_current_manifest_and_the_database() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretKey::random().unwrap();
        let path = tmp.path().join("archive.tar.zst");
        let target = tmp.path().join("target");
        let good = json(&signed(&secrets, DATA));

        for entries in [
            vec![(MANIFEST, good.as_slice())],
            vec![(db::DB_FILE, DATA)],
            vec![(MANIFEST, b"{".as_slice()), (db::DB_FILE, DATA)],
        ] {
            pack(&path, &entries).unwrap();
            assert_eq!(refused(read(&path, &target, &secrets)), Refused::Invalid);
            assert!(!target.exists());
        }
        // The same entries are fine.
        pack(&path, &[(MANIFEST, &good), (db::DB_FILE, DATA)]).unwrap();
        read(&path, &target, &secrets).unwrap();
    }

    #[test]
    fn a_newer_format_is_no_damage() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("archive.tar.zst");
        let manifest = br#"{ "format": 3, "barely": "known" }"#;
        pack(&path, &[(MANIFEST, manifest), (db::DB_FILE, DATA)]).unwrap();

        let secrets = SecretKey::random().unwrap();
        let result = read(&path, &tmp.path().join("target"), &secrets);
        assert_eq!(refused(result), Refused::Newer);
    }

    /// Format 1 had no MAC: nothing shows where its database came from.
    #[test]
    fn the_format_without_mac_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretKey::random().unwrap();
        let path = tmp.path().join("archive.tar.zst");
        let manifest = serde_json::json!({
            "format": 1,
            "version": "0.0.0",
            "schema": 1,
            "created_at": "2026-11-04T00:30:00Z",
            "auto": true,
            "key": key_mark(&secrets),
        });
        let manifest = serde_json::to_vec(&manifest).unwrap();
        pack(&path, &[(MANIFEST, &manifest), (db::DB_FILE, DATA)]).unwrap();
        let target = tmp.path().join("target");

        assert_eq!(refused(read(&path, &target, &secrets)), Refused::Older);
        assert!(!target.exists());
    }

    /// The manifest of a real backup does not fit another database, nor any
    /// changed field, nor a field shifted into the next one.
    #[test]
    fn the_mac_covers_database_and_every_field() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretKey::random().unwrap();
        let path = tmp.path().join("archive.tar.zst");
        let target = tmp.path().join("target");
        let good = signed(&secrets, DATA);
        let forged = |manifest: &Manifest, data: &[u8]| {
            pack(&path, &[(MANIFEST, &json(manifest)), (db::DB_FILE, data)]).unwrap();
            let result = read(&path, &target, &secrets);
            assert!(!target.exists());
            refused(result)
        };

        assert_eq!(forged(&good, b"other data"), Refused::Invalid);
        assert_eq!(forged(&good, b""), Refused::Invalid);
        let changes: [fn(&mut Manifest); 6] = [
            |m| m.version.push('1'),
            |m| m.schema += 1,
            |m| m.created_at = "2026-11-04T00:30:00Z".to_owned(),
            |m| m.auto = !m.auto,
            |m| m.mac = String::new(),
            |m| m.mac = "not base64".to_owned(),
        ];
        for change in changes {
            let mut manifest = good.clone();
            change(&mut manifest);
            assert_eq!(forged(&manifest, DATA), Refused::Invalid, "{manifest:?}");
        }
        let mut shifted = good.clone();
        let last = shifted.version.pop().unwrap();
        shifted.created_at.insert(0, last);
        assert_eq!(forged(&shifted, DATA), Refused::Invalid);
    }

    #[test]
    fn another_key_is_no_damage() {
        let tmp = tempfile::tempdir().unwrap();
        let archive = packed(tmp.path(), &SecretKey::random().unwrap(), DATA);
        let target = tmp.path().join("target");

        let result = read(&archive, &target, &SecretKey::random().unwrap());

        assert_eq!(refused(result), Refused::OtherKey);
        assert!(!target.exists());
    }

    #[test]
    fn unpacking_stops_at_the_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretKey::random().unwrap();
        let archive = packed(tmp.path(), &secrets, &[0; 10_000]);
        let target = tmp.path().join("target");
        let read = |limit| read_limited(File::open(&archive).unwrap(), &target, &secrets, limit);

        assert_eq!(refused(read(9_999)), Refused::Invalid);
        assert!(!target.exists());
        read(10_000).unwrap();
        assert_eq!(std::fs::metadata(&target).unwrap().len(), 10_000);
    }

    #[test]
    fn the_stream_stops_at_its_budget() {
        let budgeted = |data: &'static [u8], budget| Budgeted {
            inner: data,
            left: Rc::new(Cell::new(budget)),
        };
        let mut all = Vec::new();
        budgeted(b"12345", 5).read_to_end(&mut all).unwrap();
        assert_eq!(all, b"12345");
        let mut cut = Vec::new();
        let error = budgeted(b"123456", 5).read_to_end(&mut cut).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert_eq!(cut, b"12345");
    }

    /// tar reads a long name into memory before the entry comes: the budget
    /// applies to it too.
    #[test]
    fn a_huge_long_name_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretKey::random().unwrap();
        let path = tmp.path().join("archive.tar.zst");
        let encoder = zstd::Encoder::new(File::create(&path).unwrap(), LEVEL).unwrap();
        let mut tar = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::GNULongName);
        header.set_size(OVERHEAD + 1);
        header.set_cksum();
        tar.append(&header, io::repeat(b'a').take(OVERHEAD + 1))
            .unwrap();
        let good = json(&signed(&secrets, DATA));
        append(&mut tar, MANIFEST, good.as_slice(), good.len() as u64, 0).unwrap();
        tar.into_inner().unwrap().finish().unwrap();
        let target = tmp.path().join("target");
        assert_eq!(refused(read(&path, &target, &secrets)), Refused::Invalid);
        assert!(!target.exists());
    }

    /// A database of equal bytes above [`MIN_LIMIT`] packs far beyond
    /// [`MAX_RATIO`]: `write` fails instead of leaving a backup `read` refuses.
    #[test]
    fn writing_refuses_what_reading_would_refuse() {
        assert_eq!(limit(MIN_LIMIT), MIN_LIMIT * MAX_RATIO);
        assert_eq!(limit(u64::MAX), u64::MAX);
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretKey::random().unwrap();
        let database = tmp.path().join("database");
        File::create(&database)
            .unwrap()
            .set_len(MIN_LIMIT + 1)
            .unwrap();
        let manifest = Manifest::new(Timestamp::now(), false, 1);
        let target = tmp.path().join("archive.tar.zst");
        let error = write(&database, &manifest, &secrets, &target).unwrap_err();
        assert!(error.to_string().contains("would be refused"), "{error:#}");
    }

    #[test]
    fn writes_nothing_outside_the_target() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = SecretKey::random().unwrap();
        let path = tmp.path().join("archive.tar.zst");
        let good = json(&signed(&secrets, DATA));
        pack(
            &path,
            &[
                ("other/file", b"foreign"),
                (MANIFEST, good.as_slice()),
                (db::DB_FILE, DATA),
                ("second", b"foreign"),
            ],
        )
        .unwrap();
        let unpacked = tmp.path().join("empty");
        std::fs::create_dir(&unpacked).unwrap();

        read(&path, &unpacked.join("target"), &secrets).unwrap();

        let names: Vec<_> = std::fs::read_dir(&unpacked)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["target"]);
    }
}
