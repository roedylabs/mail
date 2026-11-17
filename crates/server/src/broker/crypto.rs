//! Encryption of secrets in the database: XChaCha20-Poly1305 with a 256-bit
//! key of the instance.
//!
//! The key comes from `ROEDY_SECRET_KEY`, from the file in
//! `ROEDY_SECRET_KEY_FILE` or – if both are missing – from
//! `<ROEDY_DATA_DIR>/secret.key`, which the first start creates with 0600. Format
//! either 64 hex characters (`openssl rand -hex 32`) or Base64
//! (`openssl rand -base64 32`).
//!
//! An encrypted value is `[version 1][nonce, 24 bytes][ciphertext + tag]`.
//! The additional data (AAD) binds it to purpose and row
//! (`servers.oauth_client_secret` + ID): if someone copies the value into another
//! row or column, it cannot be decrypted there.

use std::{
    fmt::{self, Write as _},
    fs::OpenOptions,
    io::{ErrorKind, Write as _},
    path::{Path, PathBuf},
};

use anyhow::{Context as _, anyhow, bail, ensure};
use base64::Engine as _;
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead as _, Payload},
};
// The same trait as for XChaCha20-Poly1305 (`crypto-common`).
use hmac::{Hmac, KeyInit, Mac as _};
use sha2::Sha256;

use crate::{config::Config, random};

/// File name in the data directory when neither `ROEDY_SECRET_KEY` nor
/// `ROEDY_SECRET_KEY_FILE` is set. Never belongs in a backup.
pub const KEY_FILE: &str = "secret.key";

const KEY_BYTES: usize = 32;
const NONCE_BYTES: usize = 24;
const VERSION: u8 = 1;
const FORMAT_HINT: &str = "expected 32 bytes as 64 hex characters (\"openssl rand -hex 32\") or Base64 \
     (\"openssl rand -base64 32\")";

/// Where the key comes from (for the startup message, never the key itself).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeySource {
    /// `ROEDY_SECRET_KEY`
    Env,
    /// `ROEDY_SECRET_KEY_FILE`
    File(PathBuf),
    /// `<ROEDY_DATA_DIR>/secret.key`; `created` if this start created it.
    DataDir { path: PathBuf, created: bool },
}

impl fmt::Display for KeySource {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Env => f.write_str("ROEDY_SECRET_KEY"),
            Self::File(path) => write!(f, "ROEDY_SECRET_KEY_FILE ({})", path.display()),
            Self::DataDir { path, created } => {
                write!(f, "{}", path.display())?;
                if *created {
                    f.write_str(" (newly created)")?;
                }
                Ok(())
            }
        }
    }
}

/// Key of the instance. `Debug` does not show it.
#[derive(Clone)]
pub struct SecretKey {
    cipher: XChaCha20Poly1305,
    /// For [`Self::mac`], derived from the key: the same key is not
    /// used for two schemes.
    mac: [u8; KEY_BYTES],
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretKey(…)")
    }
}

impl SecretKey {
    /// Loads the key according to the configuration; creates
    /// `secret.key` in the data directory if needed. Blocks (file access).
    pub fn load(config: &Config) -> anyhow::Result<(Self, KeySource)> {
        match (&config.secret_key, &config.secret_key_file) {
            (Some(_), Some(_)) => bail!(
                "ROEDY_SECRET_KEY and ROEDY_SECRET_KEY_FILE are both set – please use only one \
                 of the two variables"
            ),
            (Some(value), None) => {
                let key = Self::parse(value.expose()).context("ROEDY_SECRET_KEY")?;
                Ok((key, KeySource::Env))
            }
            (None, Some(path)) => {
                let text = std::fs::read_to_string(path).with_context(|| {
                    format!("ROEDY_SECRET_KEY_FILE: {} not readable", path.display())
                })?;
                let key = Self::parse(&text)
                    .with_context(|| format!("ROEDY_SECRET_KEY_FILE ({})", path.display()))?;
                Ok((key, KeySource::File(path.clone())))
            }
            (None, None) => {
                let path = config.data_dir.join(KEY_FILE);
                let (key, created) = Self::from_data_dir(&path)?;
                Ok((key, KeySource::DataDir { path, created }))
            }
        }
    }

    /// Random key, e.g. for tests.
    pub fn random() -> anyhow::Result<Self> {
        Ok(Self::from_bytes(&random::bytes::<KEY_BYTES>()?))
    }

    fn from_bytes(bytes: &[u8; KEY_BYTES]) -> Self {
        Self {
            cipher: XChaCha20Poly1305::new(bytes.into()),
            mac: hmac(bytes, &[b"roedy-mail mac 1"]),
        }
    }

    /// HMAC-SHA-256 over `parts` for `purpose`, e.g. the ID of a
    /// known device: without the key it cannot be recovered from a
    /// copy of the database by trial.
    pub fn mac(&self, purpose: &str, parts: &[&[u8]]) -> [u8; 32] {
        self.mac_state(purpose, parts)
            .finalize()
            .into_bytes()
            .into()
    }

    /// Whether `tag` is [`Self::mac`] over `parts` for `purpose`; compares in
    /// constant time.
    pub fn verify(&self, purpose: &str, parts: &[&[u8]], tag: &[u8]) -> bool {
        self.mac_state(purpose, parts).verify_slice(tag).is_ok()
    }

    fn mac_state(&self, purpose: &str, parts: &[&[u8]]) -> Hmac<Sha256> {
        let mut all = Vec::with_capacity(parts.len() + 1);
        all.push(purpose.as_bytes());
        all.extend_from_slice(parts);
        hmac_state(&self.mac, &all)
    }

    /// 64 hex characters or Base64 (with or without padding) for 32 bytes;
    /// whitespace at the edges (line end of a file) does not count.
    fn parse(text: &str) -> anyhow::Result<Self> {
        let text = text.trim();
        let bytes = if text.len() == 2 * KEY_BYTES && text.bytes().all(|b| b.is_ascii_hexdigit()) {
            (0..KEY_BYTES)
                .map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16))
                .collect::<Result<Vec<_>, _>>()?
        } else {
            base64::engine::general_purpose::STANDARD
                .decode(text)
                .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(text))
                .map_err(|_| anyhow!("{FORMAT_HINT}"))?
        };
        let bytes: [u8; KEY_BYTES] = bytes.try_into().map_err(|_| anyhow!("{FORMAT_HINT}"))?;
        Ok(Self::from_bytes(&bytes))
    }

    /// Reads `secret.key` or creates the file with 0600. An existing,
    /// unreadable file is never overwritten – otherwise all values encrypted
    /// with it would be lost.
    fn from_data_dir(path: &Path) -> anyhow::Result<(Self, bool)> {
        if let Some(key) = Self::read_key_file(path)? {
            return Ok((key, false));
        }
        let bytes = random::bytes::<KEY_BYTES>()?;
        let mut text = String::with_capacity(2 * KEY_BYTES + 1);
        for b in bytes {
            let _ = write!(text, "{b:02x}");
        }
        text.push('\n');
        match write_new_private(path, text.as_bytes()) {
            Ok(()) => Ok((Self::from_bytes(&bytes), true)),
            // A second process was faster: its key applies.
            Err(e) if e.kind() == ErrorKind::AlreadyExists => Self::read_key_file(path)?
                .map(|key| (key, false))
                .ok_or_else(|| anyhow!("key file {} disappeared", path.display())),
            Err(e) => {
                Err(e).with_context(|| format!("key file {} cannot be created", path.display()))
            }
        }
    }

    /// `None` if the file is missing.
    fn read_key_file(path: &Path) -> anyhow::Result<Option<Self>> {
        match std::fs::read_to_string(path) {
            Ok(text) => {
                warn_if_shared(path);
                let key = Self::parse(&text)
                    .with_context(|| format!("key file {} invalid", path.display()))?;
                Ok(Some(key))
            }
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("key file {} not readable", path.display())),
        }
    }

    /// Encrypts `plaintext` for `purpose` (e.g.
    /// `servers.oauth_client_secret`) and the row `row`.
    pub fn seal(&self, purpose: &str, row: &str, plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
        let nonce = random::bytes::<NONCE_BYTES>()?;
        let aad = aad(purpose, row);
        let ciphertext = self
            .cipher
            .encrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| anyhow!("encryption failed"))?;
        let mut sealed = Vec::with_capacity(1 + NONCE_BYTES + ciphertext.len());
        sealed.push(VERSION);
        sealed.extend_from_slice(&nonce);
        sealed.extend_from_slice(&ciphertext);
        Ok(sealed)
    }

    /// Decrypts a value from [`Self::seal`] with the same purpose and
    /// the same row.
    pub fn open(&self, purpose: &str, row: &str, sealed: &[u8]) -> anyhow::Result<Vec<u8>> {
        ensure!(
            sealed.len() > 1 + NONCE_BYTES && sealed[0] == VERSION,
            "{purpose}: unknown format"
        );
        let nonce: [u8; NONCE_BYTES] = sealed[1..=NONCE_BYTES].try_into()?;
        let aad = aad(purpose, row);
        self.cipher
            .decrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: &sealed[1 + NONCE_BYTES..],
                    aad: &aad,
                },
            )
            .map_err(|_| {
                anyhow!(
                    "{purpose}: cannot be decrypted – do ROEDY_SECRET_KEY or secret.key \
                     match this database?"
                )
            })
    }
}

fn aad(purpose: &str, row: &str) -> Vec<u8> {
    [purpose.as_bytes(), b"\0", row.as_bytes()].concat()
}

/// HMAC-SHA-256; parts prefixed with their length so that "ab" + "c" does not
/// equal "a" + "bc".
fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    hmac_state(key, parts).finalize().into_bytes().into()
}

/// Each part with its length in front, so that no part can shift into the
/// next one.
fn hmac_state(key: &[u8], parts: &[&[u8]]) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any length");
    for part in parts {
        mac.update(&u64::try_from(part.len()).unwrap_or(u64::MAX).to_be_bytes());
        mac.update(part);
    }
    mac
}

fn write_new_private(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(path)?;
    let written = file.write_all(contents).and_then(|()| file.sync_all());
    if written.is_err() {
        // A half-written file would prevent every further start.
        let _ = std::fs::remove_file(path);
        return written;
    }
    // Also persist the directory entry: if it were lost in a power failure,
    // the values already encrypted with it would be unreadable.
    #[cfg(unix)]
    {
        let dir = path
            .parent()
            .filter(|dir| !dir.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        if let Err(error) = std::fs::File::open(dir).and_then(|dir| dir.sync_all()) {
            tracing::warn!(dir = %dir.display(), "directory not synced: {error}");
        }
    }
    Ok(())
}

/// Warns if others than the owner may read the key file.
fn warn_if_shared(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if let Ok(meta) = std::fs::metadata(path)
            && meta.permissions().mode() & 0o077 != 0
        {
            tracing::warn!(
                path = %path.display(),
                "key file is readable by others; recommended: chmod 600"
            );
        }
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Secret;

    const HEX: &str = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

    fn config(dir: &Path) -> Config {
        Config {
            data_dir: dir.to_path_buf(),
            ..Config::default()
        }
    }

    #[test]
    fn mac_depends_on_key_purpose_and_parts() {
        let key = SecretKey::random().unwrap();
        let other = SecretKey::random().unwrap();
        let a = key.mac("device", &[b"ab", b"c"]);
        assert_eq!(a, key.mac("device", &[b"ab", b"c"]));
        assert_ne!(a, key.mac("device", &[b"a", b"bc"]));
        assert_ne!(a, key.mac("other", &[b"ab", b"c"]));
        assert_ne!(a, other.mac("device", &[b"ab", b"c"]));
    }

    #[test]
    fn verify_accepts_only_the_exact_mac() {
        let key = SecretKey::random().unwrap();
        let tag = key.mac("device", &[b"ab", b"c"]);
        assert!(key.verify("device", &[b"ab", b"c"], &tag));
        assert!(!key.verify("device", &[b"a", b"bc"], &tag));
        assert!(!key.verify("other", &[b"ab", b"c"], &tag));
        assert!(!key.verify("device", &[b"ab", b"c"], &tag[..31]));
        assert!(!key.verify("device", &[b"ab", b"c"], &[]));
        let other = SecretKey::random().unwrap();
        assert!(!other.verify("device", &[b"ab", b"c"], &tag));
    }

    #[test]
    fn roundtrip_binds_purpose_and_row() {
        let key = SecretKey::random().unwrap();
        let sealed = key.seal("test.secret", "row1", b"secret").unwrap();
        assert_eq!(sealed[0], VERSION);
        assert_eq!(sealed.len(), 1 + NONCE_BYTES + 6 + 16);
        assert_eq!(key.open("test.secret", "row1", &sealed).unwrap(), b"secret");
        assert!(key.open("test.secret", "row2", &sealed).is_err());
        assert!(key.open("test.other", "row1", &sealed).is_err());
        assert!(
            SecretKey::random()
                .unwrap()
                .open("test.secret", "row1", &sealed)
                .is_err()
        );

        // Every encryption with a new nonce.
        assert_ne!(sealed, key.seal("test.secret", "row1", b"secret").unwrap());

        let mut broken = sealed.clone();
        *broken.last_mut().unwrap() ^= 1;
        assert!(key.open("test.secret", "row1", &broken).is_err());
        assert!(key.open("test.secret", "row1", &sealed[..10]).is_err());
        broken = sealed;
        broken[0] = 2;
        assert!(key.open("test.secret", "row1", &broken).is_err());
    }

    #[test]
    fn parses_hex_and_base64() {
        let hex = SecretKey::parse(HEX).unwrap();
        let sealed = hex.seal("p", "r", b"x").unwrap();
        let b64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
        assert_eq!(
            SecretKey::parse(b64)
                .unwrap()
                .open("p", "r", &sealed)
                .unwrap(),
            b"x"
        );
        let no_pad = b64.trim_end_matches('=');
        assert_eq!(
            SecretKey::parse(no_pad)
                .unwrap()
                .open("p", "r", &sealed)
                .unwrap(),
            b"x"
        );
        let upper = format!("  {}\n", HEX.to_uppercase());
        assert_eq!(
            SecretKey::parse(&upper)
                .unwrap()
                .open("p", "r", &sealed)
                .unwrap(),
            b"x"
        );

        for bad in [
            "",
            "abc",
            &HEX[..62],
            &format!("{HEX}00"),
            "AAEC",
            "not a key",
        ] {
            let err = SecretKey::parse(bad).unwrap_err().to_string();
            assert!(err.contains("64 hex characters"), "{bad}: {err}");
        }
    }

    #[test]
    fn creates_private_key_file_once() {
        let tmp = tempfile::tempdir().unwrap();
        let (key, source) = SecretKey::load(&config(tmp.path())).unwrap();
        let path = tmp.path().join(KEY_FILE);
        assert_eq!(
            source,
            KeySource::DataDir {
                path: path.clone(),
                created: true
            }
        );
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.len(), 65, "{text:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        // A second start takes the same key.
        let sealed = key.seal("p", "r", b"stays").unwrap();
        let (again, source) = SecretKey::load(&config(tmp.path())).unwrap();
        assert_eq!(
            source,
            KeySource::DataDir {
                path,
                created: false
            }
        );
        assert_eq!(again.open("p", "r", &sealed).unwrap(), b"stays");
    }

    #[test]
    fn never_overwrites_invalid_key_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join(KEY_FILE);
        std::fs::write(&path, "broken").unwrap();
        let err = format!("{:#}", SecretKey::load(&config(tmp.path())).unwrap_err());
        assert!(err.contains("invalid"), "{err}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "broken");
    }

    #[test]
    fn reads_environment_and_file() {
        let tmp = tempfile::tempdir().unwrap();
        let mut config = config(tmp.path());
        config.secret_key = Some(Secret::new(HEX));
        let (env_key, source) = SecretKey::load(&config).unwrap();
        assert_eq!(source, KeySource::Env);
        assert!(!tmp.path().join(KEY_FILE).exists(), "no file needed");

        let file = tmp.path().join("docker-secret");
        std::fs::write(&file, format!("{HEX}\n")).unwrap();
        config.secret_key_file = Some(file.clone());
        let err = SecretKey::load(&config).unwrap_err().to_string();
        assert!(err.contains("both set"), "{err}");

        config.secret_key = None;
        let (file_key, source) = SecretKey::load(&config).unwrap();
        assert_eq!(source, KeySource::File(file));
        let sealed = env_key.seal("p", "r", b"x").unwrap();
        assert_eq!(file_key.open("p", "r", &sealed).unwrap(), b"x");

        config.secret_key_file = Some(tmp.path().join("missing"));
        let err = SecretKey::load(&config).unwrap_err().to_string();
        assert!(err.contains("ROEDY_SECRET_KEY_FILE"), "{err}");

        config.secret_key_file = None;
        config.secret_key = Some(Secret::new("too short"));
        let err = format!("{:#}", SecretKey::load(&config).unwrap_err());
        assert!(err.starts_with("ROEDY_SECRET_KEY: "), "{err}");
    }

    #[test]
    fn debug_hides_key() {
        assert_eq!(
            format!("{:?}", SecretKey::parse(HEX).unwrap()),
            "SecretKey(…)"
        );
    }
}
