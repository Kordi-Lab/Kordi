//! Whether a saved account can still serve runs. A snapshot the server can
//! refresh stays ready; any other snapshot with an expiry, including an OAuth
//! account whose refresh token only its provider's client can use, needs
//! reconnecting once its token is within five minutes of expiring.

use chrono::Utc;
use serde_json::Value;

const EXPIRY_MARGIN_MS: i64 = 5 * 60 * 1000;
pub const READY: &str = "ready";
pub const NEEDS_RECONNECT: &str = "needs-reconnect";

pub fn snapshot_status(refreshable: bool, expires_at_ms: Option<i64>) -> &'static str {
    match expires_at_ms {
        Some(expires_at_ms)
            if !refreshable
                && expires_at_ms <= Utc::now().timestamp_millis() + EXPIRY_MARGIN_MS =>
        {
            NEEDS_RECONNECT
        }
        _ => READY,
    }
}

/// The access token expiry from `expiresAtMs`, sent as a number or a string.
pub fn payload_expiry(payload: &Value) -> Option<i64> {
    payload.get("expiresAtMs").and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
    })
}

/// How long an access token the server cannot refresh is trusted when its
/// sender did not say when it expires. Desktops republish well within this.
pub const UNKNOWN_EXPIRY_LIFETIME_MS: i64 = 60 * 60 * 1000;

/// An access token the server cannot refresh and whose expiry is unknown.
/// Treating it as never expiring kept expired tokens in use (issue 1802).
pub fn access_token_without_expiry(payload: &Value) -> bool {
    payload
        .get("accessToken")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        && payload_expiry(payload).is_none()
        && !payload_refreshable(payload)
}

/// The expiry stored for a newly published payload.
pub fn publish_expiry(payload: &Value, now_ms: i64) -> Option<i64> {
    payload_expiry(payload).or_else(|| {
        access_token_without_expiry(payload).then_some(now_ms + UNKNOWN_EXPIRY_LIFETIME_MS)
    })
}

/// Credential modes whose tokens the server itself refreshes (see
/// `codex_refresh`). Every other refresh token stays unused on the server.
const SERVER_REFRESHED_API_MODES: [&str; 1] = ["openai-codex-oauth"];

/// The server can refresh a snapshot only when it holds a refresh token for a
/// credential mode it knows how to refresh.
pub fn payload_refreshable(payload: &Value) -> bool {
    let has_refresh_token = payload
        .get("refreshToken")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    has_refresh_token
        && payload
            .get("apiMode")
            .and_then(Value::as_str)
            .is_some_and(|mode| SERVER_REFRESHED_API_MODES.contains(&mode.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn access_only_snapshots_need_reconnecting_near_expiry() {
        let now = Utc::now().timestamp_millis();
        assert_eq!(snapshot_status(false, None), READY);
        assert_eq!(snapshot_status(false, Some(now + 3_600_000)), READY);
        assert_eq!(snapshot_status(false, Some(now + 60_000)), NEEDS_RECONNECT);
        assert_eq!(snapshot_status(false, Some(now - 60_000)), NEEDS_RECONNECT);
        assert_eq!(snapshot_status(true, Some(now - 60_000)), READY);
    }

    #[test]
    fn access_tokens_without_expiry_get_a_bounded_lifetime() {
        let now = 1_000;
        let oauth = json!({ "apiMode": "anthropic-oauth", "accessToken": "synthetic" });
        assert_eq!(
            publish_expiry(&oauth, now),
            Some(now + UNKNOWN_EXPIRY_LIFETIME_MS)
        );
        let dated = json!({ "accessToken": "synthetic", "expiresAtMs": 42 });
        assert_eq!(publish_expiry(&dated, now), Some(42));
        assert_eq!(publish_expiry(&json!({ "apiKey": "synthetic" }), now), None);
        let refreshable = json!({
            "apiMode": "openai-codex-oauth",
            "accessToken": "synthetic",
            "refreshToken": "synthetic",
        });
        assert_eq!(publish_expiry(&refreshable, now), None);
    }

    #[test]
    fn expiry_and_refresh_capability_come_from_the_payload() {
        assert_eq!(payload_expiry(&json!({ "expiresAtMs": 42 })), Some(42));
        assert_eq!(payload_expiry(&json!({ "expiresAtMs": "42" })), Some(42));
        assert_eq!(payload_expiry(&json!({ "expiresAtMs": null })), None);
        let codex =
            |refresh: Value| json!({ "apiMode": "openai-codex-oauth", "refreshToken": refresh });
        assert!(payload_refreshable(&codex(json!("synthetic"))));
        assert!(!payload_refreshable(&codex(json!(" "))));
        assert!(!payload_refreshable(&codex(Value::Null)));
    }

    #[test]
    fn only_refresh_tokens_the_server_can_use_keep_an_expiring_account_ready() {
        let expired = Utc::now().timestamp_millis() - 60_000;
        for (mode, refreshable) in [
            (json!("openai-codex-oauth"), true),
            (json!("anthropic-oauth"), false),
            (json!("github-copilot-oauth"), false),
            (json!("api-key"), false),
            (Value::Null, false),
        ] {
            let payload = json!({
                "apiMode": mode,
                "accessToken": "synthetic-access",
                "refreshToken": "synthetic-refresh",
                "expiresAtMs": expired,
            });
            assert_eq!(payload_refreshable(&payload), refreshable, "{mode}");
            let expected = if refreshable { READY } else { NEEDS_RECONNECT };
            let status = snapshot_status(payload_refreshable(&payload), payload_expiry(&payload));
            assert_eq!(status, expected, "{mode}");
        }
    }
}
