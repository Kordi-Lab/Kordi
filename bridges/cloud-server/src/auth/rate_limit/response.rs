//! The one shape every rate-limit refusal takes, after Telegram's
//! `FLOOD_WAIT_X`: status 429, a `Retry-After` header, and a JSON body with a
//! stable `errorCode` and the exact wait in `retryAfterSeconds`, so clients
//! can say "try again in N seconds" or wait and retry.

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;

use super::Duration;

/// The stable error code for every rate-limit refusal.
pub const RATE_LIMITED_CODE: &str = "rate_limited";

/// Whole seconds to wait, rounded up so a client that waits exactly this long
/// is never refused again; at least one.
pub fn retry_after_seconds(retry_after: Duration) -> u64 {
    let seconds = retry_after.as_secs();
    let rounded = if retry_after.subsec_nanos() > 0 {
        seconds.saturating_add(1)
    } else {
        seconds
    };
    rounded.max(1)
}

/// "42 seconds", "3 minutes", or "2 hours", rounded up.
pub fn wait_phrase(seconds: u64) -> String {
    let (amount, unit) = if seconds < 90 {
        (seconds, "second")
    } else if seconds < 90 * 60 {
        (seconds.div_ceil(60), "minute")
    } else {
        (seconds.div_ceil(3600), "hour")
    };
    let plural = if amount == 1 { "" } else { "s" };
    format!("{amount} {unit}{plural}")
}

/// A 429 with the default message.
pub fn rate_limited_response(retry_after: Duration) -> Response {
    rate_limited_response_with(retry_after, "Too many attempts.")
}

/// A 429 whose message starts with `lead` (for example "Too many avatar
/// requests.") and ends with the wait.
pub fn rate_limited_response_with(retry_after: Duration, lead: &str) -> Response {
    let seconds = retry_after_seconds(retry_after);
    let body = serde_json::json!({
        "errorCode": RATE_LIMITED_CODE,
        "message": format!("{lead} Try again in {}.", wait_phrase(seconds)),
        "retryAfterSeconds": seconds,
    });
    let mut response = (StatusCode::TOO_MANY_REQUESTS, Json(body)).into_response();
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(seconds));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn waits_round_up_to_whole_seconds() {
        assert_eq!(retry_after_seconds(Duration::ZERO), 1);
        assert_eq!(retry_after_seconds(Duration::from_millis(1)), 1);
        assert_eq!(retry_after_seconds(Duration::from_secs(3)), 3);
        assert_eq!(retry_after_seconds(Duration::from_millis(3_001)), 4);
    }

    #[test]
    fn long_waits_read_in_minutes_or_hours() {
        assert_eq!(wait_phrase(1), "1 second");
        assert_eq!(wait_phrase(89), "89 seconds");
        assert_eq!(wait_phrase(90), "2 minutes");
        assert_eq!(wait_phrase(3_540), "59 minutes");
        assert_eq!(wait_phrase(5_400), "2 hours");
    }

    #[tokio::test]
    async fn refusals_carry_the_wait_in_the_header_and_body() {
        let response = rate_limited_response(Duration::from_millis(41_200));
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(response.headers()[header::RETRY_AFTER], "42");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["errorCode"], "rate_limited");
        assert_eq!(body["retryAfterSeconds"], 42);
        assert_eq!(
            body["message"],
            "Too many attempts. Try again in 42 seconds."
        );
    }
}
