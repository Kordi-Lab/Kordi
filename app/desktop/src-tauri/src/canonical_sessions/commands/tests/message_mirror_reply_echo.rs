use super::*;

#[test]
fn exact_cloud_history_reply_echo_retains_identity_and_direct_execution_trace() {
    let conn = test_conn();
    seed_identity(&conn);
    conn.execute_batch(
        "INSERT INTO identities (
             id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms
         ) VALUES ('agent:local', 'agent', 'My Kordi', 'local', 'agent:local', 1, 1);
         INSERT INTO sessions (
             id, kind, title, status, created_by_identity_id, primary_identity_id,
             created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES ('session:self', 'self-agent', 'Self', 'active', 'human:me',
                   'agent:local', 1, 3, 3);
         INSERT INTO session_messages (
             id, session_id, sender_identity_id, sender_role, message_kind,
             content_text, content_json, parent_message_id, status, sequence_num,
             created_at_ms, updated_at_ms, source_transport, source_event_id
         ) VALUES
             ('message:request', 'session:self', 'human:me', 'user', 'text',
              'Check status', '{}', NULL, 'sent', 1, 1, 1,
              'cloud-self-agent', 'wire:request'),
             ('message:native-request', 'session:self', 'human:me', 'user', 'text',
              'Check status', '{\"desktopEntryId\":\"wire:request\"}', NULL,
              'sent', 2, 2, 2, 'desktop-chat', 'runtime:request'),
             ('message:echo', 'session:self', 'agent:local', 'owned-agent',
              'agent-turn', 'Brief response', '{\"requestId\":\"message:request\"}',
              'message:native-request', 'complete', 3, 2, 2,
              'cloud-self-agent', 'wire:echo'),
             ('message:direct', 'session:self', 'agent:local', 'owned-agent',
              'agent-turn', 'Detailed response',
              '{\"cloudRequestMessageId\":\"wire:request\",\"execution\":{\"steps\":1}}',
              NULL, 'complete', 4, 3, 3,
              'cloud-self-agent', 'wire:direct');
         INSERT INTO chat_sync_conversations (
             account_id, conversation_id, client_session_id, version,
             snapshot_json, updated_at_ms
         ) VALUES ('account', 'conversation', 'session:self', 1, '{}', 1);
         INSERT INTO chat_sync_messages (
             account_id, message_id, message_kind, conversation_id,
             conversation_sequence, version, snapshot_json, updated_at_ms
         ) VALUES
             ('account', 'wire:echo', 'canonical-history-agent',
              'conversation', 1, 1,
              '{\"content\":{\"canonical_history\":{\"local_message_id\":\"message:echo\"}}}', 1),
             ('account', 'wire:direct', 'text',
              'conversation', 2, 1, '{}', 2),
             ('account', 'wire:request', 'text',
              'conversation', 3, 1, '{}', 3);",
    )
    .expect("seed exact Cloud reply lineage");

    assert!(
        reconcile_canonical_message_mirror_in_db(&conn, "message:echo", "message:direct",)
            .expect("merge direct response into historical echo")
    );
    let (text, content, parent, source): (String, String, String, String) = conn
        .query_row(
            "SELECT content_text, content_json, parent_message_id, source_event_id
             FROM session_messages WHERE id='message:echo'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    let content: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!(text, "Detailed response");
    assert_eq!(content["execution"]["steps"], 1);
    assert_eq!(content["cloudRequestMessageId"], "wire:request");
    assert_eq!(content["requestId"], "message:request");
    assert_eq!(content["replyToMessageId"], "message:request");
    assert_eq!(parent, "message:request");
    assert_eq!(source, "wire:echo");
    let direct_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE id='message:direct'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(direct_count, 0);
}

#[test]
fn cloud_reply_echo_merge_rejects_unrelated_direct_request() {
    let conn = test_conn();
    seed_identity(&conn);
    conn.execute_batch(
        "INSERT INTO identities (
             id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms
         ) VALUES ('agent:local', 'agent', 'My Kordi', 'local', 'agent:local', 1, 1);
         INSERT INTO sessions (
             id, kind, title, status, created_by_identity_id, primary_identity_id,
             created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES ('session:self', 'self-agent', 'Self', 'active', 'human:me',
                   'agent:local', 1, 3, 3);
         INSERT INTO session_messages (
             id, session_id, sender_identity_id, sender_role, message_kind,
             content_text, content_json, parent_message_id, status, sequence_num,
             created_at_ms, updated_at_ms, source_transport, source_event_id
         ) VALUES
             ('message:request', 'session:self', 'human:me', 'user', 'text',
              'Check status', '{}', NULL, 'sent', 1, 1, 1,
              'cloud-self-agent', 'wire:request'),
             ('message:echo', 'session:self', 'agent:local', 'owned-agent',
              'agent-turn', 'Same text', '{}', 'message:request', 'complete', 2, 2, 2,
              'cloud-self-agent', 'wire:echo'),
             ('message:direct', 'session:self', 'agent:local', 'owned-agent',
              'agent-turn', 'Same text',
              '{\"cloudRequestMessageId\":\"wire:other-request\"}',
              NULL, 'complete', 3, 3, 3,
              'cloud-self-agent', 'wire:direct');
         INSERT INTO chat_sync_conversations (
             account_id, conversation_id, client_session_id, version,
             snapshot_json, updated_at_ms
         ) VALUES ('account', 'conversation', 'session:self', 1, '{}', 1);
         INSERT INTO chat_sync_messages (
             account_id, message_id, message_kind, conversation_id,
             conversation_sequence, version, snapshot_json, updated_at_ms
         ) VALUES
             ('account', 'wire:echo', 'canonical-history-agent',
              'conversation', 1, 1,
              '{\"content\":{\"canonical_history\":{\"local_message_id\":\"message:echo\"}}}', 1),
             ('account', 'wire:direct', 'text',
              'conversation', 2, 1, '{}', 2),
             ('account', 'wire:request', 'text',
              'conversation', 3, 1, '{}', 3);",
    )
    .expect("seed unrelated responses");
    assert!(
        reconcile_canonical_message_mirror_in_db(&conn, "message:echo", "message:direct",).is_err()
    );
}

#[test]
fn cloud_reply_echo_accepts_exact_original_ui_request_client_identity() {
    assert_ui_request_reply_echo(false);
}

#[test]
fn cloud_reply_echo_accepts_restored_history_identity_via_exact_wire_source() {
    assert_ui_request_reply_echo(true);
}

fn assert_ui_request_reply_echo(restored_history_identity: bool) {
    assert_eq!(
        super::super::message_mirror::cloud_request_client_message_id(
            "session:self",
            "message:ui-request"
        ),
        "3283f0f9-f6a4-568e-999b-cdee92c71cce"
    );
    let conn = test_conn();
    seed_identity(&conn);
    conn.execute_batch(
        "INSERT INTO identities (
             id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms
         ) VALUES ('agent:local', 'agent', 'My Kordi', 'local', 'agent:local', 1, 1);
         INSERT INTO sessions (
             id, kind, title, status, created_by_identity_id, primary_identity_id,
             created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES ('session:self', 'self-agent', 'Self', 'active', 'human:me',
                   'agent:local', 1, 3, 3);
         INSERT INTO session_messages (
             id, session_id, sender_identity_id, sender_role, message_kind,
             content_text, content_json, parent_message_id, status, sequence_num,
             created_at_ms, updated_at_ms, source_transport, source_event_id
         ) VALUES
             ('message:ui-request', 'session:self', 'human:me', 'user', 'text',
              'Check status', '{}', NULL, 'sent', 1, 1, 1,
              'desktop-chat-ui', 'ui:request'),
             ('message:echo', 'session:self', 'agent:local', 'owned-agent',
              'agent-turn', 'Response', '{}', 'message:ui-request', 'complete', 2, 2, 2,
              'cloud-self-agent', 'wire:echo'),
             ('message:direct', 'session:self', 'agent:local', 'owned-agent',
              'agent-turn', 'Response',
              '{\"cloudRequestMessageId\":\"wire:request\",\"execution\":{\"steps\":1}}',
              NULL, 'complete', 3, 3, 3,
              'cloud-self-agent', 'wire:direct');
         INSERT INTO chat_sync_conversations (
             account_id, conversation_id, client_session_id, version,
             snapshot_json, updated_at_ms
         ) VALUES ('account', 'conversation', 'session:self', 1, '{}', 1);
         INSERT INTO chat_sync_messages (
             account_id, message_id, client_message_id, message_kind, conversation_id,
             conversation_sequence, version, snapshot_json, updated_at_ms
         ) VALUES
             ('account', 'wire:echo', NULL, 'canonical-history-agent',
              'conversation', 1, 1,
              '{\"content\":{\"canonical_history\":{\"local_message_id\":\"message:echo\"}}}', 1),
             ('account', 'wire:direct', NULL, 'text',
              'conversation', 2, 1, '{}', 2),
             ('account', 'wire:request', '3283f0f9-f6a4-568e-999b-cdee92c71cce', 'text',
              'conversation', 3, 1, '{}', 3);",
    )
    .expect("seed UI request lineage");
    if restored_history_identity {
        conn.execute(
            "UPDATE chat_sync_messages SET snapshot_json =
             '{\"content\":{\"canonical_history\":{\"local_message_id\":\"original:exported-reply\"}}}'
             WHERE message_id = 'wire:echo'",
            [],
        )
        .expect("simulate a historical reply restored under its Cloud identity");
    }
    assert!(
        reconcile_canonical_message_mirror_in_db(&conn, "message:echo", "message:direct")
            .expect("merge response via UI request client identity")
    );
    let parent: String = conn
        .query_row(
            "SELECT parent_message_id FROM session_messages WHERE id='message:echo'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(parent, "message:ui-request");
}

#[test]
fn cloud_reply_echo_keeps_native_request_when_cloud_request_projection_is_absent() {
    let conn = test_conn();
    seed_identity(&conn);
    conn.execute_batch(
        "INSERT INTO identities (
             id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms
         ) VALUES ('agent:local', 'agent', 'My Kordi', 'local', 'agent:local', 1, 1);
         INSERT INTO sessions (
             id, kind, title, status, created_by_identity_id, primary_identity_id,
             created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES ('session:self', 'self-agent', 'Self', 'active', 'human:me',
                   'agent:local', 1, 3, 3);
         INSERT INTO session_messages (
             id, session_id, sender_identity_id, sender_role, message_kind,
             content_text, content_json, parent_message_id, status, sequence_num,
             created_at_ms, updated_at_ms, source_transport, source_event_id
         ) VALUES
             ('message:native-request', 'session:self', 'human:me', 'user', 'text',
              'Hi', '{\"desktopEntryId\":\"wire:request\"}', NULL,
              'sent', 1, 1, 1, 'desktop-chat', 'runtime:request'),
             ('message:echo', 'session:self', 'agent:local', 'owned-agent',
              'agent-turn', 'Hello', '{}', 'message:native-request', 'complete', 2, 2, 2,
              'cloud-self-agent', 'wire:echo'),
             ('message:direct', 'session:self', 'agent:local', 'owned-agent',
              'agent-turn', 'Hello',
              '{\"cloudRequestMessageId\":\"wire:request\",\"execution\":{\"steps\":1}}',
              'message:native-request', 'complete', 3, 3, 3,
              'cloud-self-agent', 'wire:direct');
         INSERT INTO chat_sync_conversations (
             account_id, conversation_id, client_session_id, version,
             snapshot_json, updated_at_ms
         ) VALUES ('account', 'conversation', 'session:self', 1, '{}', 1);
         INSERT INTO chat_sync_messages (
             account_id, message_id, message_kind, conversation_id,
             conversation_sequence, version, snapshot_json, updated_at_ms
         ) VALUES
             ('account', 'wire:request', 'text', 'conversation', 1, 1, '{}', 1),
             ('account', 'wire:direct', 'text', 'conversation', 2, 1, '{}', 2),
             ('account', 'wire:echo', 'canonical-history-agent', 'conversation', 3, 1,
              '{\"content\":{\"canonical_history\":{\"local_message_id\":\"message:echo\"}}}', 3);",
    )
    .expect("seed native-only request and exact Cloud replies");
    assert!(
        reconcile_canonical_message_mirror_in_db(&conn, "message:echo", "message:direct",)
            .expect("merge same-request Cloud replies")
    );
    let (parent, content): (String, String) = conn
        .query_row(
            "SELECT parent_message_id, content_json FROM session_messages WHERE id='message:echo'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let content: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!(parent, "message:native-request");
    assert_eq!(content["execution"]["steps"], 1);
    let user_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_messages WHERE sender_role='user'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(user_count, 1);
}
