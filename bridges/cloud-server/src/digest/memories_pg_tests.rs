//! Digest memories against a task-owned Postgres database.

use super::*;
use sqlx_core::query::query;

async fn account(pool: &PgPool, id: &str) {
    query("INSERT INTO cloud_accounts(account_id,created_at,updated_at,avatar_source,avatar_style,avatar_seed,avatar_renderer_version,avatar_version,avatar_updated_at) VALUES($1,$2,$2,'generated','lorelei',$1,'test',1,$2)")
        .bind(id)
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await
        .unwrap();
}

async fn group(pool: &PgPool, creator: &str, members: &[&str]) -> uuid::Uuid {
    let id = uuid::Uuid::new_v4();
    query("INSERT INTO cloud_chat_conversations(conversation_id,kind,created_by_account_id,client_operation_id,creation_fingerprint,legacy_session_id) VALUES($1,'group',$2,$3,'test',$4)")
        .bind(id).bind(creator).bind(uuid::Uuid::new_v4()).bind(format!("session:group:{id}"))
        .execute(pool).await.unwrap();
    for member in members {
        query(
            "INSERT INTO cloud_chat_conversation_members(conversation_id,account_id) VALUES($1,$2)",
        )
        .bind(id)
        .bind(member)
        .execute(pool)
        .await
        .unwrap();
    }
    id
}

async fn texts(pool: &PgPool, owner: &str) -> Vec<(String, String, String, String, String)> {
    query_as("SELECT scope,scope_id,text,source,declaration_type FROM cloud_account_memories WHERE owner_account_id=$1 AND archived_at IS NULL ORDER BY created_at,memory_id")
        .bind(owner)
        .fetch_all(pool)
        .await
        .unwrap()
}

async fn skips(pool: &PgPool, owner: &str) -> Vec<String> {
    let rows: Vec<(String,)> = query_as("SELECT metadata_json FROM cloud_audit_events WHERE account_id=$1 AND event_type='digest_memory_skipped' ORDER BY created_at,event_id")
        .bind(owner)
        .fetch_all(pool)
        .await
        .unwrap();
    let mut reasons: Vec<_> = rows
        .into_iter()
        .map(|(row,)| {
            serde_json::from_str::<Value>(&row).unwrap()["reason"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    reasons.sort();
    reasons
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn postgres_digest_memories_are_checked_and_saved() {
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool)
        .await
        .expect("migrate test database");
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let owner = format!("digest-memory-owner-{suffix}");
    let other = format!("digest-memory-other-{suffix}");
    for id in [&owner, &other] {
        account(&pool, id).await;
    }
    let shared = group(&pool, &other, &[&owner, &other]).await;
    let foreign = group(&pool, &other, &[&other]).await;
    let shared_session = format!("session:group:{shared}");
    let foreign_session = format!("session:group:{foreign}");
    let mut sources = vec![
        source("own-1", "chat", &owner),
        source("own-2", "chat", &owner),
        source("theirs", "chat", &other),
        source("group-msg", &shared_session, &other),
        source("foreign-msg", &foreign_session, &other),
    ];
    sources[3].conversation_id = shared.to_string();
    sources[4].conversation_id = foreign.to_string();
    let with_text = |mut memory: DigestMemory, text: &str| {
        memory.text = text.into();
        memory
    };

    // Saving, scoping and the owner-sent check.
    let saved = save_all(
        &pool,
        "digest_run_1",
        &owner,
        &sources,
        vec![
            with_text(memory("global", None, &["own-1"]), "Prefers short replies"),
            with_text(
                memory("conversation", Some("chat"), &["own-2"]),
                "Works on the launch plan",
            ),
            with_text(
                memory("group", Some(&shared_session), &["group-msg"]),
                "The group ships on Fridays",
            ),
        ],
    )
    .await;
    assert_eq!(saved, 3);
    let rows = texts(&pool, &owner).await;
    assert_eq!(rows.len(), 3);
    assert!(rows.contains(&(
        "global".into(),
        "account".into(),
        "Prefers short replies".into(),
        "digest".into(),
        "model-inferred".into()
    )));
    assert!(rows.contains(&(
        "conversation".into(),
        "chat".into(),
        "Works on the launch plan".into(),
        "digest".into(),
        "model-inferred".into()
    )));
    assert!(rows.contains(&(
        "group".into(),
        shared.to_string(),
        "The group ships on Fridays".into(),
        "digest".into(),
        "model-inferred".into()
    )));
    assert!(skips(&pool, &owner).await.is_empty());

    // Duplicates in the scope (any case), group rules, the owner-sent check
    // and the cap of three per reply.
    let saved = save_all(
        &pool,
        "digest_run_2",
        &owner,
        &sources,
        vec![
            with_text(
                memory("global", None, &["own-1"]),
                "  PREFERS SHORT REPLIES ",
            ),
            with_text(
                memory("group", Some(&foreign_session), &["foreign-msg"]),
                "Not my group",
            ),
            with_text(
                memory("conversation", Some("chat"), &["theirs"]),
                "Someone else's fact",
            ),
            with_text(memory("global", None, &["own-2"]), "Too many"),
        ],
    )
    .await;
    assert_eq!(saved, 0);
    assert_eq!(
        skips(&pool, &owner).await,
        [
            "duplicate",
            "not_an_active_group",
            "not_owner_message",
            "too_many"
        ]
    );
    let saved = save_all(
        &pool,
        "digest_run_3",
        &owner,
        &sources,
        vec![
            with_text(memory("global", None, &["own-1"]), "Likes tea"),
            with_text(memory("global", None, &["own-1"]), "likes tea"),
            with_text(
                memory("global", None, &["own-2"]),
                "My password is hunter2-secret",
            ),
        ],
    )
    .await;
    assert_eq!(saved, 1);
    assert_eq!(
        skips(&pool, &owner)
            .await
            .iter()
            .filter(|r| *r == "duplicate")
            .count(),
        2
    );
    assert!(skips(&pool, &owner)
        .await
        .contains(&"memory_rejected".to_owned()));

    // The input lists the owner's memories, newest first.
    let input = crate::digest::store::input(&pool, &owner, "en", "UTC", None)
        .await
        .unwrap();
    assert_eq!(input.memories.len(), 4);
    assert_eq!(input.memories[0].text, "Likes tea");
    assert!(input
        .memories
        .iter()
        .any(|m| m.scope == "group" && m.scope_id == shared.to_string()));

    // With memory off nothing is saved and nothing is listed.
    query("INSERT INTO cloud_account_memory_settings(account_id,memory_enabled) VALUES($1,FALSE)")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    let saved = save_all(
        &pool,
        "digest_run_4",
        &owner,
        &sources,
        vec![with_text(
            memory("global", None, &["own-1"]),
            "Anything new",
        )],
    )
    .await;
    assert_eq!(saved, 0);
    assert!(skips(&pool, &owner)
        .await
        .contains(&"memory_disabled".to_owned()));
    assert!(existing(&pool, &owner).await.is_empty());

    for id in [&owner, &other] {
        query("DELETE FROM cloud_audit_events WHERE account_id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
    query("DELETE FROM cloud_chat_conversations WHERE conversation_id=ANY($1)")
        .bind(vec![shared, foreign])
        .execute(&pool)
        .await
        .unwrap();
    for id in [&owner, &other] {
        query("DELETE FROM cloud_accounts WHERE account_id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
}

#[tokio::test]
#[ignore = "requires a task-owned PostgreSQL database in KORDI_DIGEST_TEST_DATABASE_URL"]
async fn postgres_completion_saves_memories_outside_the_snapshot() {
    let url =
        std::env::var("KORDI_DIGEST_TEST_DATABASE_URL").expect("isolated test database required");
    let pool = sqlx_postgres::PgPoolOptions::new()
        .max_connections(2)
        .connect(&url)
        .await
        .expect("connect isolated database");
    crate::pg::pool::apply_migrations(&pool)
        .await
        .expect("migrate test database");
    let owner = format!("digest-memory-run-{}", uuid::Uuid::new_v4().simple());
    let friend = format!("digest-memory-friend-{}", uuid::Uuid::new_v4().simple());
    account(&pool, &owner).await;
    account(&pool, &friend).await;
    let conversation = group(&pool, &owner, &[&owner, &friend]).await;
    let message = uuid::Uuid::new_v4();
    query("INSERT INTO cloud_chat_messages(message_id,conversation_id,conversation_sequence,sender_account_id,client_message_id,request_fingerprint,content) VALUES($1,$2,1,$3,$4,'test',$5)")
        .bind(message).bind(conversation).bind(&owner).bind(uuid::Uuid::new_v4())
        .bind(json!({"blocks":[{"type":"text","text":"From now on, keep my summaries short."}]}))
        .execute(&pool).await.unwrap();
    crate::digest::store::initialize_preferences(&pool, &owner, "en", "UTC")
        .await
        .unwrap();
    let input = crate::digest::store::input(&pool, &owner, "en", "UTC", None)
        .await
        .unwrap();
    assert_eq!(input.sources.len(), 1);
    let run = format!("digest_{}", uuid::Uuid::new_v4().simple());
    let now = chrono::Utc::now();
    query("UPDATE cloud_account_digests SET input_json=$2,active_run_id=$3 WHERE account_id=$1")
        .bind(&owner)
        .bind(serde_json::to_value(&input).unwrap())
        .bind(&run)
        .execute(&pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,claimed_by,lease_expires_at,created_at,updated_at) VALUES($1,$1,$1,'digest:test',$2,$2,'running','test','test-runner',$3,$4,$4)")
        .bind(&run).bind(&owner).bind((now + chrono::Duration::minutes(5)).to_rfc3339()).bind(now.to_rfc3339())
        .execute(&pool).await.unwrap();
    let reply = json!({"claims":[],"commitments":[],"suggestions":[],"calendarCandidates":[],
        "memories":[{"text":"Wants short summaries","category":"general_preferences","confidence":"high",
        "scope":"global","sourceMessageIds":[message.to_string()]},
        {"text":"Unsupported","category":"general_preferences","confidence":"low",
        "scope":"global","sourceMessageIds":["not-in-snapshot"]}]});
    crate::digest::store::complete(&pool, &run, "test-runner", &reply.to_string())
        .await
        .unwrap();
    let (snapshot, active): (Value, Option<String>) = query_as(
        "SELECT snapshot_json,active_run_id FROM cloud_account_digests WHERE account_id=$1",
    )
    .bind(&owner)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(active.is_none(), "the digest completes");
    assert!(
        snapshot.get("memories").is_none(),
        "memories are not kept in the digest"
    );
    let rows = texts(&pool, &owner).await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].2, "Wants short summaries");
    assert_eq!(skips(&pool, &owner).await, ["unknown_source"]);

    query("DELETE FROM cloud_agent_fallback_runs WHERE run_id=$1")
        .bind(&run)
        .execute(&pool)
        .await
        .unwrap();
    query("DELETE FROM cloud_audit_events WHERE account_id=$1")
        .bind(&owner)
        .execute(&pool)
        .await
        .unwrap();
    query("DELETE FROM cloud_chat_conversations WHERE conversation_id=$1")
        .bind(conversation)
        .execute(&pool)
        .await
        .unwrap();
    for id in [&owner, &friend] {
        query("DELETE FROM cloud_accounts WHERE account_id=$1")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
}
