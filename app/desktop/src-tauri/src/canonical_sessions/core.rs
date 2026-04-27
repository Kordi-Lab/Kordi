use chrono::Utc;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

use super::CANONICAL_SESSIONS_DB_FILENAME;

pub(crate) fn canonical_bridge_session_id(conversation_id: &str) -> String {
    format!("session:bridge:{}", conversation_id.trim())
}

pub(super) fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

pub(super) fn canonical_storage_root() -> PathBuf {
    kordi_core::config::preferred_global_settings_dir()
}

pub(super) fn canonical_sessions_db_path() -> PathBuf {
    canonical_storage_root().join(CANONICAL_SESSIONS_DB_FILENAME)
}

pub(super) fn hash_hex(value: &str, bytes: usize) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(&digest[..bytes.min(digest.len())])
}

pub(super) fn stable_profile_id(storage_root: &Path) -> String {
    format!(
        "profile:{}",
        hash_hex(&storage_root.display().to_string(), 10)
    )
}
