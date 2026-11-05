//! Optional signature check for the organizations file.
//!
//! When `KORDI_ORGANIZATIONS_SIGNING_KEY` holds an Ed25519 public key
//! (standard base64 of its 32 bytes), the file must have a detached signature
//! next to it, `<file>.sig`, holding the standard base64 Ed25519 signature of
//! the file's exact bytes. An unsigned or badly signed file is refused: at
//! startup the server does not start, and a reload keeps the previous
//! configuration. Without the key, files are read as before.

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};

use super::config::FILE_ENV;

pub const SIGNING_KEY_ENV: &str = "KORDI_ORGANIZATIONS_SIGNING_KEY";
/// The signature file is the organizations file path with this suffix.
pub const SIGNATURE_SUFFIX: &str = ".sig";
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_SIGNATURE_BYTES: u64 = 1024;

/// The signing key from the environment. A set but invalid key is an error,
/// so a typo never turns the check off.
pub fn signing_key_from_env() -> Result<Option<VerifyingKey>, String> {
    parse_signing_key(std::env::var(SIGNING_KEY_ENV).ok().as_deref())
}

pub fn parse_signing_key(value: Option<&str>) -> Result<Option<VerifyingKey>, String> {
    let Some(value) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    let invalid =
        || format!("{SIGNING_KEY_ENV} must be the base64 of a 32-byte Ed25519 public key");
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| invalid())?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| invalid())?;
    VerifyingKey::from_bytes(&bytes)
        .map(Some)
        .map_err(|_| invalid())
}

pub fn signature_path(path: &str) -> String {
    format!("{path}{SIGNATURE_SUFFIX}")
}

/// Reads the organizations file at `path`, checking its signature when
/// `key` is set. Errors never contain file contents.
pub fn read_file(path: &str, key: Option<&VerifyingKey>) -> Result<String, String> {
    let bytes = read_bounded(path, MAX_FILE_BYTES)
        .map_err(|error| format!("{FILE_ENV}: cannot read the file: {error}"))?;
    if let Some(key) = key {
        let signature = read_bounded(&signature_path(path), MAX_SIGNATURE_BYTES).map_err(|_| {
            format!("{FILE_ENV}: the file is not signed ({SIGNING_KEY_ENV} is set)")
        })?;
        verify(&bytes, &signature, key)?;
    }
    String::from_utf8(bytes).map_err(|_| format!("{FILE_ENV}: the file is not UTF-8"))
}

/// Checks a detached signature (base64 text) over `bytes`.
pub fn verify(bytes: &[u8], signature: &[u8], key: &VerifyingKey) -> Result<(), String> {
    let bad = || format!("{FILE_ENV}: the file signature does not match {SIGNING_KEY_ENV}");
    let text = std::str::from_utf8(signature).map_err(|_| bad())?;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|_| bad())?;
    let raw: [u8; 64] = raw.try_into().map_err(|_| bad())?;
    key.verify(bytes, &Signature::from_bytes(&raw))
        .map_err(|_| bad())
}

fn read_bounded(path: &str, limit: u64) -> Result<Vec<u8>, String> {
    let size = std::fs::metadata(path)
        .map_err(|error| error.kind().to_string())?
        .len();
    if size > limit {
        return Err(format!("larger than {limit} bytes"));
    }
    std::fs::read(path).map_err(|error| error.kind().to_string())
}

#[cfg(test)]
#[path = "signature_tests.rs"]
mod tests;
