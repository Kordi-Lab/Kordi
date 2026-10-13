//! Time-boxed password signup for clients released before signup required an
//! emailed code. Those clients cannot send a code, so until the configured
//! deadline a request without one creates an unverified account. The window is
//! closed unless the deadline is configured, valid, and still in the future.

use chrono::{DateTime, Utc};

/// RFC 3339 timestamp until which code-less password signup stays open.
pub const LEGACY_SIGNUP_UNTIL_ENV: &str = "KORDI_AUTH_LEGACY_SIGNUP_UNTIL";

/// Parses the configured deadline. A missing or malformed value yields `None`.
pub fn parse_legacy_signup_until(raw: Option<&str>) -> Option<DateTime<Utc>> {
    let value = raw?.trim();
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|deadline| deadline.with_timezone(&Utc))
}

pub fn legacy_signup_until_from_env() -> Option<DateTime<Utc>> {
    parse_legacy_signup_until(std::env::var(LEGACY_SIGNUP_UNTIL_ENV).ok().as_deref())
}

/// Returns whether code-less signup is allowed at `now`. No deadline means no.
pub fn legacy_signup_is_open(until: Option<DateTime<Utc>>, now: DateTime<Utc>) -> bool {
    until.is_some_and(|deadline| now < deadline)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn open(raw: Option<&str>, now: DateTime<Utc>) -> bool {
        legacy_signup_is_open(parse_legacy_signup_until(raw), now)
    }

    #[test]
    fn unset_window_is_closed() {
        assert!(!open(None, Utc::now()));
        assert!(!open(Some(""), Utc::now()));
        assert!(!open(Some("   "), Utc::now()));
    }

    #[test]
    fn unparsable_window_is_closed() {
        let now = Utc::now();
        for raw in ["true", "1", "tomorrow", "2099-01-01", "2099-01-01 00:00:00"] {
            assert!(!open(Some(raw), now), "{raw} must not open the window");
        }
    }

    #[test]
    fn past_deadline_is_closed() {
        let now = Utc::now();
        let past = (now - Duration::seconds(1)).to_rfc3339();
        assert!(!open(Some(&past), now));
        assert!(!open(Some(&now.to_rfc3339()), now));
    }

    #[test]
    fn future_deadline_is_open_until_it_passes() {
        let now = Utc::now();
        let deadline = now + Duration::hours(1);
        let raw = deadline.to_rfc3339();
        assert!(open(Some(&raw), now));
        assert!(open(Some(&format!("  {raw}\n")), now));
        assert!(!open(Some(&raw), deadline));
        assert!(!open(Some(&raw), deadline + Duration::seconds(1)));
    }

    #[test]
    fn deadline_offsets_are_compared_as_instants() {
        let now = DateTime::parse_from_rfc3339("2026-01-01T00:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        assert!(open(Some("2026-01-01T03:00:00+02:00"), now));
        assert!(!open(Some("2026-01-01T02:00:00+02:00"), now));
    }
}
