use super::*;

fn self_agent_shell(
    id: &str,
    agent: &str,
    creator: &str,
    metadata: serde_json::Value,
) -> OpenCanonicalSessionRequest {
    OpenCanonicalSessionRequest {
        id: Some(id.to_string()),
        kind: "self-agent".to_string(),
        title: Some("Alex's Kordi".to_string()),
        status: Some("active".to_string()),
        created_by_identity_id: creator.to_string(),
        primary_identity_id: Some(agent.to_string()),
        project_id: None,
        project_name: None,
        relationship_identity_id: None,
        participant_identity_ids: vec![agent.to_string()],
        metadata: Some(metadata),
    }
}

#[test]
fn personal_session_marker_survives_a_local_turn_shell_upsert() {
    let conn = test_conn();
    let creator = seed_identity(&conn, "human:me", "Me", "human");
    let agent = seed_identity(&conn, "agent:local", "Alex's Kordi", "agent");
    let id = "session:self-agent:acct_alex:personal:cloud-agent:acct_alex";
    open_or_create_session_in_db(
        &conn,
        self_agent_shell(
            id,
            &agent.id,
            &creator.id,
            serde_json::json!({
                "cloudSelfAgentSession": true,
                "personalAgent": { "agentId": "cloud-agent:acct_alex" },
            }),
        ),
    )
    .expect("create personal session");

    // A local turn rewrites the shell with desktop metadata only.
    open_or_create_session_in_db(
        &conn,
        self_agent_shell(
            id,
            &agent.id,
            &creator.id,
            serde_json::json!({ "source": "desktop-chat-detail", "model": "gpt-test" }),
        ),
    )
    .expect("upsert desktop shell");

    let metadata = select_session(&conn, id)
        .expect("select session")
        .expect("session exists")
        .metadata
        .expect("metadata");
    assert_eq!(
        metadata
            .pointer("/personalAgent/agentId")
            .and_then(|value| value.as_str()),
        Some("cloud-agent:acct_alex")
    );
    assert_eq!(
        metadata.get("cloudSelfAgentSession"),
        Some(&serde_json::json!(true))
    );
    assert_eq!(
        metadata.get("source").and_then(|value| value.as_str()),
        Some("desktop-chat-detail")
    );
}
