use super::*;

#[test]
fn delayed_cloud_user_mirror_is_reparented_and_removed_atomically() {
    let conn = test_conn();
    seed_identity(&conn);
    conn.execute(
        "INSERT INTO sessions (
            id, kind, title, status, created_by_identity_id,
            metadata_json, created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES (
            'session:self', 'self-agent', 'Self', 'active', 'human:me',
            '{\"sessionTitleGeneratedFromMessageId\":\"message:cloud\",\"fork\":{\"forkedFromMessageId\":\"message:cloud\",\"forkedFromMessageAliases\":[\"message:cloud\",\"entry:runtime\"]}}',
            1, 3, 3
         )",
        [],
    )
    .expect("seed session");
    for (id, role, text, parent, sequence_num, source_transport) in [
        (
            "message:local",
            "user",
            "check my account",
            None,
            1,
            "desktop-chat-ui",
        ),
        (
            "message:cloud",
            "user",
            "check my account",
            None,
            2,
            "cloud-self-agent",
        ),
        (
            "message:response",
            "owned-agent",
            "authentication failed",
            Some("message:cloud"),
            3,
            "cloud-self-agent",
        ),
    ] {
        conn.execute(
            "INSERT INTO session_messages (
                id, session_id, sender_identity_id, sender_role, message_kind,
                content_text, parent_message_id, status, sequence_num,
                created_at_ms, updated_at_ms, source_transport, source_event_id
             ) VALUES (?1, 'session:self', 'human:me', ?2, 'text', ?3, ?4,
                       'sent', ?5, ?5, ?5, ?6, ?1)",
            params![id, role, text, parent, sequence_num, source_transport],
        )
        .expect("seed message");
    }
    conn.execute(
        "UPDATE session_messages
         SET content_json = '{\"replyToMessageId\":\"message:cloud\",\"requestId\":\"message:cloud\",\"cloudRequestMessageId\":\"wire:cloud\",\"text\":\"message:cloud\",\"messageAction\":{\"source\":{\"sourceMessageId\":\"message:cloud\"}}}',
             content_hash = 'old-hash'
         WHERE id = 'message:response'",
        [],
    )
    .expect("seed response content references");
    conn.execute(
        "INSERT INTO session_participants (
            session_id, identity_id, role, state, added_at_ms, last_read_message_id
         ) VALUES ('session:self', 'human:me', 'self', 'active', 1, 'message:cloud')",
        [],
    )
    .expect("seed participant cursor");
    conn.execute(
        "INSERT INTO context_snapshots (
            id, profile_id, session_id, agent_identity_id, provider, model,
            prompt_hash, participant_hash, upto_message_id, message_range_hash,
            created_at_ms
         ) VALUES ('context:one', 'profile:local', 'session:self', 'agent:local',
                   'openai', 'gpt-5', 'prompt', 'participants', 'message:cloud',
                   'range', 3)",
        [],
    )
    .expect("seed context cursor");
    conn.execute(
        "INSERT INTO delegated_exchanges (
            id, session_id, initiator_identity_id, target_identity_id,
            trigger_message_id, request_message_id, response_message_id,
            transport, context_policy, status, created_at_ms, updated_at_ms
         ) VALUES (
            'exchange:one', 'session:self', 'human:me', 'agent:local',
            'message:cloud', 'message:cloud', 'message:cloud',
            'local', 'recent-window', 'complete', 3, 3
         )",
        [],
    )
    .expect("seed delegated exchange references");
    conn.execute(
        "INSERT INTO kv_cache_entries (
            key_hash, profile_id, session_id, agent_identity_id, provider,
            model, created_at_ms, updated_at_ms
         ) VALUES ('cache:one', 'profile:local', 'session:self', 'agent:local',
                   'openai', 'gpt-5', 3, 3)",
        [],
    )
    .expect("seed derived cache");

    assert!(
        reconcile_canonical_message_mirror_in_db(&conn, "message:local", "message:cloud",)
            .expect("reconcile mirror")
    );

    let duplicate_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE id = 'message:cloud'",
            [],
            |row| row.get(0),
        )
        .expect("count duplicate");
    assert_eq!(duplicate_count, 0);
    let response_parent: String = conn
        .query_row(
            "SELECT parent_message_id FROM session_messages WHERE id = 'message:response'",
            [],
            |row| row.get(0),
        )
        .expect("load response parent");
    assert_eq!(response_parent, "message:local");
    let (response_content, response_hash): (String, String) = conn
        .query_row(
            "SELECT content_json, content_hash FROM session_messages WHERE id = 'message:response'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("load repaired response content");
    let response_content: serde_json::Value =
        serde_json::from_str(&response_content).expect("parse repaired response content");
    assert_eq!(response_content["replyToMessageId"], "message:local");
    assert_eq!(response_content["requestId"], "message:local");
    assert_eq!(
        response_content["messageAction"]["source"]["sourceMessageId"],
        "message:local"
    );
    assert_eq!(response_content["cloudRequestMessageId"], "wire:cloud");
    assert_eq!(response_content["text"], "message:cloud");
    assert_ne!(response_hash, "old-hash");
    let (read_message_id, upto_message_id, invalidated_at_ms): (String, String, Option<i64>) = conn
        .query_row(
            "SELECT participant.last_read_message_id, context.upto_message_id,
                    context.invalidated_at_ms
             FROM session_participants AS participant
             JOIN context_snapshots AS context ON context.session_id = participant.session_id
             WHERE participant.session_id = 'session:self'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("load repaired references");
    assert_eq!(read_message_id, "message:local");
    assert_eq!(upto_message_id, "message:local");
    assert!(invalidated_at_ms.is_some());
    let exchange_references: (String, String, String) = conn
        .query_row(
            "SELECT trigger_message_id, request_message_id, response_message_id
             FROM delegated_exchanges WHERE id = 'exchange:one'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .expect("load repaired delegated exchange references");
    assert_eq!(
        exchange_references,
        (
            "message:local".to_string(),
            "message:local".to_string(),
            "message:local".to_string(),
        )
    );
    let metadata: String = conn
        .query_row(
            "SELECT metadata_json FROM sessions WHERE id = 'session:self'",
            [],
            |row| row.get(0),
        )
        .expect("load repaired session metadata");
    let metadata: serde_json::Value =
        serde_json::from_str(&metadata).expect("parse repaired session metadata");
    assert_eq!(
        metadata["sessionTitleGeneratedFromMessageId"],
        "message:local"
    );
    assert_eq!(metadata["fork"]["forkedFromMessageId"], "message:local");
    assert_eq!(
        metadata["fork"]["forkedFromMessageAliases"],
        serde_json::json!(["message:local", "entry:runtime"])
    );
    let cache_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM kv_cache_entries WHERE session_id = 'session:self'",
            [],
            |row| row.get(0),
        )
        .expect("count derived cache rows");
    assert_eq!(cache_count, 0);

    assert!(
        reconcile_canonical_message_mirror_in_db(&conn, "message:local", "message:cloud",)
            .expect("idempotent mirror retry")
    );
}

#[test]
fn completed_cloud_agent_mirror_is_merged_into_the_local_runtime_turn() {
    let conn = test_conn();
    seed_identity(&conn);
    conn.execute_batch(
        "INSERT INTO identities (
             id, kind, display_name, source, avatar_key,
             created_at_ms, updated_at_ms
         ) VALUES
             ('agent:local', 'agent', 'My Kordi', 'local',
              'agent:local', 1, 1),
             ('agent:cloud', 'agent', 'My Kordi', 'local',
              'agent:cloud', 1, 1);
         INSERT INTO sessions (
             id, kind, title, status, created_by_identity_id,
             primary_identity_id, created_at_ms, updated_at_ms,
             last_message_at_ms
         ) VALUES (
             'session:self', 'self-agent', 'Self', 'active',
             'human:me', 'agent:local', 1, 3, 3
         );
         INSERT INTO session_messages (
             id, session_id, sender_identity_id, sender_role,
             message_kind, content_text, parent_message_id,
             status, sequence_num,
             created_at_ms, updated_at_ms, source_transport,
             source_event_id
         ) VALUES
             ('message:request', 'session:self', 'human:me',
              'user', 'text', 'Check the status', NULL,
              'sent', 1, 1, 1, 'desktop-chat', 'runtime:request'),
             ('message:local-agent', 'session:self', 'agent:local',
              'owned-agent', 'agent-turn', 'The completed response',
              'message:request', 'complete', 2, 2, 2,
              'desktop-chat', 'runtime:turn'),
             ('message:cloud-agent', 'session:self', 'agent:cloud',
              'owned-agent', 'agent-turn', 'processing...',
              'message:request', 'processing', 3, 3, 3,
              'cloud-self-agent', 'cloud:response');",
    )
    .expect("seed mirrored agent turn");

    assert!(reconcile_canonical_message_mirror_in_db(
        &conn,
        "message:local-agent",
        "message:cloud-agent",
    )
    .expect("reconcile agent mirror"));

    let rows: Vec<(String, String)> = conn
        .prepare(
            "SELECT id, source_transport
             FROM session_messages
             WHERE sender_role = 'owned-agent'
             ORDER BY sequence_num",
        )
        .expect("prepare message query")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("query messages")
        .collect::<Result<Vec<_>, _>>()
        .expect("collect messages");
    assert_eq!(
        rows,
        vec![(
            "message:local-agent".to_string(),
            "desktop-chat".to_string(),
        )]
    );
}

#[test]
fn committed_cloud_mirror_retry_still_clears_stale_in_memory_rows() {
    let conn = test_conn();
    seed_identity(&conn);
    conn.execute_batch(
        "INSERT INTO identities (
             id, kind, display_name, source, avatar_key,
             created_at_ms, updated_at_ms
         ) VALUES (
             'agent:cloud', 'agent', 'My Kordi', 'cloud',
             'agent:cloud', 1, 1
         );
         INSERT INTO sessions (
             id, kind, title, status, created_by_identity_id,
             primary_identity_id, created_at_ms, updated_at_ms,
             last_message_at_ms
         ) VALUES (
             'session:self', 'self-agent', 'Self', 'active',
             'human:me', 'agent:cloud', 1, 3, 3
         );
         INSERT INTO session_messages (
             id, session_id, sender_identity_id, sender_role,
             message_kind, content_text, parent_message_id,
             status, sequence_num, created_at_ms, updated_at_ms,
             source_transport, source_event_id
         ) VALUES (
             'message:retained-cloud', 'session:self', 'agent:cloud',
             'owned-agent', 'agent-turn', 'Completed response',
             'message:request', 'complete', 2, 2, 2,
             'cloud-self-agent', 'cloud:response'
         );",
    )
    .expect("seed committed Cloud mirror");

    assert!(reconcile_canonical_message_mirror_in_db(
        &conn,
        "message:retained-cloud",
        "message:already-removed-local",
    )
    .expect("retry committed reconciliation"));
}
