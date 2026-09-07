use super::*;

#[test]
fn desktop_sync_does_not_reclassify_bridge_sessions() {
    let conn = test_conn();
    seed_identity_with_source(
        &conn,
        "agent:selected",
        "Research Agent",
        "agent",
        "cloud",
        Some("human:local"),
    );
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("session:bridge:humans:test".to_string()),
            kind: "direct-person".to_string(),
            title: Some("User A".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("human:remote".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some("human:remote".to_string()),
            participant_identity_ids: vec!["human:remote".to_string()],
            metadata: Some(serde_json::json!({ "source": "desktop-bridge-conversation" })),
        },
    )
    .expect("open bridge session");
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("local-session".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Local".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("agent:local".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:local".to_string()],
            metadata: Some(serde_json::json!({ "source": "desktop-chat-summary" })),
        },
    )
    .expect("open desktop session");
    open_or_create_session_in_db(
        &conn,
        OpenCanonicalSessionRequest {
            id: Some("selected-agent-session".to_string()),
            kind: "self-agent".to_string(),
            title: Some("Selected agent".to_string()),
            status: Some("active".to_string()),
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("agent:selected".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: None,
            participant_identity_ids: vec!["agent:selected".to_string()],
            metadata: Some(serde_json::json!({ "createdFrom": "chat-create-flow" })),
        },
    )
    .expect("open selected agent session");

    assert_eq!(
        crate::canonical_sessions::desktop_sync::desktop_session_agent_identity(
            &conn,
            "selected-agent-session",
            "agent:local"
        )
        .unwrap(),
        "agent:selected"
    );
    conn.execute(
        "UPDATE sessions SET metadata_json=?1 WHERE id='selected-agent-session'",
        [serde_json::json!({"source":"canonical-fork-snapshot"}).to_string()],
    )
    .unwrap();

    assert!(
        !should_update_desktop_session_shell(&conn, "session:bridge:humans:test")
            .expect("bridge shell check")
    );
    assert!(
        should_update_desktop_session_shell(&conn, "local-session").expect("desktop shell check")
    );
    assert!(
        !should_update_desktop_session_shell(&conn, "selected-agent-session")
            .expect("selected agent shell check")
    );
}
