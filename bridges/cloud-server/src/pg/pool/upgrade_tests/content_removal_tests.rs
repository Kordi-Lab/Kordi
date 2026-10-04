use super::*;

const FORMER: &str = "fixture-former";

struct Seeded {
    conversation: Uuid,
    hidden: Uuid,
    edited: Uuid,
    photo: Uuid,
    deleted: Uuid,
}

async fn insert_message(
    pool: &PgPool,
    conversation: Uuid,
    sequence: i64,
    text: &str,
    version: i32,
    state: &str,
) -> Uuid {
    let message_id = Uuid::new_v4();
    let (edited_at, deleted_at) = match state {
        "edited" => (Some(chrono::Utc::now()), None),
        "deleted" => (None, Some(chrono::Utc::now())),
        _ => (None, None),
    };
    let content = if deleted_at.is_some() {
        json!({"schema": 1, "blocks": []})
    } else {
        json!({"schema": 1, "blocks": [{"type": "text", "text": text}]})
    };
    query("INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,sender_account_id,client_message_id,request_fingerprint,content,version,edited_at,deleted_at) VALUES($1,$2,$3,'fixture-owner',$4,$5,$6,$7,$8,$9)")
        .bind(message_id).bind(conversation).bind(sequence).bind(Uuid::new_v4())
        .bind(format!("fixture-{sequence}")).bind(content).bind(version).bind(edited_at).bind(deleted_at)
        .execute(pool).await.unwrap();
    message_id
}

async fn insert_row(
    pool: &PgPool,
    account: &str,
    event_type: &str,
    message: (Uuid, Uuid),
    version: i32,
    body: Value,
) {
    let (conversation, message_id) = message;
    let mut snapshot = body;
    snapshot["id"] = json!(message_id.to_string());
    snapshot["version"] = json!(version);
    query("INSERT INTO cloud_chat_user_sync_events(account_id,stream_seq,event_id,event_type,conversation_id,entity_id,entity_version,payload) SELECT $1,COALESCE(max(stream_seq),0)+1,$2,$3,$4,$5,$6,$7 FROM cloud_chat_user_sync_events WHERE account_id=$1")
        .bind(account).bind(Uuid::new_v4()).bind(event_type).bind(conversation).bind(message_id).bind(version)
        .bind(json!({"message": snapshot, "conversation": {"id": conversation.to_string()}}))
        .execute(pool).await.unwrap();
}

async fn seed(pool: &PgPool) -> Seeded {
    execute(pool, "INSERT INTO cloud_accounts(account_id,display_name,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES('fixture-former','fixture-former','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','generated','lorelei','fixture-former','fixture',1,'2026-01-01T00:00:00Z')").await;
    let conversation = Uuid::new_v4();
    query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id,next_message_sequence,latest_message_sequence) VALUES($1,'group','fixture-owner',$2,'removal-fixture',$3,5,4)")
        .bind(conversation).bind(Uuid::new_v4()).bind(format!("group:{conversation}"))
        .execute(pool).await.unwrap();
    query("INSERT INTO cloud_chat_conversation_members(conversation_id,account_id,membership_state) VALUES($1,'fixture-owner','active'),($1,'fixture-peer','active'),($1,'fixture-former','left')")
        .bind(conversation).execute(pool).await.unwrap();
    let hidden = insert_message(pool, conversation, 1, "hidden-canary", 1, "live").await;
    let edited = insert_message(pool, conversation, 2, "edited-v2", 2, "edited").await;
    let photo = insert_message(pool, conversation, 3, "photo caption", 2, "edited").await;
    let deleted = insert_message(pool, conversation, 4, "", 2, "deleted").await;
    for id in ["att-removed", "att-kept"] {
        query("INSERT INTO cloud_attachments(attachment_id,owner_account_id,object_key,created_at,finalized_at,content_type,size_bytes) VALUES($1,'fixture-owner',$1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','image/png',100)")
            .bind(id).execute(pool).await.unwrap();
    }
    query("INSERT INTO cloud_chat_message_attachments(message_id,attachment_id,position) VALUES($1,'att-kept',0)")
        .bind(photo).execute(pool).await.unwrap();
    query("INSERT INTO cloud_chat_message_visibility(account_id,message_id) VALUES('fixture-peer',$1)")
        .bind(hidden).execute(pool).await.unwrap();
    let text = |value: &str| json!({"content": {"blocks": [{"type": "text", "text": value}]}, "attachment_ids": []});
    for account in ["fixture-owner", "fixture-peer"] {
        insert_row(
            pool,
            account,
            "message.created",
            (conversation, hidden),
            1,
            text("hidden-canary"),
        )
        .await;
        insert_row(
            pool,
            account,
            "message.created",
            (conversation, edited),
            1,
            text("edited-v1"),
        )
        .await;
        insert_row(
            pool,
            account,
            "message.updated",
            (conversation, edited),
            2,
            text("edited-v2"),
        )
        .await;
        insert_row(
            pool,
            account,
            "message.created",
            (conversation, photo),
            1,
            json!({"attachment_ids": ["att-removed", "att-kept"]}),
        )
        .await;
        insert_row(
            pool,
            account,
            "message.updated",
            (conversation, photo),
            2,
            json!({"attachment_ids": ["att-kept"]}),
        )
        .await;
        insert_row(
            pool,
            account,
            "message.created",
            (conversation, deleted),
            1,
            text("deleted-canary"),
        )
        .await;
    }
    insert_row(
        pool,
        FORMER,
        "message.created",
        (conversation, edited),
        1,
        text("edited-v1"),
    )
    .await;
    execute(pool, "INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES('digest_fixture','digest_fixture','digest','digest','fixture-owner','fixture-owner','completed','Digest prompt text','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    execute(pool, "INSERT INTO cloud_session_artifacts(artifact_activity_id,session_id,artifact_id,name,path,kind,category,summary,created_by_account_id,created_at,updated_at) VALUES('artifactact_fixture','fixture-session','plan.md','plan.md','plan.md','document','artifact','Plan summary','fixture-owner','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").await;
    Seeded {
        conversation,
        hidden,
        edited,
        photo,
        deleted,
    }
}

async fn rows(pool: &PgPool) -> Vec<(String, i64, String, bool, Value)> {
    query_as("SELECT account_id,stream_seq,event_type,critical,payload FROM cloud_chat_user_sync_events ORDER BY account_id,stream_seq")
        .fetch_all(pool).await.unwrap()
}

async fn digest_prompt(pool: &PgPool) -> String {
    query_as::<_, (String,)>(
        "SELECT prompt FROM cloud_agent_fallback_runs WHERE run_id='digest_fixture'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
    .0
}

async fn jobs(pool: &PgPool) -> Vec<(String, Option<Uuid>, Vec<String>)> {
    query_as("SELECT reason,message_id,attachment_ids FROM cloud_content_removal_jobs ORDER BY reason,message_id")
        .fetch_all(pool).await.unwrap()
}

#[tokio::test]
#[ignore = "requires a dedicated PostgreSQL fixture; run scripts/test-cloud-migrations.sh"]
async fn upgrade_from_115_keeps_rows_until_the_operator_backfill_applies() {
    // 115 is the newest version before content removal.
    let pool = fixture(115).await;
    let seeded = seed(&pool).await;
    let before = rows(&pool).await;
    let (first, second) = tokio::join!(apply_migrations(&pool), apply_migrations(&pool));
    first.unwrap();
    second.unwrap();
    latest_version(&pool).await;

    // Deploying changes nothing that already exists.
    assert_eq!(rows(&pool).await, before);
    assert!(jobs(&pool).await.is_empty());
    assert_eq!(digest_prompt(&pool).await, "Digest prompt text");
    let artifact: (Option<String>, Option<String>, bool) = query_as(
        "SELECT summary, archived_at, removed_at IS NULL FROM cloud_session_artifacts \
         WHERE artifact_activity_id = 'artifactact_fixture'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(artifact, (Some("Plan summary".into()), None, true));
    let since = chrono::Utc::now() - chrono::Duration::days(91);
    assert_eq!(
        store::reconcile_deleted_messages(&pool, since, 100)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        store::reconcile_hidden_messages(&pool, since, 100)
            .await
            .unwrap(),
        0
    );
    assert_eq!(rows(&pool).await, before);

    // The dry run reports and still writes nothing.
    let dry = store::backfill_content_removal_history(&pool, false)
        .await
        .unwrap();
    assert_eq!(
        (
            dry.applied,
            dry.photo_removal_jobs,
            dry.removed_photo_attachments,
            dry.hidden_rows
        ),
        (false, 1, 1, 1)
    );
    // Earlier versions: the edited message's two v1 rows plus the former
    // member's, and the photo message's two v1 rows.
    assert_eq!(
        (
            dry.superseded_rows,
            dry.digest_prompts,
            dry.deleted_messages
        ),
        (5, 1, 1)
    );
    assert!(dry.backfill_job_queued);
    assert_eq!(rows(&pool).await, before);
    assert!(jobs(&pool).await.is_empty());

    let applied = store::backfill_content_removal_history(&pool, true)
        .await
        .unwrap();
    assert_eq!(
        (
            applied.photo_removal_jobs,
            applied.hidden_rows,
            applied.superseded_rows,
            applied.digest_prompts
        ),
        (
            dry.photo_removal_jobs,
            dry.hidden_rows,
            dry.superseded_rows,
            dry.digest_prompts
        )
    );
    let after = rows(&pool).await;
    let of = |message: Uuid| {
        after
            .iter()
            .filter(move |row| row.4.to_string().contains(&message.to_string()))
    };
    let hidden_peer = of(seeded.hidden)
        .filter(|row| row.0 == "fixture-peer")
        .collect::<Vec<_>>();
    assert_eq!(hidden_peer.len(), 1);
    assert_eq!(hidden_peer[0].2, "message.hidden");
    assert_eq!(
        hidden_peer[0].4,
        json!({"message_id": seeded.hidden.to_string(), "conversation": {"id": seeded.conversation.to_string()}})
    );
    assert!(of(seeded.hidden)
        .any(|row| row.0 == "fixture-owner" && row.4.to_string().contains("hidden-canary")));
    for row in of(seeded.edited) {
        if row.4.to_string().contains("edited-v2") {
            assert_eq!(row.2, "message.updated");
        } else {
            assert_eq!((row.2.as_str(), row.3), ("message.superseded", false));
            assert!(row.4.get("message").is_none());
        }
    }
    assert_eq!(
        of(seeded.edited)
            .filter(|row| row.2 == "message.superseded")
            .count(),
        3
    );
    assert!(of(seeded.deleted).all(|row| row.4.to_string().contains("deleted-canary")));
    assert!(!of(seeded.photo).any(|row| row.4.to_string().contains("att-removed")));
    assert_eq!(digest_prompt(&pool).await, "");
    assert_eq!(
        jobs(&pool).await,
        vec![
            (
                "attachment_removed".to_string(),
                Some(seeded.photo),
                vec!["att-removed".to_string()]
            ),
            ("backfill".to_string(), None, Vec::new()),
        ]
    );

    // Applying again is a no-op, and repair may now reach the earlier deletion.
    let again = store::backfill_content_removal_history(&pool, true)
        .await
        .unwrap();
    assert_eq!(
        (
            again.photo_removal_jobs,
            again.hidden_rows,
            again.superseded_rows
        ),
        (0, 0, 0)
    );
    assert!(!again.backfill_job_queued);
    assert_eq!(rows(&pool).await, after);
    assert_eq!(
        store::reconcile_deleted_messages(&pool, since, 100)
            .await
            .unwrap(),
        1
    );
    let redacted = rows(&pool).await;
    assert!(!redacted
        .iter()
        .any(|row| row.4.to_string().contains("deleted-canary")));
    assert_eq!(jobs(&pool).await.len(), 3);
}
