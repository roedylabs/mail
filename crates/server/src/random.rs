//! Randomness from the operating system (`getrandom`) for tokens, IDs and salts.

use anyhow::anyhow;

/// `N` random bytes.
pub fn bytes<const N: usize>() -> anyhow::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|e| anyhow!("random source unavailable: {e}"))?;
    Ok(bytes)
}
