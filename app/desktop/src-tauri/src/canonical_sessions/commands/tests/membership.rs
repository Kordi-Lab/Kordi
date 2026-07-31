use super::*;

#[test]
fn participant_queries_map_the_durable_last_read_sequence() {
    let conn = test_conn();
    seed_identity(&conn);
    conn.execute(
        "INSERT INTO sessions (
            id, kind, title, status, created_by_identity_id,
            created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES ('session:one', 'group', 'One', 'active', 'human:me', 1, 7, 7)",
        [],
    )
    .expect("seed session");
    conn.execute(
        "INSERT INTO session_messages (
            id, session_id, sender_identity_id, sender_role, message_kind,
            content_text, status, sequence_num, created_at_ms, updated_at_ms
         ) VALUES ('message:seven', 'session:one', 'human:me', 'user', 'text',
                   'Seven', 'sent', 7, 7, 7)",
        [],
    )
    .expect("seed cursor message");
    conn.execute(
        "INSERT INTO session_participants (
            session_id, identity_id, role, state, added_at_ms,
            last_seen_at_ms, last_read_message_id
         ) VALUES ('session:one', 'human:me', 'self', 'active', 1, 7, 'message:seven')",
        [],
    )
    .expect("seed participant cursor");

    let catalog = load_catalog_from_db(&conn).expect("load catalog");
    assert_eq!(catalog.participants[0].last_read_sequence_num, Some(7));
    let state = load_state_from_db(&conn).expect("load full state");
    assert_eq!(state.participants[0].last_read_sequence_num, Some(7));
    let session_participants =
        select_session_participants(&conn, "session:one").expect("load session participants");
    assert_eq!(session_participants[0].last_read_sequence_num, Some(7));

    conn.execute(
        "UPDATE session_participants
         SET last_read_message_id = 'message:missing'
         WHERE session_id = 'session:one' AND identity_id = 'human:me'",
        [],
    )
    .expect("seed missing cursor message");
    let catalog = load_catalog_from_db(&conn).expect("load catalog with missing cursor");
    assert_eq!(catalog.participants[0].last_read_sequence_num, None);
}

#[test]
fn group_member_batch_updates_all_sessions_atomically_and_returns_only_changed_rows() {
    let mut conn = test_conn();
    seed_identity(&conn);
    conn.execute(
        "INSERT INTO identities (
            id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms
         ) VALUES ('human:owner', 'human', 'Owner', 'bridge', 'human:owner', 1, 1)",
        [],
    )
    .expect("seed owner identity");
    conn.execute(
        "INSERT INTO identities (
            id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms
         ) VALUES ('human:peer', 'human', 'Peer', 'bridge', 'human:peer', 1, 1)",
        [],
    )
    .expect("seed peer identity");
    for session_id in ["session:group:parent", "session:group:child"] {
        conn.execute(
            "INSERT INTO sessions (
                id, kind, title, status, created_by_identity_id,
                metadata_json, created_at_ms, updated_at_ms
             ) VALUES (?1, 'group', ?2, 'active', 'human:owner', '{}', 1, 1)",
            params![session_id, session_id],
        )
        .expect("seed group session");
        conn.execute(
            "INSERT INTO session_participants (
                session_id, identity_id, role, state, added_at_ms
             ) VALUES (?1, 'human:me', 'person', 'active', 1)",
            [session_id],
        )
        .expect("seed regular group member");
    }
    conn.execute(
        "UPDATE sessions
         SET metadata_json = '{\"concurrentField\":\"keep\",\"initialContactIds\":[\"cloud:old\"]}'
         WHERE id = 'session:group:parent'",
        [],
    )
    .expect("seed concurrent metadata");

    let delta = add_canonical_group_members_in_db(
        &mut conn,
        AddCanonicalGroupMembersRequest {
            sessions: vec![
                CanonicalGroupMembershipUpdate {
                    session_id: "session:group:parent".to_string(),
                    group_space_id: "session:group:parent".to_string(),
                    added_contact_ids: vec!["cloud:peer".to_string()],
                    added_participant_names: vec!["Peer".to_string()],
                },
                CanonicalGroupMembershipUpdate {
                    session_id: "session:group:child".to_string(),
                    group_space_id: "session:group:parent".to_string(),
                    added_contact_ids: vec!["cloud:peer".to_string()],
                    added_participant_names: vec!["Peer".to_string()],
                },
            ],
            identity_ids: vec!["human:peer".to_string()],
            added_by_identity_id: "human:me".to_string(),
            join_events: vec![CanonicalGroupMemberJoinEvent {
                event_id: "invite_peer_1".to_string(),
                member_identity_id: "human:peer".to_string(),
                created_at_ms: 42,
            }],
        },
    )
    .expect("batch group member update");

    assert_eq!(delta.sessions.len(), 2);
    assert_eq!(delta.participants.len(), 4);
    assert_eq!(delta.messages.len(), 2);
    assert!(delta.messages.iter().all(|message| {
        message.sender_role == "system"
            && message.message_kind == "status"
            && message.content_text == "Peer joined the group, invited by Me."
            && message.source_transport.as_deref() == Some("group-member-join")
    }));
    assert_eq!(
        delta
            .messages
            .iter()
            .map(|message| message.session_id.as_str())
            .collect::<HashSet<_>>(),
        HashSet::from(["session:group:parent", "session:group:child"])
    );
    assert!(delta.sessions.iter().all(|session| session
        .metadata
        .as_ref()
        .and_then(|value| value.get("groupSpaceId"))
        .and_then(|value| value.as_str())
        == Some("session:group:parent")));
    let parent_metadata = delta
        .sessions
        .iter()
        .find(|session| session.id == "session:group:parent")
        .and_then(|session| session.metadata.as_ref())
        .expect("parent metadata");
    assert_eq!(
        parent_metadata
            .get("concurrentField")
            .and_then(|value| value.as_str()),
        Some("keep")
    );
    assert_eq!(
        parent_metadata
            .get("initialContactIds")
            .and_then(|value| value.as_array())
            .map(Vec::len),
        Some(2)
    );
    assert!(
        delta
            .participants
            .iter()
            .filter(|participant| participant.identity_id == "human:peer")
            .count()
            == 2
    );
}

#[test]
fn group_member_batch_rolls_back_every_session_when_inviter_is_not_a_member() {
    let mut conn = test_conn();
    seed_identity(&conn);
    conn.execute_batch(
        "INSERT INTO identities (
            id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms
         ) VALUES ('human:peer', 'human', 'Peer', 'bridge', 'human:peer', 1, 1);
         INSERT INTO identities (
            id, kind, display_name, source, avatar_key, created_at_ms, updated_at_ms
         ) VALUES ('human:other', 'human', 'Other', 'local', 'human:other', 1, 1);
         INSERT INTO sessions (
            id, kind, title, status, created_by_identity_id,
            metadata_json, created_at_ms, updated_at_ms
         ) VALUES ('session:allowed', 'group', 'Allowed', 'active', 'human:other', '{}', 1, 1);
         INSERT INTO sessions (
            id, kind, title, status, created_by_identity_id,
            metadata_json, created_at_ms, updated_at_ms
         ) VALUES ('session:denied', 'group', 'Denied', 'active', 'human:other', '{}', 1, 1);
         INSERT INTO session_participants (
            session_id, identity_id, role, state, added_at_ms
         ) VALUES ('session:allowed', 'human:me', 'person', 'active', 1);
         INSERT INTO session_participants (
            session_id, identity_id, role, state, added_at_ms
         ) VALUES ('session:denied', 'human:other', 'admin', 'active', 1);",
    )
    .expect("seed rollback groups");

    let result = add_canonical_group_members_in_db(
        &mut conn,
        AddCanonicalGroupMembersRequest {
            sessions: vec![
                CanonicalGroupMembershipUpdate {
                    session_id: "session:allowed".to_string(),
                    group_space_id: "session:allowed".to_string(),
                    added_contact_ids: vec!["cloud:peer".to_string()],
                    added_participant_names: vec!["Peer".to_string()],
                },
                CanonicalGroupMembershipUpdate {
                    session_id: "session:denied".to_string(),
                    group_space_id: "session:denied".to_string(),
                    added_contact_ids: vec!["cloud:peer".to_string()],
                    added_participant_names: vec!["Peer".to_string()],
                },
            ],
            identity_ids: vec!["human:peer".to_string()],
            added_by_identity_id: "human:me".to_string(),
            join_events: vec![CanonicalGroupMemberJoinEvent {
                event_id: "invite_peer_rollback".to_string(),
                member_identity_id: "human:peer".to_string(),
                created_at_ms: 42,
            }],
        },
    );

    assert!(result
        .expect_err("outsider cannot invite people")
        .contains("Only group members can invite people to this group"));
    let inserted_count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM session_participants WHERE identity_id = 'human:peer'",
            [],
            |row| row.get(0),
        )
        .expect("count rolled back participants");
    assert_eq!(inserted_count, 0);
    let notice_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM session_messages", [], |row| {
            row.get(0)
        })
        .expect("count rolled back notices");
    assert_eq!(notice_count, 0);
}
