use std::time::Duration;

use super::{SessionSignal, SessionSignalHub, SignalKind, SignalVerdict};

fn signal(device: Option<&str>, token: Option<&str>, kind: SignalKind) -> SessionSignal {
    SessionSignal {
        account_id: "acct".to_string(),
        device_id: device.map(ToString::to_string),
        token_id: token.map(ToString::to_string),
        kind,
    }
}

#[test]
fn payloads_from_the_database_parse() {
    assert_eq!(
        SessionSignal::parse(r#"{"a":"acct","d":"dev","t":"cs_1","k":"revoked"}"#),
        Some(signal(Some("dev"), Some("cs_1"), SignalKind::Revoked))
    );
    assert_eq!(
        SessionSignal::parse(r#"{"a":"acct","d":null,"t":null,"k":"recheck"}"#),
        Some(signal(None, None, SignalKind::Recheck))
    );
    assert_eq!(SessionSignal::parse(r#"{"a":"","k":"revoked"}"#), None);
    assert_eq!(SessionSignal::parse("acct"), None);
}

#[test]
fn signals_match_by_device_and_session() {
    let revoked = signal(Some("dev"), Some("cs_1"), SignalKind::Revoked);
    assert!(revoked.applies_to("dev", Some("cs_1")));
    assert!(!revoked.applies_to("dev", Some("cs_2")));
    assert!(!revoked.applies_to("other", Some("cs_1")));
    assert!(
        !revoked.applies_to("dev", None),
        "a legacy device socket outlives one session"
    );
    let device = signal(Some("dev"), None, SignalKind::Revoked);
    assert!(device.applies_to("dev", Some("cs_1")));
    assert!(device.applies_to("dev", None));
    assert!(!device.applies_to("other", None));
    assert!(signal(None, None, SignalKind::Revoked).applies_to("any", Some("cs_9")));
}

#[tokio::test]
async fn hub_delivers_only_matching_signals() {
    let hub = SessionSignalHub::new();
    let mut mine = hub.subscribe("acct", "dev", Some("cs_1"));
    let mut sibling = hub.subscribe("acct", "dev", Some("cs_2"));
    let mut stranger = hub.subscribe("other", "dev", Some("cs_1"));

    hub.publish(signal(Some("dev"), Some("cs_1"), SignalKind::Revoked));
    let verdict = tokio::time::timeout(Duration::from_millis(100), mine.recv()).await;
    assert_eq!(verdict.unwrap(), SignalVerdict::Close);
    assert!(
        tokio::time::timeout(Duration::from_millis(20), sibling.recv())
            .await
            .is_err()
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(20), stranger.recv())
            .await
            .is_err()
    );

    hub.publish(signal(None, None, SignalKind::Recheck));
    let verdict = tokio::time::timeout(Duration::from_millis(100), sibling.recv()).await;
    assert_eq!(verdict.unwrap(), SignalVerdict::Recheck);

    drop((mine, sibling, stranger));
    assert!(hub.accounts.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_lagging_socket_rechecks_instead_of_missing_a_revocation() {
    let hub = SessionSignalHub::new();
    let mut socket = hub.subscribe("acct", "dev", Some("cs_1"));
    for _ in 0..40 {
        hub.publish(signal(Some("dev"), Some("cs_other"), SignalKind::Revoked));
    }
    let verdict = tokio::time::timeout(Duration::from_millis(100), socket.recv()).await;
    assert_eq!(verdict.unwrap(), SignalVerdict::Recheck);
}
