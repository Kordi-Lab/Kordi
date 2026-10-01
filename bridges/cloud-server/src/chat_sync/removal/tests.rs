use super::*;

#[test]
fn retries_start_at_30_seconds_double_and_cap_at_6_hours() {
    assert_eq!(retry_delay(1), Duration::from_secs(30));
    assert_eq!(retry_delay(2), Duration::from_secs(60));
    assert_eq!(retry_delay(3), Duration::from_secs(120));
    assert_eq!(retry_delay(10), Duration::from_secs(30 * 512));
    assert_eq!(retry_delay(11), Duration::from_secs(6 * 60 * 60));
    assert_eq!(retry_delay(1_000), Duration::from_secs(6 * 60 * 60));
    assert_eq!(retry_delay(0), Duration::from_secs(30));
}

#[test]
fn readiness_requires_storage_attestation_and_a_probe() {
    for storage in [false, true] {
        for attested in [false, true] {
            for probe in [false, true] {
                assert_eq!(
                    readiness(storage, attested, probe),
                    storage && attested && probe
                );
            }
        }
    }
    assert!(bucket_attested(Some("1")));
    assert!(bucket_attested(Some(" 1\n")));
    for value in [
        None,
        Some(""),
        Some("0"),
        Some("true"),
        Some("yes"),
        Some("11"),
    ] {
        assert!(!bucket_attested(value), "{value:?}");
    }
}

#[test]
fn delete_errors_map_to_codes() {
    assert_eq!(
        ObjectDeleteError::Forbidden.code(),
        "object_store_forbidden"
    );
    assert_eq!(ObjectDeleteError::Failed.code(), "object_store_error");
    assert_eq!(
        StepOutcome::Failed("database_error").label(),
        "error:database_error"
    );
    assert!(StepOutcome::Retained.finished() && !StepOutcome::More.finished());
}
