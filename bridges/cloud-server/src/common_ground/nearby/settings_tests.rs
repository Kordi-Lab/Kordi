use super::*;

#[test]
fn open_to_is_trimmed_deduplicated_and_capped() {
    let items = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert_eq!(
        clean_open_to(&items(&["  Coffee   chat ", "coffee chat", "", "Hiring"])),
        Ok(vec!["Coffee chat".to_string(), "Hiring".to_string()])
    );
    assert!(clean_open_to(&items(&["a", "b", "c", "d", "e", "f"])).is_err());
    assert!(clean_open_to(&items(&["a", "b", "c", "d", "e", "E"])).is_ok());
    assert!(clean_open_to(&items(&[&"x".repeat(31)])).is_err());
    assert!(clean_open_to(&items(&[&"x".repeat(30)])).is_ok());
}

#[test]
fn apply_checks_every_choice() {
    let now = Utc::now();
    let body = |value: Value| serde_json::from_value::<UpdateBody>(value).unwrap();
    let current = Settings::default();
    let next = apply(
        &current,
        &body(json!({"range": 5000, "minScore": 70, "alerts": {"maxPerDay": 10}})),
        now,
    )
    .unwrap();
    assert_eq!(
        (next.range_m, next.min_score, next.alert_max_per_day),
        (5000, 70, 10)
    );
    assert_eq!(next.alert_match_min_score, 85, "fields left out are kept");
    for bad in [
        json!({"range": 1500}),
        json!({"minScore": 60}),
        json!({"alerts": {"matchMinScore": 0}}),
        json!({"alerts": {"maxPerDay": 2}}),
        json!({"pausedUntil": (now + Duration::days(8)).to_rfc3339()}),
    ] {
        assert!(apply(&current, &body(bad.clone()), now).is_err(), "{bad}");
    }
    let paused = apply(
        &current,
        &body(json!({"pausedUntil": (now + Duration::days(6)).to_rfc3339()})),
        now,
    )
    .unwrap();
    assert!(paused.paused(now));
    let resumed = apply(&paused, &body(json!({"pausedUntil": null})), now).unwrap();
    assert_eq!(resumed.paused_until, None);
    assert!(serde_json::from_value::<UpdateBody>(json!({"range": "far"})).is_err());
}
