use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountPresenceStatus {
    Online,
    Offline,
}

impl AccountPresenceStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Online => "online",
            Self::Offline => "offline",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AccountPresenceSummary {
    #[serde(rename = "accountId")]
    pub account_id: String,
    pub status: AccountPresenceStatus,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

pub const DEFAULT_PRESENCE_TIMEOUT_SECONDS: i64 = 35;
pub const DEFAULT_PRESENCE_SWEEP_SECONDS: u64 = 5;

pub fn presence_timeout() -> ChronoDuration {
    let seconds = std::env::var("KORDI_CLOUD_PRESENCE_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 15)
        .unwrap_or(DEFAULT_PRESENCE_TIMEOUT_SECONDS);
    ChronoDuration::seconds(seconds)
}

pub fn presence_sweep_interval() -> std::time::Duration {
    let seconds = std::env::var("KORDI_CLOUD_PRESENCE_SWEEP_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value >= 1)
        .unwrap_or(DEFAULT_PRESENCE_SWEEP_SECONDS);
    std::time::Duration::from_secs(seconds)
}

pub fn device_presence_is_currently_online(
    state: &str,
    last_heartbeat_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    timeout: ChronoDuration,
) -> bool {
    state == "online"
        && last_heartbeat_at
            .map(|ts| now - ts <= timeout)
            .unwrap_or(false)
}

pub fn rollup_account_presence<I>(device_online_states: I) -> AccountPresenceStatus
where
    I: IntoIterator<Item = bool>,
{
    if device_online_states.into_iter().any(|online| online) {
        AccountPresenceStatus::Online
    } else {
        AccountPresenceStatus::Offline
    }
}

fn parse_rfc3339(value: Option<String>) -> Option<DateTime<Utc>> {
    value
        .and_then(|raw| DateTime::parse_from_rfc3339(&raw).ok())
        .map(|ts| ts.with_timezone(&Utc))
}

pub async fn account_presence_status(
    pool: &PgPool,
    account_id: &str,
    now: DateTime<Utc>,
    timeout: ChronoDuration,
) -> Result<AccountPresenceSummary, sqlx_core::Error> {
    let rows: Vec<(String, Option<String>)> = query_as(
        "SELECT p.state, p.last_heartbeat_at \
         FROM cloud_device_presence p \
         JOIN cloud_devices d ON d.device_id = p.device_id \
         WHERE p.account_id = $1 AND d.revoked_at IS NULL",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    let status = rollup_account_presence(rows.into_iter().map(|(state, heartbeat)| {
        device_presence_is_currently_online(&state, parse_rfc3339(heartbeat), now, timeout)
    }));
    Ok(AccountPresenceSummary {
        account_id: account_id.to_string(),
        status,
        updated_at: now.to_rfc3339(),
    })
}

pub async fn account_has_online_desktop(
    pool: &PgPool,
    account_id: &str,
    now: DateTime<Utc>,
    timeout: ChronoDuration,
) -> Result<bool, sqlx_core::Error> {
    let rows: Vec<(String, Option<String>, Option<String>)> = query_as(
        "SELECT p.state, p.last_heartbeat_at, d.device_platform
         FROM cloud_device_presence p
         JOIN cloud_devices d ON d.device_id = p.device_id
         WHERE p.account_id = $1 AND d.revoked_at IS NULL",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().any(|(state, heartbeat, platform)| {
        matches!(
            platform
                .as_deref()
                .map(str::trim)
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("macos" | "desktop")
        ) && device_presence_is_currently_online(&state, parse_rfc3339(heartbeat), now, timeout)
    }))
}

pub async fn mark_device_online(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
) -> Result<AccountPresenceSummary, sqlx_core::Error> {
    let now = Utc::now();
    query(
        "INSERT INTO cloud_device_presence (device_id, account_id, state, last_heartbeat_at, last_offline_at, updated_at) \
         VALUES ($1, $2, 'online', $3, NULL, $3) \
         ON CONFLICT (device_id) DO UPDATE SET \
             account_id = EXCLUDED.account_id, \
             state = 'online', \
             last_heartbeat_at = EXCLUDED.last_heartbeat_at, \
             updated_at = EXCLUDED.updated_at",
    )
    .bind(device_id)
    .bind(account_id)
    .bind(now.to_rfc3339())
    .execute(pool)
    .await?;
    account_presence_status(pool, account_id, now, presence_timeout()).await
}

pub async fn mark_device_offline(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
) -> Result<AccountPresenceSummary, sqlx_core::Error> {
    let now = Utc::now();
    query(
        "INSERT INTO cloud_device_presence (device_id, account_id, state, last_heartbeat_at, last_offline_at, updated_at) \
         VALUES ($1, $2, 'offline', NULL, $3, $3) \
         ON CONFLICT (device_id) DO UPDATE SET \
             account_id = EXCLUDED.account_id, \
             state = 'offline', \
             last_offline_at = EXCLUDED.last_offline_at, \
             updated_at = EXCLUDED.updated_at",
    )
    .bind(device_id)
    .bind(account_id)
    .bind(now.to_rfc3339())
    .execute(pool)
    .await?;
    account_presence_status(pool, account_id, now, presence_timeout()).await
}

pub fn ws_disconnect_should_mark_offline(
    last_heartbeat_at: Option<DateTime<Utc>>,
    disconnected_at: DateTime<Utc>,
) -> bool {
    last_heartbeat_at
        .map(|heartbeat| heartbeat <= disconnected_at)
        .unwrap_or(true)
}

pub async fn mark_device_offline_if_heartbeat_not_after(
    pool: &PgPool,
    account_id: &str,
    device_id: &str,
    disconnected_at: DateTime<Utc>,
) -> Result<Option<AccountPresenceSummary>, sqlx_core::Error> {
    let now = Utc::now();
    let result = query(
        "UPDATE cloud_device_presence \
         SET state = 'offline', last_offline_at = $3, updated_at = $3 \
         WHERE account_id = $1 AND device_id = $2 AND state = 'online' \
           AND (last_heartbeat_at IS NULL OR last_heartbeat_at <= $4)",
    )
    .bind(account_id)
    .bind(device_id)
    .bind(now.to_rfc3339())
    .bind(disconnected_at.to_rfc3339())
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Ok(None);
    }
    account_presence_status(pool, account_id, now, presence_timeout())
        .await
        .map(Some)
}

pub fn stale_presence_cutoff(now: DateTime<Utc>, timeout: ChronoDuration) -> DateTime<Utc> {
    now - timeout
}

pub async fn presence_observer_account_ids(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<String>, sqlx_core::Error> {
    let rows: Vec<(String,)> = query_as(
        "SELECT $1::TEXT AS account_id \
         UNION \
         SELECT peer_account_id FROM cloud_contacts WHERE account_id = $1 \
         UNION \
         SELECT account_id FROM cloud_contacts WHERE peer_account_id = $1",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

pub async fn publish_presence_to_observers(
    pool: &PgPool,
    events: &crate::events::EventBus,
    account_id: &str,
    status: AccountPresenceStatus,
) -> Result<(), sqlx_core::Error> {
    for observer in presence_observer_account_ids(pool, account_id).await? {
        events
            .publish_presence_account_changed(account_id, &observer, status.as_str())
            .await;
    }
    Ok(())
}

pub async fn contact_presence_summaries(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<AccountPresenceSummary>, sqlx_core::Error> {
    let contact_ids: Vec<(String,)> = query_as(
        "SELECT $1::TEXT AS account_id \
         UNION \
         SELECT peer_account_id FROM cloud_contacts WHERE account_id = $1",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    let now = Utc::now();
    let timeout = presence_timeout();
    let mut rows = Vec::with_capacity(contact_ids.len());
    for (id,) in contact_ids {
        rows.push(account_presence_status(pool, &id, now, timeout).await?);
    }
    Ok(rows)
}

pub async fn sweep_stale_presence(
    pool: &PgPool,
    events: &crate::events::EventBus,
) -> Result<Vec<AccountPresenceSummary>, sqlx_core::Error> {
    let now = Utc::now();
    let timeout = presence_timeout();
    let cutoff = stale_presence_cutoff(now, timeout).to_rfc3339();
    let account_rows: Vec<(String,)> = query_as(
        "SELECT DISTINCT account_id \
         FROM cloud_device_presence \
         WHERE state = 'online' AND last_heartbeat_at < $1",
    )
    .bind(&cutoff)
    .fetch_all(pool)
    .await?;
    let mut changed = Vec::new();
    for (account_id,) in account_rows {
        let before = account_presence_status(pool, &account_id, now, timeout).await?;
        query(
            "UPDATE cloud_device_presence \
             SET state = 'offline', last_offline_at = $2, updated_at = $2 \
             WHERE account_id = $1 AND state = 'online' AND last_heartbeat_at < $3",
        )
        .bind(&account_id)
        .bind(now.to_rfc3339())
        .bind(&cutoff)
        .execute(pool)
        .await?;
        let after = account_presence_status(pool, &account_id, now, timeout).await?;
        if before.status != after.status {
            publish_presence_to_observers(pool, events, &account_id, after.status).await?;
            changed.push(after);
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration as ChronoDuration, TimeZone, Utc};

    #[test]
    fn online_device_is_fresh_until_timeout() {
        let now = Utc.with_ymd_and_hms(2026, 5, 23, 12, 0, 0).unwrap();
        let fresh = now - ChronoDuration::seconds(74);
        let stale = now - ChronoDuration::seconds(76);
        assert!(device_presence_is_currently_online(
            "online",
            Some(fresh),
            now,
            ChronoDuration::seconds(75)
        ));
        assert!(!device_presence_is_currently_online(
            "online",
            Some(stale),
            now,
            ChronoDuration::seconds(75)
        ));
        assert!(!device_presence_is_currently_online(
            "offline",
            Some(fresh),
            now,
            ChronoDuration::seconds(75)
        ));
        assert!(!device_presence_is_currently_online(
            "online",
            None,
            now,
            ChronoDuration::seconds(75)
        ));
    }

    #[test]
    fn account_rollup_is_online_when_any_device_is_online() {
        assert_eq!(
            rollup_account_presence([false, true, false]),
            AccountPresenceStatus::Online
        );
        assert_eq!(
            rollup_account_presence([false, false]),
            AccountPresenceStatus::Offline
        );
        assert_eq!(
            rollup_account_presence(std::iter::empty::<bool>()),
            AccountPresenceStatus::Offline
        );
    }

    #[test]
    fn stale_online_cutoff_uses_timeout() {
        let now = Utc.with_ymd_and_hms(2026, 5, 23, 12, 0, 0).unwrap();
        assert_eq!(
            stale_presence_cutoff(now, ChronoDuration::seconds(90)).to_rfc3339(),
            "2026-05-23T11:58:30+00:00"
        );
    }

    #[test]
    fn websocket_disconnect_offline_ignores_reconnected_heartbeats() {
        let disconnected_at = Utc.with_ymd_and_hms(2026, 5, 23, 12, 0, 0).unwrap();
        assert!(ws_disconnect_should_mark_offline(
            Some(disconnected_at),
            disconnected_at
        ));
        assert!(ws_disconnect_should_mark_offline(
            Some(disconnected_at - ChronoDuration::seconds(1)),
            disconnected_at
        ));
        assert!(!ws_disconnect_should_mark_offline(
            Some(disconnected_at + ChronoDuration::seconds(1)),
            disconnected_at
        ));
    }

    #[test]
    fn default_presence_latency_budget_is_responsive() {
        assert_eq!(DEFAULT_PRESENCE_TIMEOUT_SECONDS, 35);
        assert_eq!(DEFAULT_PRESENCE_SWEEP_SECONDS, 5);
    }
}
