//! Device review recovery: pending installations confirm themselves after the
//! review window or when no confirmed installation remains to approve them,
//! and installations that share a machine are recognized by an account-salted
//! machine hash.

use chrono::Utc;
use sha2::{Digest, Sha256};
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

use super::append_device_sync_event;

const MAX_MACHINE_ID_CHARS: usize = 128;

/// How long an installation stays in `pending_review` before the server
/// confirms it without an approval from another installation.
pub const DEVICE_REVIEW_WINDOW_HOURS: i64 = 24;

/// When a pending installation that entered review at `review_started_at`
/// is confirmed automatically.
pub fn device_review_ends_at(review_started_at: &str) -> Option<String> {
    chrono::DateTime::parse_from_rfc3339(review_started_at)
        .ok()
        .map(|started| {
            (started.with_timezone(&Utc) + chrono::Duration::hours(DEVICE_REVIEW_WINDOW_HOURS))
                .to_rfc3339()
        })
}

/// Account-salted hash of a client machine identifier. Installations that
/// report the same machine for the same account share a hash; the hash does
/// not link machines across accounts.
pub fn machine_hash(account_id: &str, machine_id: &str) -> Option<String> {
    let machine_id = machine_id.trim();
    if machine_id.is_empty() || machine_id.chars().count() > MAX_MACHINE_ID_CHARS {
        return None;
    }
    let mut digest = Sha256::new();
    digest.update(b"kordi-device-machine-v1\0");
    digest.update(account_id.as_bytes());
    digest.update(b"\0");
    digest.update(machine_id.as_bytes());
    Some(hex::encode(digest.finalize()))
}

/// Confirms pending installations that no longer need an approval: those whose
/// review window has passed, and all of them when the account has no other
/// confirmed installation with a live session that could approve them.
/// Returns the confirmed device IDs so callers can publish realtime events.
pub async fn confirm_reviewed_devices(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
) -> Result<Vec<String>, sqlx_core::Error> {
    let now = Utc::now();
    let window_start = (now - chrono::Duration::hours(DEVICE_REVIEW_WINDOW_HOURS)).to_rfc3339();
    let now = now.to_rfc3339();
    let confirmed: Vec<(String, Option<String>)> = query_as(
        "UPDATE cloud_devices d SET authorization_state = 'confirmed', \
                confirmed_at = COALESCE(d.confirmed_at, $2), review_started_at = NULL \
         WHERE d.account_id = $1 AND d.revoked_at IS NULL \
           AND d.authorization_state = 'pending_review' \
           AND ( \
             COALESCE(d.review_started_at, d.created_at) <= $3 \
             OR NOT EXISTS ( \
               SELECT 1 FROM cloud_devices c \
               JOIN cloud_refresh_tokens t ON t.device_id = c.device_id \
               WHERE c.account_id = $1 AND c.revoked_at IS NULL \
                 AND c.authorization_state = 'confirmed' \
                 AND t.revoked_at IS NULL AND t.expires_at > $2 \
             ) \
           ) \
         RETURNING d.device_id, d.device_name",
    )
    .bind(account_id)
    .bind(&now)
    .bind(&window_start)
    .fetch_all(&mut **transaction)
    .await?;
    for (device_id, display_name) in &confirmed {
        append_device_sync_event(
            transaction,
            account_id,
            "device.confirmed",
            device_id,
            display_name.as_deref(),
            "confirmed",
        )
        .await
        .map_err(|_| sqlx_core::Error::Protocol("Could not append device sync event.".into()))?;
    }
    Ok(confirmed
        .into_iter()
        .map(|(device_id, _)| device_id)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_hash_is_account_salted_and_rejects_blank_or_oversized_ids() {
        let first = machine_hash("acct_a", "machine").unwrap();
        assert_eq!(first, machine_hash("acct_a", " machine ").unwrap());
        assert_ne!(first, machine_hash("acct_b", "machine").unwrap());
        assert!(!first.contains("machine"));
        assert_eq!(machine_hash("acct_a", "  "), None);
        assert_eq!(machine_hash("acct_a", &"x".repeat(129)), None);
    }

    #[test]
    fn review_ends_one_window_after_it_starts() {
        assert_eq!(
            device_review_ends_at("2026-10-17T12:00:00+00:00").as_deref(),
            Some("2026-10-18T12:00:00+00:00")
        );
        assert_eq!(device_review_ends_at("not a date"), None);
    }
}
