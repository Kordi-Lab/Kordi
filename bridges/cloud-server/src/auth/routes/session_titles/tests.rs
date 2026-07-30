use super::{incoming_cloud_session_title_wins, CloudSessionTitleSummary};

fn title(source: &str, revision: i64, updated_at_ms: i64) -> CloudSessionTitleSummary {
    CloudSessionTitleSummary {
        session_id: "session:self-agent:test".to_string(),
        title: format!("{source}-{revision}"),
        title_source: source.to_string(),
        title_revision: revision,
        title_policy_version: 1,
        title_generated_from_message_id: None,
        updated_at_ms,
        updated_by_account_id: "acct_a".to_string(),
        updated_at: "2026-07-16T00:00:00Z".to_string(),
    }
}

#[test]
fn manual_titles_cannot_be_replaced_by_automatic_titles() {
    assert!(!incoming_cloud_session_title_wins(
        &title("manual", 1, 10),
        &title("auto", 2, 20),
    ));
    assert!(incoming_cloud_session_title_wins(
        &title("auto", 2, 20),
        &title("manual", 1, 10),
    ));
}

#[test]
fn automatic_titles_allow_only_one_revision() {
    assert!(incoming_cloud_session_title_wins(
        &title("auto", 1, 10),
        &title("auto", 2, 20),
    ));
    assert!(!incoming_cloud_session_title_wins(
        &title("auto", 2, 20),
        &title("auto", 3, 30),
    ));
}

#[test]
fn equal_manual_versions_use_the_same_actor_tie_break_as_clients() {
    let mut existing = title("manual", 3, 30);
    existing.updated_by_account_id = "acct_z".to_string();
    let mut incoming = title("manual", 3, 30);
    incoming.updated_by_account_id = "acct_a".to_string();
    assert!(incoming_cloud_session_title_wins(&existing, &incoming));
    assert!(!incoming_cloud_session_title_wins(&incoming, &existing));
}
