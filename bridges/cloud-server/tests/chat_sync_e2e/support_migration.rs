use super::*;

#[tokio::test]
async fn legacy_support_migration_quarantines_only_private_backfill_rows() {
    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping legacy Support migration test");
        return;
    };
    let affected = account(&pool, "legacy-support-affected").await;
    let unaffected = account(&pool, "legacy-support-correct").await;
    let support_owner = account(&pool, "legacy-support-owner").await;
    let affected_conversation = Uuid::now_v7();
    let unaffected_conversation = Uuid::now_v7();
    let affected_session =
        format!("session:direct-system-agent:{affected}:cloud_agent_kordi_support");
    let unaffected_session =
        format!("session:direct-system-agent:{unaffected}:cloud_agent_kordi_support");

    seed_conversation(
        &pool,
        affected_conversation,
        "ai",
        &affected,
        &affected_session,
        &[&affected],
    )
    .await;
    seed_conversation(
        &pool,
        unaffected_conversation,
        "direct",
        &unaffected,
        &unaffected_session,
        &[&unaffected, &support_owner],
    )
    .await;
    query(
        "INSERT INTO cloud_chat_messages (
             message_id, conversation_id, conversation_sequence, sender_account_id,
             client_message_id, request_fingerprint, content
         ) VALUES ($1, $2, 1, $3, $4, 'legacy-support-message', $5)",
    )
    .bind(Uuid::now_v7())
    .bind(affected_conversation)
    .bind(&affected)
    .bind(Uuid::now_v7())
    .bind(json!({ "schema": 1, "blocks": [{ "type": "text", "text": "Private legacy history" }] }))
    .execute(&pool)
    .await
    .expect("seed private Support history");

    let mut transaction = pool.begin().await.expect("begin migration transaction");
    sqlx_core::raw_sql::raw_sql(include_str!(
        "../../migrations/0066_quarantine_legacy_support_conversations.sql"
    ))
    .execute(&mut *transaction)
    .await
    .expect("run legacy Support migration");
    transaction.commit().await.expect("commit migration");

    let quarantined: (String, String, i64, i64) = query_as(
        "SELECT conversation.legacy_session_id, conversation.kind,
                COUNT(DISTINCT member.account_id)::BIGINT,
                COUNT(DISTINCT message.message_id)::BIGINT
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members member USING (conversation_id)
         LEFT JOIN cloud_chat_messages message USING (conversation_id)
         WHERE conversation.conversation_id = $1
         GROUP BY conversation.legacy_session_id, conversation.kind",
    )
    .bind(affected_conversation)
    .fetch_one(&pool)
    .await
    .expect("load quarantined conversation");
    assert!(quarantined.0.starts_with("session:quarantined-support:"));
    assert_eq!(quarantined.1, "ai");
    assert_eq!(quarantined.2, 1);
    assert_eq!(quarantined.3, 1);

    let hidden: (bool,) = query_as(
        "SELECT deleted_at IS NOT NULL
         FROM cloud_account_session_visibility
         WHERE account_id = $1 AND session_id = $2",
    )
    .bind(&affected)
    .bind(&quarantined.0)
    .fetch_one(&pool)
    .await
    .expect("load quarantine visibility");
    assert!(hidden.0);

    let tombstone: (String,) = query_as(
        "SELECT payload ->> 'sessionId'
         FROM cloud_chat_user_sync_events
         WHERE account_id = $1 AND event_type = 'session.deleted'
         ORDER BY stream_seq DESC LIMIT 1",
    )
    .bind(&affected)
    .fetch_one(&pool)
    .await
    .expect("load Support tombstone");
    assert_eq!(tombstone.0, affected_session);

    let unchanged: (String, String, i64) = query_as(
        "SELECT conversation.legacy_session_id, conversation.kind,
                COUNT(member.account_id)::BIGINT
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members member USING (conversation_id)
         WHERE conversation.conversation_id = $1
           AND member.membership_state = 'active'
         GROUP BY conversation.legacy_session_id, conversation.kind",
    )
    .bind(unaffected_conversation)
    .fetch_one(&pool)
    .await
    .expect("load correct Support conversation");
    assert_eq!(unchanged, (unaffected_session, "direct".to_string(), 2));

    let repaired = store::create_conversation_with_trusted_peer(
        &pool,
        &affected,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: affected_session.clone(),
            member_account_ids: vec![support_owner.clone()],
        },
        Some(&support_owner),
    )
    .await
    .expect("create repaired Support conversation");
    assert_eq!(
        repaired.value.legacy_session_id.as_deref(),
        Some(affected_session.as_str())
    );
    assert_eq!(repaired.value.kind, ConversationKind::Direct);
    assert_eq!(repaired.value.members.len(), 2);
}

#[tokio::test]
async fn invalid_support_migration_quarantines_groups_for_every_member() {
    use kordi_cloud_server::support::{
        bootstrap_support_agent, PendingSupportConfig, SupportProviderAuth,
    };

    let Some(pool) = try_pool().await else {
        eprintln!("DATABASE_URL not set — skipping invalid Support migration test");
        return;
    };
    let affected = account(&pool, "group-support-affected").await;
    let unaffected = account(&pool, "group-support-correct").await;
    let support_owner = account(&pool, "group-support-owner").await;
    let unexpected_member = account(&pool, "group-support-unexpected").await;
    let support_email = format!("support-{}@example.test", Uuid::new_v4().simple());
    let support_config = bootstrap_support_agent(
        &pool,
        PendingSupportConfig {
            owner_account_id: support_owner.clone(),
            owner_email: support_email.clone(),
            agent_id: "cloud_agent_kordi_support".to_string(),
            name: "Kordi Support".to_string(),
            subtitle: "Ask questions or suggest improvements".to_string(),
            inbox: support_email,
            provider_auth: SupportProviderAuth::openai_api_key("test-support-key", "gpt-5.6-luna")
                .expect("support provider auth"),
        },
    )
    .await
    .expect("bootstrap system Support agent");
    assert_eq!(support_config.owner_account_id, support_owner);

    let affected_conversation = Uuid::now_v7();
    let unaffected_conversation = Uuid::now_v7();
    let affected_session =
        format!("session:direct-system-agent:{affected}:cloud_agent_kordi_support");
    let unaffected_session =
        format!("session:direct-system-agent:{unaffected}:cloud_agent_kordi_support");
    seed_conversation(
        &pool,
        affected_conversation,
        "group",
        &affected,
        &affected_session,
        &[&affected, &support_owner, &unexpected_member],
    )
    .await;
    seed_conversation(
        &pool,
        unaffected_conversation,
        "direct",
        &unaffected,
        &unaffected_session,
        &[&unaffected, &support_owner],
    )
    .await;
    query(
        "INSERT INTO cloud_chat_messages (
             message_id, conversation_id, conversation_sequence, sender_account_id,
             client_message_id, request_fingerprint, content
         ) VALUES ($1, $2, 1, $3, $4, 'group-support-message', $5)",
    )
    .bind(Uuid::now_v7())
    .bind(affected_conversation)
    .bind(&affected)
    .bind(Uuid::now_v7())
    .bind(json!({ "schema": 1, "blocks": [{ "type": "text", "text": "Retained group history" }] }))
    .execute(&pool)
    .await
    .expect("seed grouped Support history");

    let mut transaction = pool.begin().await.expect("begin migration transaction");
    sqlx_core::raw_sql::raw_sql(include_str!(
        "../../migrations/0067_quarantine_invalid_support_conversations.sql"
    ))
    .execute(&mut *transaction)
    .await
    .expect("run invalid Support migration");
    transaction.commit().await.expect("commit migration");

    let quarantined: (String, String, i64, i64) = query_as(
        "SELECT conversation.legacy_session_id, conversation.kind,
                COUNT(DISTINCT member.account_id)::BIGINT,
                COUNT(DISTINCT message.message_id)::BIGINT
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members member USING (conversation_id)
         LEFT JOIN cloud_chat_messages message USING (conversation_id)
         WHERE conversation.conversation_id = $1
         GROUP BY conversation.legacy_session_id, conversation.kind",
    )
    .bind(affected_conversation)
    .fetch_one(&pool)
    .await
    .expect("load quarantined group conversation");
    assert!(quarantined.0.starts_with("session:quarantined-support:"));
    assert_eq!(quarantined.1, "group");
    assert_eq!(quarantined.2, 3);
    assert_eq!(quarantined.3, 1);

    let hidden: (i64,) = query_as(
        "SELECT COUNT(*)::BIGINT
         FROM cloud_account_session_visibility
         WHERE session_id = $1 AND deleted_at IS NOT NULL",
    )
    .bind(&quarantined.0)
    .fetch_one(&pool)
    .await
    .expect("load group quarantine visibility");
    assert_eq!(hidden.0, 3);

    let tombstones: (i64,) = query_as(
        "SELECT COUNT(*)::BIGINT
         FROM cloud_chat_user_sync_events
         WHERE event_type = 'session.deleted'
           AND payload ->> 'sessionId' = $1",
    )
    .bind(&affected_session)
    .fetch_one(&pool)
    .await
    .expect("load group Support tombstones");
    assert_eq!(tombstones.0, 3);

    let unchanged: (String, String, i64) = query_as(
        "SELECT conversation.legacy_session_id, conversation.kind,
                COUNT(member.account_id)::BIGINT
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members member USING (conversation_id)
         WHERE conversation.conversation_id = $1
           AND member.membership_state = 'active'
         GROUP BY conversation.legacy_session_id, conversation.kind",
    )
    .bind(unaffected_conversation)
    .fetch_one(&pool)
    .await
    .expect("load valid Support conversation");
    assert_eq!(unchanged, (unaffected_session, "direct".to_string(), 2));

    let repaired = store::create_conversation_with_trusted_peer(
        &pool,
        &affected,
        CreateConversationRequest {
            client_operation_id: Uuid::now_v7(),
            kind: ConversationKind::Direct,
            shared_title: None,
            client_session_id: affected_session.clone(),
            member_account_ids: vec![support_owner.clone()],
        },
        Some(&support_owner),
    )
    .await
    .expect("create repaired direct Support conversation");
    assert_eq!(
        repaired.value.legacy_session_id.as_deref(),
        Some(affected_session.as_str())
    );
    assert_eq!(repaired.value.kind, ConversationKind::Direct);
    assert_eq!(repaired.value.members.len(), 2);
}

async fn seed_conversation(
    pool: &PgPool,
    conversation_id: Uuid,
    kind: &str,
    creator: &str,
    session_id: &str,
    members: &[&str],
) {
    query(
        "INSERT INTO cloud_chat_conversations (
             conversation_id, kind, created_by_account_id, client_operation_id,
             creation_fingerprint, legacy_session_id, next_message_sequence,
             latest_message_sequence
         ) VALUES ($1, $2, $3, $4, $5, $6, 2, 1)",
    )
    .bind(conversation_id)
    .bind(kind)
    .bind(creator)
    .bind(Uuid::now_v7())
    .bind(format!("legacy-support-test:{conversation_id}"))
    .bind(session_id)
    .execute(pool)
    .await
    .expect("seed Support conversation");
    for member in members {
        query(
            "INSERT INTO cloud_chat_conversation_members (
                 conversation_id, account_id, role
             ) VALUES ($1, $2, $3)",
        )
        .bind(conversation_id)
        .bind(member)
        .bind(if *member == creator {
            "owner"
        } else {
            "member"
        })
        .execute(pool)
        .await
        .expect("seed Support member");
    }
}
