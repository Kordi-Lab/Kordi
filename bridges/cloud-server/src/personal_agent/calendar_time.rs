//! Owner-local presentation of provider instants. Source payloads stay intact.

use chrono::DateTime;
use chrono_tz::Tz;
use serde_json::{json, Value};

pub(super) fn presentation(provider: &str, payload: &Value, zone: Option<Tz>) -> Value {
    if provider != "google_calendar" {
        return Value::Null;
    }
    let Some(zone) = zone else { return Value::Null };
    let local = |key: &str| {
        payload[key]
            .as_str()
            .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
            .map(|instant| {
                let at = instant.with_timezone(&zone);
                json!({"instant": at.to_rfc3339(), "label": at.format("%Y-%m-%d %H:%M %Z").to_string()})
            })
            .unwrap_or(Value::Null)
    };
    let start = local("start");
    let end = local("end");
    if start.is_null() && end.is_null() {
        // Date-only all-day values and times without an offset are not instants.
        return Value::Null;
    }
    json!({"timeZone": zone.name(), "start": start, "end": end})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_calendar_instants_are_presented_in_the_owner_zone() {
        let payload =
            json!({"start": "2026-11-01T22:30:00+03:00", "end": "2026-11-01T23:00:00+03:00"});
        let value = presentation(
            "google_calendar",
            &payload,
            Some(chrono_tz::America::Los_Angeles),
        );
        assert_eq!(value["start"]["label"], "2026-11-01 11:30 PST");
        assert_eq!(value["end"]["label"], "2026-11-01 12:00 PST");
        assert_eq!(payload["start"], "2026-11-01T22:30:00+03:00");
        let original = DateTime::parse_from_rfc3339(payload["start"].as_str().unwrap()).unwrap();
        let local =
            DateTime::parse_from_rfc3339(value["start"]["instant"].as_str().unwrap()).unwrap();
        assert_eq!(original, local);
    }

    #[test]
    fn daylight_saving_and_date_boundaries_follow_the_instant() {
        let payload = json!({"start": "2026-11-01T08:30:00Z", "end": "2026-11-01T09:30:00Z"});
        let value = presentation(
            "google_calendar",
            &payload,
            Some(chrono_tz::America::Los_Angeles),
        );
        assert_eq!(value["start"]["label"], "2026-11-01 01:30 PDT");
        assert_eq!(value["end"]["label"], "2026-11-01 01:30 PST");
        let value = presentation(
            "google_calendar",
            &json!({"start": "2026-11-02T01:00:00Z"}),
            Some(chrono_tz::America::Los_Angeles),
        );
        assert_eq!(value["start"]["label"], "2026-11-01 17:00 PST");
    }

    #[test]
    fn unknown_or_all_day_times_are_never_invented() {
        let zone = Some(chrono_tz::America::Los_Angeles);
        for payload in [
            json!({"start": "2026-11-01", "end": "2026-11-02"}),
            json!({"start": "2026-11-01T11:30:00"}),
            json!({"start": "invalid"}),
        ] {
            assert!(presentation("google_calendar", &payload, zone).is_null());
        }
        let payload = json!({"start": "2026-11-01T19:30:00Z"});
        assert!(presentation("google_calendar", &payload, None).is_null());
        assert!(presentation("gmail", &payload, zone).is_null());
    }
}
