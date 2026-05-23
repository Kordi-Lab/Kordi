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

pub const DEFAULT_PRESENCE_TIMEOUT_SECONDS: i64 = 90;

pub fn presence_timeout() -> ChronoDuration {
    let seconds = std::env::var("KORDI_CLOUD_PRESENCE_TIMEOUT_SECONDS")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value >= 30)
        .unwrap_or(DEFAULT_PRESENCE_TIMEOUT_SECONDS);
    ChronoDuration::seconds(seconds)
}

pub fn device_presence_is_currently_online(
    state: &str,
    last_heartbeat_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
    timeout: ChronoDuration,
) -> bool {
    state == "online" && last_heartbeat_at.map(|ts| now - ts <= timeout).unwrap_or(false)
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration as ChronoDuration, TimeZone, Utc};

    #[test]
    fn online_device_is_fresh_until_timeout() {
        let now = Utc.with_ymd_and_hms(2026, 5, 23, 12, 0, 0).unwrap();
        let fresh = now - ChronoDuration::seconds(74);
        let stale = now - ChronoDuration::seconds(76);
        assert!(device_presence_is_currently_online("online", Some(fresh), now, ChronoDuration::seconds(75)));
        assert!(!device_presence_is_currently_online("online", Some(stale), now, ChronoDuration::seconds(75)));
        assert!(!device_presence_is_currently_online("offline", Some(fresh), now, ChronoDuration::seconds(75)));
        assert!(!device_presence_is_currently_online("online", None, now, ChronoDuration::seconds(75)));
    }

    #[test]
    fn account_rollup_is_online_when_any_device_is_online() {
        assert_eq!(rollup_account_presence([false, true, false]), AccountPresenceStatus::Online);
        assert_eq!(rollup_account_presence([false, false]), AccountPresenceStatus::Offline);
        assert_eq!(rollup_account_presence(std::iter::empty::<bool>()), AccountPresenceStatus::Offline);
    }
}
