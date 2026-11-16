//! Encryption of a push message per RFC 8291 ("Message Encryption for Web
//! Push") in the content coding `aes128gcm` from RFC 8188: one record, keys
//! from ECDH P-256 with the browser's public key and its authentication
//! secret. The tests check against the example from RFC 8291, Appendix A.

use anyhow::{Context as _, anyhow, ensure};
use ring::{
    aead, agreement, hkdf,
    rand::{SecureRandom as _, SystemRandom},
};

/// Record size (`rs`); every message fits into one.
const RECORD_SIZE: u32 = 4096;
/// Length of an uncompressed P-256 key.
pub const PUBLIC_KEY_LEN: usize = 65;
/// Length of the authentication secret.
pub const AUTH_LEN: usize = 16;
/// Header: salt (16), `rs` (4), `idlen` (1), `keyid` = sender's key.
const HEADER_LEN: usize = 16 + 4 + 1 + PUBLIC_KEY_LEN;
const TAG_LEN: usize = 16;
/// Largest plaintext: push services accept at least 4096 bytes (RFC 8030,
/// section 7.2), minus header, delimiter byte and tag.
pub const MAX_PLAINTEXT: usize = 4096 - HEADER_LEN - 1 - TAG_LEN;

/// Key and nonce of the record.
#[derive(Debug, PartialEq, Eq)]
struct Keys {
    cek: [u8; 16],
    nonce: [u8; 12],
}

/// Encrypts `plaintext` for the browser with `ua_public` and `auth`; the
/// result is the body of the request to the push service.
pub fn encrypt(ua_public: &[u8], auth: &[u8], plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
    ensure!(
        plaintext.len() <= MAX_PLAINTEXT,
        "push message too large ({} bytes)",
        plaintext.len()
    );
    let rng = SystemRandom::new();
    let mut salt = [0; 16];
    rng.fill(&mut salt)
        .map_err(|_| anyhow!("no randomness available"))?;
    let private = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng)
        .map_err(|_| anyhow!("push key not generated"))?;
    let public = private
        .compute_public_key()
        .map_err(|_| anyhow!("push key not generated"))?;
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, ua_public);
    let secret = agreement::agree_ephemeral(private, &peer, <[u8]>::to_vec)
        .map_err(|_| anyhow!("browser key invalid"))?;
    let keys = derive(&secret, auth, ua_public, public.as_ref(), &salt)?;
    seal(&keys, &salt, public.as_ref(), plaintext)
}

/// Whether `key` is a valid (uncompressed) public P-256 key: a key agreement
/// with it succeeds.
pub fn valid_public_key(key: &[u8]) -> bool {
    if key.len() != PUBLIC_KEY_LEN || key[0] != 4 {
        return false;
    }
    let rng = SystemRandom::new();
    let Ok(private) = agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng) else {
        return false;
    };
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, key);
    agreement::agree_ephemeral(private, &peer, |_| ()).is_ok()
}

/// Counterpart of [`encrypt`] on the browser side (for tests): decrypts `body`
/// with the shared secret `ecdh` from its private key and [`sender_key`].
pub fn decrypt(ecdh: &[u8], auth: &[u8], ua_public: &[u8], body: &[u8]) -> anyhow::Result<Vec<u8>> {
    let as_public = sender_key(body).context("push message header invalid")?;
    ensure!(body.len() > HEADER_LEN + TAG_LEN, "push message too short");
    let keys = derive(ecdh, auth, ua_public, as_public, &body[..16])?;
    let mut record = body[HEADER_LEN..].to_vec();
    let plain = aes(&keys.cek)?
        .open_in_place(
            aead::Nonce::assume_unique_for_key(keys.nonce),
            aead::Aad::empty(),
            &mut record,
        )
        .map_err(|_| anyhow!("push message cannot be decrypted"))?;
    // After the text the delimiter byte 2 of the last record, then zeros.
    let end = plain
        .iter()
        .rposition(|&b| b != 0)
        .context("delimiter byte missing")?;
    ensure!(plain[end] == 2, "delimiter byte missing");
    Ok(plain[..end].to_vec())
}

/// Public key of the sender (`keyid`) from the header.
pub fn sender_key(body: &[u8]) -> Option<&[u8]> {
    let id_len = usize::from(*body.get(20)?);
    (id_len == PUBLIC_KEY_LEN).then(|| body.get(21..21 + id_len))?
}

/// RFC 8291 › 3.3 and 3.4: `IKM` from ECDH and `auth`, from that with the
/// salt the key and nonce of the record (RFC 8188 › 2.2, 2.3).
fn derive(
    ecdh: &[u8],
    auth: &[u8],
    ua_public: &[u8],
    as_public: &[u8],
    salt: &[u8],
) -> anyhow::Result<Keys> {
    let key_info: [&[u8]; 3] = [b"WebPush: info\0", ua_public, as_public];
    let prk_key = hkdf::Salt::new(hkdf::HKDF_SHA256, auth).extract(ecdh);
    let ikm: [u8; 32] = expand(&prk_key, &key_info)?;
    let prk = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(&ikm);
    Ok(Keys {
        cek: expand(&prk, &[b"Content-Encoding: aes128gcm\0"])?,
        nonce: expand(&prk, &[b"Content-Encoding: nonce\0"])?,
    })
}

/// HKDF-Expand with `N` bytes.
fn expand<const N: usize>(prk: &hkdf::Prk, info: &[&[u8]]) -> anyhow::Result<[u8; N]> {
    struct Len(usize);
    impl hkdf::KeyType for Len {
        fn len(&self) -> usize {
            self.0
        }
    }
    let mut out = [0; N];
    prk.expand(info, Len(N))
        .and_then(|okm| okm.fill(&mut out))
        .map_err(|_| anyhow!("HKDF failed"))?;
    Ok(out)
}

fn aes(cek: &[u8; 16]) -> anyhow::Result<aead::LessSafeKey> {
    let key = aead::UnboundKey::new(&aead::AES_128_GCM, cek)
        .map_err(|_| anyhow!("AES-GCM key invalid"))?;
    Ok(aead::LessSafeKey::new(key))
}

/// Header and the single record: plaintext, delimiter byte 2, tag.
fn seal(keys: &Keys, salt: &[u8], as_public: &[u8], plaintext: &[u8]) -> anyhow::Result<Vec<u8>> {
    let mut body = Vec::with_capacity(HEADER_LEN + plaintext.len() + 1 + TAG_LEN);
    body.extend_from_slice(salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(u8::try_from(as_public.len())?);
    body.extend_from_slice(as_public);
    let mut record = Vec::with_capacity(plaintext.len() + 1 + TAG_LEN);
    record.extend_from_slice(plaintext);
    record.push(2);
    aes(&keys.cek)?
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(keys.nonce),
            aead::Aad::empty(),
            &mut record,
        )
        .map_err(|_| anyhow!("push message not encrypted"))?;
    body.extend_from_slice(&record);
    Ok(body)
}

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

    use super::*;

    fn b64(text: &str) -> Vec<u8> {
        URL_SAFE_NO_PAD.decode(text).unwrap()
    }

    // RFC 8291, Appendix A.
    const PLAINTEXT: &str = "When I grow up, I want to be a watermelon";
    const AS_PUBLIC: &str =
        "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
    const UA_PUBLIC: &str =
        "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
    const SALT: &str = "DGv6ra1nlYgDCS1FRnbzlw";
    const AUTH: &str = "BTBZMqHH6r4Tts7J_aSIgg";
    const ECDH: &str = "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs";
    const IKM: &str = "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg";
    const CEK: &str = "oIhVW04MRdy2XN9CiKLxTg";
    const NONCE: &str = "4h_95klXJ5E_qnoN";
    const BODY: &str = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml\
        mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT\
        pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

    #[test]
    fn matches_the_example_of_rfc_8291() {
        let (ua, as_) = (b64(UA_PUBLIC), b64(AS_PUBLIC));
        let prk_key = hkdf::Salt::new(hkdf::HKDF_SHA256, &b64(AUTH)).extract(&b64(ECDH));
        let ikm: [u8; 32] = expand(&prk_key, &[b"WebPush: info\0", &ua, &as_]).unwrap();
        assert_eq!(ikm.to_vec(), b64(IKM));
        let keys = derive(&b64(ECDH), &b64(AUTH), &ua, &as_, &b64(SALT)).unwrap();
        assert_eq!(keys.cek.to_vec(), b64(CEK));
        assert_eq!(keys.nonce.to_vec(), b64(NONCE));
        let body = seal(&keys, &b64(SALT), &as_, PLAINTEXT.as_bytes()).unwrap();
        assert_eq!(URL_SAFE_NO_PAD.encode(&body), BODY);
        assert_eq!(sender_key(&body), Some(as_.as_slice()));
        let plain = decrypt(&b64(ECDH), &b64(AUTH), &ua, &body).unwrap();
        assert_eq!(plain, PLAINTEXT.as_bytes());
    }

    #[test]
    fn round_trip_with_a_fresh_browser_key() {
        let rng = SystemRandom::new();
        let browser =
            agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let ua = browser.compute_public_key().unwrap().as_ref().to_vec();
        let auth = [9; AUTH_LEN];
        let body = encrypt(&ua, &auth, b"Hello").unwrap();
        assert_eq!(body.len(), HEADER_LEN + 5 + 1 + TAG_LEN);
        let peer = agreement::UnparsedPublicKey::new(
            &agreement::ECDH_P256,
            sender_key(&body).unwrap().to_vec(),
        );
        let ecdh = agreement::agree_ephemeral(browser, &peer, <[u8]>::to_vec).unwrap();
        assert_eq!(decrypt(&ecdh, &auth, &ua, &body).unwrap(), b"Hello");
        assert!(decrypt(&[0; 32], &auth, &ua, &body).is_err());
    }

    #[test]
    fn valid_public_keys() {
        assert!(valid_public_key(&b64(UA_PUBLIC)));
        assert!(!valid_public_key(&[4; PUBLIC_KEY_LEN]));
        assert!(!valid_public_key(&b64(UA_PUBLIC)[1..]));
        let mut compressed = b64(UA_PUBLIC);
        compressed[0] = 3;
        assert!(!valid_public_key(&compressed));
    }

    #[test]
    fn rejects_bad_keys_and_too_long_texts() {
        assert!(encrypt(&[4; PUBLIC_KEY_LEN], &[0; AUTH_LEN], b"x").is_err());
        let rng = SystemRandom::new();
        let browser =
            agreement::EphemeralPrivateKey::generate(&agreement::ECDH_P256, &rng).unwrap();
        let ua = browser.compute_public_key().unwrap().as_ref().to_vec();
        assert!(encrypt(&ua, &[0; AUTH_LEN], &[b'a'; MAX_PLAINTEXT]).is_ok());
        assert!(encrypt(&ua, &[0; AUTH_LEN], &[b'a'; MAX_PLAINTEXT + 1]).is_err());
        assert_eq!(
            encrypt(&ua, &[0; AUTH_LEN], &[b'a'; MAX_PLAINTEXT])
                .unwrap()
                .len(),
            4096
        );
    }
}
