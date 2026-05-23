use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};

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
