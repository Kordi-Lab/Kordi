use chrono::{Duration, Utc};
use serde_json::json;

use super::*;

fn body(value: Value) -> NeedBody {
    serde_json::from_value(value).unwrap()
}

fn draft() -> Draft {
    Draft {
        text: "Someone founding a startup".into(),
        range_m: 1_000,
        starts_at: None,
        ends_at: None,
        paused: false,
    }
}

#[test]
fn status_follows_pause_then_end_then_start() {
    let now = Utc::now();
    let hour = Duration::hours(1);
    assert_eq!(status(false, None, None, now), "active");
    assert_eq!(status(true, None, None, now), "paused");
    assert_eq!(status(true, None, Some(now - hour), now), "paused");
    assert_eq!(status(false, None, Some(now - hour), now), "ended");
    assert_eq!(
        status(false, None, Some(now), now),
        "ended",
        "the end is exclusive"
    );
    assert_eq!(
        status(false, Some(now + hour), Some(now + hour * 2), now),
        "scheduled"
    );
    assert_eq!(status(false, Some(now), Some(now + hour), now), "active");
    assert_eq!(status(false, Some(now - hour), None, now), "active");
}

#[test]
fn merge_checks_text_range_and_window() {
    let now = Utc::now();
    let empty = Draft {
        text: String::new(),
        ..draft()
    };
    assert!(
        merge(&empty, &body(json!({})), now).is_err(),
        "text is required"
    );
    assert!(merge(&empty, &body(json!({"text": "   "})), now).is_err());
    let long = "x".repeat(201);
    assert!(merge(&empty, &body(json!({"text": long})), now).is_err());
    let exact = "x".repeat(200);
    assert!(merge(&empty, &body(json!({"text": exact})), now).is_ok());
    let made = merge(&empty, &body(json!({"text": "  Coffee  "})), now).unwrap();
    assert_eq!(made.text, "Coffee");
    assert!(merge(&draft(), &body(json!({"range": 750})), now).is_err());
    assert_eq!(
        merge(&draft(), &body(json!({"range": 500})), now)
            .unwrap()
            .range_m,
        500
    );

    let iso = |offset: Duration| (now + offset).to_rfc3339();
    for bad in [
        json!({"endsAt": iso(-Duration::minutes(1))}),
        json!({"endsAt": iso(Duration::days(7) + Duration::minutes(1))}),
        json!({"startsAt": iso(Duration::hours(3)), "endsAt": iso(Duration::hours(2))}),
        json!({"startsAt": iso(Duration::hours(2)), "endsAt": iso(Duration::hours(2))}),
    ] {
        assert!(merge(&draft(), &body(bad.clone()), now).is_err(), "{bad}");
    }
    let window = merge(
        &draft(),
        &body(json!({"startsAt": iso(Duration::hours(1)), "endsAt": iso(Duration::days(6))})),
        now,
    )
    .unwrap();
    assert!(window.starts_at.is_some() && window.ends_at.is_some());
    let cleared = merge(
        &window,
        &body(json!({"startsAt": null, "endsAt": null})),
        now,
    )
    .unwrap();
    assert_eq!((cleared.starts_at, cleared.ends_at), (None, None));
    // A request that already ended can still be renamed or paused.
    let ended = Draft {
        ends_at: Some(now - Duration::hours(1)),
        ..draft()
    };
    assert!(merge(
        &ended,
        &body(json!({"text": "Renamed", "paused": true})),
        now
    )
    .is_ok());
    // Moving the start past a kept end is refused.
    let late_start = json!({"startsAt": iso(Duration::days(6) + Duration::hours(1))});
    assert!(merge(&window, &body(late_start), now).is_err());
    assert!(serde_json::from_value::<NeedBody>(json!({"range": "near"})).is_err());
}
