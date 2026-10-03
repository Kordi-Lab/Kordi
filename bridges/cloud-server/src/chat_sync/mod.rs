//! Reliable multi-device chat protocol.
//!
//! This is the canonical product chat transport. Canonical state fans out
//! through a durable, contiguous per-user stream.

use std::sync::atomic::{AtomicBool, Ordering};

pub mod cursor;
pub mod models;
pub mod realtime;
pub mod removal;
pub mod retention;
pub mod routes;
pub mod store;
pub mod visibility;

pub const PROTOCOL_VERSION: i32 = 2;

static CONTENT_REMOVAL_READY: AtomicBool = AtomicBool::new(false);

/// The content removal this server reports to clients: 1 when it deletes
/// stored copies and files of removed content, 0 otherwise. Clients state
/// that stored copies are deleted only at 1 or higher. A missing field means
/// 0, so older or self-hosted servers get the conservative wording.
pub fn content_removal_version() -> i32 {
    if CONTENT_REMOVAL_READY.load(Ordering::Acquire) {
        1
    } else {
        0
    }
}

/// Set by the removal worker once object storage deletion is configured,
/// attested, and verified.
pub fn set_content_removal_ready(ready: bool) {
    CONTENT_REMOVAL_READY.store(ready, Ordering::Release);
}

pub(crate) mod voice;

#[cfg(test)]
mod tests {
    #[test]
    fn content_removal_version_follows_the_readiness_flag() {
        super::set_content_removal_ready(true);
        assert_eq!(super::content_removal_version(), 1);
        super::set_content_removal_ready(false);
        assert_eq!(super::content_removal_version(), 0);
    }
}
