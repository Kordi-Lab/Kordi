use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::chat_sync::PROTOCOL_VERSION;

type HmacSha256 = Hmac<Sha256>;

const CURSOR_PREFIX: &str = "v2";
const MINIMUM_SECRET_BYTES: usize = 32;

#[derive(Clone)]
pub struct CursorCodec {
    key: Vec<u8>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CursorError {
    WeakSecret,
    Malformed,
    InvalidSignature,
    WrongProtocol,
    WrongAccount,
}

impl std::fmt::Display for CursorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::WeakSecret => "sync cursor secret must contain at least 32 bytes",
            Self::Malformed => "sync cursor is malformed",
            Self::InvalidSignature => "sync cursor signature is invalid",
            Self::WrongProtocol => "sync cursor protocol version is unsupported",
            Self::WrongAccount => "sync cursor belongs to another account",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for CursorError {}

#[derive(Debug, Deserialize, Serialize)]
struct CursorPayload<'a> {
    version: i32,
    account_id: &'a str,
    stream_seq: i64,
}

#[derive(Debug, Deserialize)]
struct OwnedCursorPayload {
    version: i32,
    account_id: String,
    stream_seq: i64,
}

impl CursorCodec {
    pub fn new(secret: impl AsRef<[u8]>) -> Result<Self, CursorError> {
        let key = secret.as_ref();
        if key.len() < MINIMUM_SECRET_BYTES {
            return Err(CursorError::WeakSecret);
        }
        Ok(Self { key: key.to_vec() })
    }

    pub fn encode(&self, account_id: &str, stream_seq: i64) -> String {
        let payload = serde_json::to_vec(&CursorPayload {
            version: PROTOCOL_VERSION,
            account_id,
            stream_seq,
        })
        .expect("cursor payload serialization cannot fail");
        let mut mac =
            HmacSha256::new_from_slice(&self.key).expect("HMAC accepts arbitrary key lengths");
        mac.update(&payload);
        let signature = mac.finalize().into_bytes();
        format!(
            "{CURSOR_PREFIX}.{}.{}",
            URL_SAFE_NO_PAD.encode(payload),
            URL_SAFE_NO_PAD.encode(signature)
        )
    }

    pub fn decode(&self, cursor: &str, expected_account_id: &str) -> Result<i64, CursorError> {
        let mut parts = cursor.split('.');
        let prefix = parts.next().ok_or(CursorError::Malformed)?;
        let payload_part = parts.next().ok_or(CursorError::Malformed)?;
        let signature_part = parts.next().ok_or(CursorError::Malformed)?;
        if prefix != CURSOR_PREFIX || parts.next().is_some() {
            return Err(CursorError::Malformed);
        }

        let payload = URL_SAFE_NO_PAD
            .decode(payload_part)
            .map_err(|_| CursorError::Malformed)?;
        let signature = URL_SAFE_NO_PAD
            .decode(signature_part)
            .map_err(|_| CursorError::Malformed)?;
        let mut mac =
            HmacSha256::new_from_slice(&self.key).expect("HMAC accepts arbitrary key lengths");
        mac.update(&payload);
        mac.verify_slice(&signature)
            .map_err(|_| CursorError::InvalidSignature)?;

        let decoded: OwnedCursorPayload =
            serde_json::from_slice(&payload).map_err(|_| CursorError::Malformed)?;
        if decoded.version != PROTOCOL_VERSION {
            return Err(CursorError::WrongProtocol);
        }
        if decoded.account_id != expected_account_id {
            return Err(CursorError::WrongAccount);
        }
        if decoded.stream_seq < 0 {
            return Err(CursorError::Malformed);
        }
        Ok(decoded.stream_seq)
    }
}

#[cfg(test)]
mod tests {
    use super::{CursorCodec, CursorError};

    const SECRET: &[u8] = b"test-only-chat-sync-secret-that-is-long-enough";

    #[test]
    fn cursor_round_trips_for_its_account() {
        let codec = CursorCodec::new(SECRET).unwrap();
        let cursor = codec.encode("acct_one", 42);
        assert_eq!(codec.decode(&cursor, "acct_one"), Ok(42));
    }

    #[test]
    fn cursor_is_bound_to_one_account() {
        let codec = CursorCodec::new(SECRET).unwrap();
        let cursor = codec.encode("acct_one", 42);
        assert_eq!(
            codec.decode(&cursor, "acct_two"),
            Err(CursorError::WrongAccount)
        );
    }

    #[test]
    fn cursor_tampering_is_rejected() {
        let codec = CursorCodec::new(SECRET).unwrap();
        let cursor = codec.encode("acct_one", 42);
        let mut bytes = cursor.into_bytes();
        let last = bytes.len() - 1;
        bytes[last] = if bytes[last] == b'A' { b'B' } else { b'A' };
        let tampered = String::from_utf8(bytes).unwrap();
        assert_eq!(
            codec.decode(&tampered, "acct_one"),
            Err(CursorError::InvalidSignature)
        );
    }

    #[test]
    fn weak_secrets_are_rejected() {
        assert!(matches!(
            CursorCodec::new(b"too-short"),
            Err(CursorError::WeakSecret)
        ));
    }
}
