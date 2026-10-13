//! Share tokens, their stored hashes, and the URLs built from them.
//!
//! A token is `kordi_ds_` plus 32 bytes in URL-safe base64 without padding
//! (43 characters). The database keeps only the SHA-256 hex hash. So that
//! the owner can copy the link again, the 32 bytes are an HMAC-SHA256 of the
//! random share id under a server secret instead of a second random value:
//! the token is unguessable without the secret, never stored, and can be
//! rebuilt for its owner.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

pub(crate) const SHARE_TOKEN_PREFIX: &str = "kordi_ds_";
pub(crate) const SHARE_TOKEN_LEN: usize = SHARE_TOKEN_PREFIX.len() + 43;
const MINIMUM_SECRET_BYTES: usize = 32;
const TOKEN_CONTEXT: &[u8] = b"kordi-document-share-v1:";

/// The secret that derives share tokens: `KORDI_DOCUMENT_SHARE_SECRET`, else
/// the chat-sync cursor secret every deployment already sets. Both must be at
/// least 32 bytes. Tests fall back to a fixed key.
pub(crate) fn share_secret() -> Option<Vec<u8>> {
    let configured = [
        "KORDI_DOCUMENT_SHARE_SECRET",
        "KORDI_CHAT_SYNC_CURSOR_SECRET",
    ]
    .iter()
    .filter_map(|name| std::env::var(name).ok())
    .find(|value| value.len() >= MINIMUM_SECRET_BYTES)
    .map(String::into_bytes);
    #[cfg(test)]
    let configured = configured.or_else(|| Some(b"document-share-test-secret-0123456789".to_vec()));
    configured
}

pub(crate) fn new_share_id() -> String {
    format!("docshare_{}", uuid::Uuid::new_v4().simple())
}

pub(crate) fn share_token(secret: &[u8], share_id: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(TOKEN_CONTEXT);
    mac.update(share_id.as_bytes());
    format!(
        "{SHARE_TOKEN_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

pub(crate) fn hash_share_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// Cheap shape check before any database lookup.
pub(crate) fn is_well_formed_token(token: &str) -> bool {
    token.len() == SHARE_TOKEN_LEN
        && token.starts_with(SHARE_TOKEN_PREFIX)
        && token[SHARE_TOKEN_PREFIX.len()..]
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

pub(crate) fn share_url(token: &str) -> String {
    let public_base =
        std::env::var("KORDI_PUBLIC_APP_URL").unwrap_or_else(|_| "https://kordi.ai".to_string());
    format!("{}/d/{token}", public_base.trim_end_matches('/'))
}

pub(crate) fn share_deep_link(token: &str) -> String {
    format!("kordi://document/{token}")
}

pub(crate) fn public_raw_path(token: &str) -> String {
    format!("/d/{token}/raw")
}
