use super::super::legacy_self_duplicates::prune_legacy_cloud_self_message_duplicates_in_db;
use super::*;

fn seed_legacy_self_message(
    conn: &Connection,
    id: &str,
    sequence_num: i64,
    created_at_ms: i64,
    content_text: &str,
    content_json: Option<&str>,
    source_transport: &str,
) {
    conn.execute(
        "INSERT INTO session_messages (
            id, session_id, sender_identity_id, sender_role, message_kind,
            content_text, content_json, status, sequence_num, created_at_ms,
            updated_at_ms, source_transport, source_event_id
         ) VALUES (
            ?1, 'session:self', 'human:me', 'user', 'text', ?2, ?3,
            'sent', ?4, ?5, ?5, ?6, ?1
         )",
        params![
            id,
            content_text,
            content_json,
            sequence_num,
            created_at_ms,
            source_transport,
        ],
    )
    .expect("seed legacy self message");
}

#[test]
fn legacy_cloud_self_repair_repoints_references_before_pruning_near_time_replays() {
    let mut conn = test_conn();
    seed_identity(&conn);
    conn.execute(
        "INSERT INTO sessions (
            id, kind, title, status, created_by_identity_id,
            created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES (
            'session:self', 'self-agent', 'Self', 'active', 'human:me',
            1, 10, 10
         )",
        [],
    )
    .expect("seed session");

    seed_legacy_self_message(
        &conn,
        "message:duplicate:one",
        1,
        10_000,
        "same prompt",
        None,
        "cloud-self-agent",
    );
    seed_legacy_self_message(
        &conn,
        "message:duplicate:referenced",
        2,
        10_000,
        "same prompt",
        None,
        "cloud-self-agent",
    );
    seed_legacy_self_message(
        &conn,
        "message:duplicate:three",
        3,
        10_700,
        "same prompt",
        None,
        "cloud-self-agent",
    );
    seed_legacy_self_message(
        &conn,
        "message:different-time",
        4,
        12_000,
        "same prompt",
        None,
        "cloud-self-agent",
    );
    seed_legacy_self_message(
        &conn,
        "message:attachment",
        5,
        10_000,
        "same prompt",
        Some(r#"{"attachments":[{"name":"evidence.png"}]}"#),
        "cloud-self-agent",
    );
    seed_legacy_self_message(
        &conn,
        "message:desktop",
        6,
        10_000,
        "same prompt",
        None,
        "desktop-chat",
    );
    conn.execute(
        r#"INSERT INTO session_messages (
            id, session_id, sender_identity_id, sender_role, message_kind,
            content_text, content_json, parent_message_id, status, sequence_num,
            created_at_ms, updated_at_ms, source_transport, source_event_id
         ) VALUES (
            'message:response', 'session:self', 'agent:self', 'owned-agent',
            'agent-turn', 'done', '{"requestId":"message:duplicate:referenced"}',
            'message:duplicate:referenced', 'complete', 7, 13_000, 13_000,
            'cloud-self-agent', 'response:referenced'
         )"#,
        [],
    )
    .expect("seed response reference");
    conn.execute(
        r#"INSERT INTO session_messages (
            id, session_id, sender_identity_id, sender_role, message_kind,
            content_text, content_json, parent_message_id, status, sequence_num,
            created_at_ms, updated_at_ms, source_transport, source_event_id
         ) VALUES (
            'message:response:duplicate', 'session:self', 'agent:self', 'owned-agent',
            'agent-turn', 'done', '{"requestId":"message:duplicate:three","replyToMessageId":"message:duplicate:three"}',
            'message:duplicate:three', 'complete', 8, 13_100, 13_100,
            'cloud-self-agent', 'response:duplicate'
         )"#,
        [],
    )
    .expect("seed duplicate response reference");

    let deleted = prune_legacy_cloud_self_message_duplicates_in_db(&mut conn)
        .expect("prune near-time legacy replays");
    assert_eq!(
        deleted,
        vec![
            "message:duplicate:one".to_string(),
            "message:duplicate:three".to_string(),
        ]
    );

    let retained = conn
        .prepare("SELECT id FROM session_messages ORDER BY sequence_num")
        .expect("prepare retained message query")
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query retained messages")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect retained messages");
    assert_eq!(
        retained,
        vec![
            "message:duplicate:referenced",
            "message:different-time",
            "message:attachment",
            "message:desktop",
            "message:response",
            "message:response:duplicate",
        ]
    );
    let response_references = conn
        .prepare(
            "SELECT parent_message_id, json_extract(content_json, '$.requestId'),
                    json_extract(content_json, '$.replyToMessageId')
             FROM session_messages
             WHERE id IN ('message:response', 'message:response:duplicate')
             ORDER BY id",
        )
        .expect("prepare retained response references")
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .expect("query retained response references")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect retained response references");
    assert_eq!(
        response_references,
        vec![
            (
                "message:duplicate:referenced".to_string(),
                "message:duplicate:referenced".to_string(),
                None,
            ),
            (
                "message:duplicate:referenced".to_string(),
                "message:duplicate:referenced".to_string(),
                Some("message:duplicate:referenced".to_string()),
            ),
        ]
    );
    assert!(prune_legacy_cloud_self_message_duplicates_in_db(&mut conn)
        .expect("repeat repair is idempotent")
        .is_empty());
}
