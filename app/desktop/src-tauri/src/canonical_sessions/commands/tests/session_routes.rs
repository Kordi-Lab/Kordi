use serde_json::json;

use super::*;

fn seed_message(
    conn: &Connection,
    id: &str,
    session_id: &str,
    sender_role: &str,
    source_transport: &str,
    content_json: Option<&str>,
    sequence_num: i64,
) {
    conn.execute(
        "INSERT INTO session_messages (
            id, session_id, sender_identity_id, sender_role, message_kind,
            content_text, content_json, status, sequence_num, created_at_ms,
            updated_at_ms, source_transport
         ) VALUES (?1, ?2, 'human:me', ?3, 'text', ?1, ?4, 'sent', ?5, ?5, ?5, ?6)",
        params![
            id,
            session_id,
            sender_role,
            content_json,
            sequence_num,
            source_transport
        ],
    )
    .expect("seed canonical message");
}

fn routed(model: &str) -> String {
    json!({
        "text": "hello",
        "agentRuntimeRoute": {
            "model": model,
            "authProvider": "openai",
            "authChoice": "cloud-login:account-1",
            "thinking": "medium",
        },
    })
    .to_string()
}

#[test]
fn session_request_routes_return_the_latest_routed_request_per_session() {
    let conn = test_conn();
    seed_identity(&conn);
    let older = routed("openai/gpt-5.5");
    let latest = routed("openai/gpt-5.6-sol");
    let other = routed("anthropic/claude");
    let agent_reply = routed("openai/agent-reply");
    let echoed = routed("openai/cloud-echo");
    let empty_model = routed("  ");
    let desktop = "desktop-chat-ui";
    for (id, session, role, transport, content, sequence) in [
        ("a-1", "session-a", "user", desktop, Some(older.as_str()), 1),
        (
            "a-2",
            "session-a",
            "user",
            desktop,
            Some(latest.as_str()),
            4,
        ),
        // Later rows without a usable route never hide the recorded route.
        (
            "a-3",
            "session-a",
            "user",
            desktop,
            Some(r#"{"text":"failed"}"#),
            6,
        ),
        ("a-4", "session-a", "user", desktop, None, 7),
        ("a-5", "session-a", "user", desktop, Some("not json"), 8),
        (
            "a-6",
            "session-a",
            "user",
            desktop,
            Some(empty_model.as_str()),
            9,
        ),
        // Other senders and transports never count as the person's request.
        (
            "a-7",
            "session-a",
            "owned-agent",
            desktop,
            Some(agent_reply.as_str()),
            10,
        ),
        (
            "a-8",
            "session-a",
            "user",
            "cloud-self-agent",
            Some(echoed.as_str()),
            11,
        ),
        ("b-1", "session-b", "user", desktop, Some(other.as_str()), 2),
        (
            "c-1",
            "session-c",
            "user",
            desktop,
            Some(r#"{"text":"plain"}"#),
            3,
        ),
    ] {
        seed_message(&conn, id, session, role, transport, content, sequence);
    }

    let routes = latest_session_request_routes_from_db(&conn).expect("load request routes");

    assert_eq!(routes.len(), 2);
    assert_eq!(routes[0].session_id, "session-a");
    assert_eq!(routes[0].sequence_num, 4);
    assert_eq!(routes[0].updated_at_ms, 4);
    assert_eq!(
        routes[0].route,
        json!({
            "model": "openai/gpt-5.6-sol",
            "authProvider": "openai",
            "authChoice": "cloud-login:account-1",
            "thinking": "medium",
        })
    );
    assert_eq!(routes[1].session_id, "session-b");
    assert_eq!(routes[1].route["model"], json!("anthropic/claude"));
}

#[test]
fn session_request_routes_are_empty_without_routed_requests() {
    let conn = test_conn();
    seed_identity(&conn);
    seed_message(
        &conn,
        "plain",
        "session-a",
        "user",
        "desktop-chat-ui",
        Some(r#"{"text":"hello"}"#),
        1,
    );
    assert!(latest_session_request_routes_from_db(&conn)
        .expect("load request routes")
        .is_empty());
}
