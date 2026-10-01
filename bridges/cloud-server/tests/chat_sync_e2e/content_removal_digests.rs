//! Stored digests after a delete, hide, or edit, and digest run prompts.

use super::content_removal::{direct_chat, send_text};
use super::content_removal_worker::{job_ids, settle, FakeObjects};
use super::*;
use serde_json::Value;

fn item(id: &str, source: &str) -> Value {
    json!({"id": id, "title": format!("Item {id}"), "sourceIds": [source], "kind": "open"})
}

fn source(id: &str, text: &str) -> Value {
    json!({"id": id, "text": text, "version": 1, "sessionId": "s", "conversationId": "c"})
}

/// A stored digest for `account` citing `removed` and `kept`.
async fn seed_digest(pool: &PgPool, account: &str, removed: &str, kept: &str, canary: &str) {
    let snapshot = json!({
        "claims": [item("removed-claim", removed), item("kept-claim", kept)],
        "commitments": [item("removed-commitment", removed)],
        "suggestions": [item("kept-suggestion", kept)],
        "calendarCandidates": []
    });
    let evidence = json!({
        "sources": [source(removed, canary), source(kept, "unrelated")],
        "calendarEvents": [],
        "previous": {"claims": [item("older", removed)]},
        "viewerAccountId": account
    });
    query("INSERT INTO cloud_account_digests(account_id,snapshot_json,snapshot_input_json,input_json,input_hash,revision) VALUES($1,$2,$3,$3,'hash',5)")
        .bind(account).bind(snapshot).bind(evidence)
        .execute(pool).await.expect("seed digest");
}

/// (snapshot, saved evidence, input, revision, input hash, marked changed)
async fn digest(pool: &PgPool, account: &str) -> (Value, Value, Value, i64, String, bool) {
    query_as(
        "SELECT snapshot_json, snapshot_input_json, input_json, revision, input_hash, \
                dirty_since IS NOT NULL \
         FROM cloud_account_digests WHERE account_id = $1",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn digest_hints(pool: &PgPool, account: &str) -> i64 {
    let (count,): (i64,) = query_as(
        "SELECT count(*) FROM cloud_chat_user_sync_events \
         WHERE account_id = $1 AND event_type = 'digest.updated'",
    )
    .bind(account)
    .fetch_one(pool)
    .await
    .unwrap();
    count
}

fn item_ids(snapshot: &Value) -> Vec<String> {
    ["claims", "commitments", "suggestions", "calendarCandidates"]
        .iter()
        .flat_map(|list| snapshot[list].as_array().cloned().unwrap_or_default())
        .filter_map(|item| item["id"].as_str().map(ToString::to_string))
        .collect()
}

#[tokio::test]
async fn deleting_a_message_removes_it_from_every_members_digest() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "digest-delete").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let removed = send_text(&pool, &chat, &canary).await;
    let kept = send_text(&pool, &chat, "kept").await;
    for account in [&chat.owner, &chat.peer] {
        seed_digest(
            &pool,
            account,
            &removed.id.to_string(),
            &kept.id.to_string(),
            &canary,
        )
        .await;
    }
    store::delete_message(&pool, &chat.owner, chat.conversation_id, removed.id, true)
        .await
        .unwrap();
    settle(
        &pool,
        &FakeObjects::default(),
        &job_ids(&pool, removed.id).await,
    )
    .await;
    for account in [&chat.owner, &chat.peer] {
        let (snapshot, saved, input, revision, hash, marked) = digest(&pool, account).await;
        assert_eq!(item_ids(&snapshot), vec!["kept-claim", "kept-suggestion"]);
        let saved_ids: Vec<_> = saved["sources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|source| source["id"].clone())
            .collect();
        assert_eq!(saved_ids, vec![json!(kept.id.to_string())]);
        assert!(saved["previous"].is_null());
        assert_eq!(input, json!({}));
        assert_eq!((revision, hash.as_str(), marked), (6, "", true));
        for document in [&snapshot, &saved, &input] {
            let text = document.to_string();
            assert!(!text.contains(&canary) && !text.contains(&removed.id.to_string()));
        }
        assert_eq!(digest_hints(&pool, account).await, 1);
    }
}

#[tokio::test]
async fn a_digest_run_that_read_the_message_is_stopped() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "digest-active-run").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let removed = send_text(&pool, &chat, &canary).await;
    let run_id = format!("digest_{}", Uuid::new_v4().simple());
    let now = chrono::Utc::now().to_rfc3339();
    query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at) VALUES($1,$1,$1,$2,$3,$3,'running',$4,$5,$5)")
        .bind(&run_id).bind(format!("digest:{}", chat.peer)).bind(&chat.peer).bind(&canary).bind(&now)
        .execute(&pool).await.unwrap();
    let input = json!({"sources": [source(&removed.id.to_string(), &canary)], "viewerAccountId": chat.peer});
    query("INSERT INTO cloud_account_digests(account_id,input_json,input_hash,active_run_id) VALUES($1,$2,'hash',$3)")
        .bind(&chat.peer).bind(&input).bind(&run_id)
        .execute(&pool).await.unwrap();

    store::delete_message(&pool, &chat.owner, chat.conversation_id, removed.id, true)
        .await
        .unwrap();
    settle(
        &pool,
        &FakeObjects::default(),
        &job_ids(&pool, removed.id).await,
    )
    .await;
    let (status, error, prompt): (String, Option<String>, String) = query_as(
        "SELECT status, error_code, prompt FROM cloud_agent_fallback_runs WHERE run_id = $1",
    )
    .bind(&run_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (status.as_str(), error.as_deref(), prompt.as_str()),
        ("failed", Some("sources_changed"), "")
    );
    let (active, error, input): (Option<String>, Option<String>, Value) = query_as(
        "SELECT active_run_id, error_code, input_json FROM cloud_account_digests WHERE account_id = $1",
    )
    .bind(&chat.peer)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(active.is_none());
    assert_eq!(error.as_deref(), Some("sources_changed"));
    assert_eq!(input, json!({}));
}

#[tokio::test]
async fn hiding_scrubs_only_the_hiders_digest_and_edits_drop_the_earlier_version() {
    let Some(pool) = try_pool().await else { return };
    let chat = direct_chat(&pool, "digest-hide-edit").await;
    let canary = format!("canary-{}", Uuid::new_v4());
    let hidden = send_text(&pool, &chat, &canary).await;
    let kept = send_text(&pool, &chat, "kept").await;
    for account in [&chat.owner, &chat.peer] {
        seed_digest(
            &pool,
            account,
            &hidden.id.to_string(),
            &kept.id.to_string(),
            &canary,
        )
        .await;
    }
    store::delete_message(&pool, &chat.peer, chat.conversation_id, hidden.id, false)
        .await
        .unwrap();
    settle(
        &pool,
        &FakeObjects::default(),
        &job_ids(&pool, hidden.id).await,
    )
    .await;
    let peer = digest(&pool, &chat.peer).await;
    assert_eq!(item_ids(&peer.0), vec!["kept-claim", "kept-suggestion"]);
    assert!(!peer.1.to_string().contains(&canary));
    let owner = digest(&pool, &chat.owner).await;
    assert_eq!(owner.3, 5, "the sender's digest is unchanged");
    assert!(owner.1.to_string().contains(&canary));

    // The sender edits it: the earlier version leaves the sender's digest.
    store::edit_message(
        &pool,
        &chat.owner,
        chat.conversation_id,
        hidden.id,
        UpdateMessageRequest {
            expected_version: hidden.version,
            text: "edited".into(),
        },
    )
    .await
    .unwrap();
    settle(
        &pool,
        &FakeObjects::default(),
        &job_ids(&pool, hidden.id).await,
    )
    .await;
    let owner = digest(&pool, &chat.owner).await;
    assert_eq!(item_ids(&owner.0), vec!["kept-claim", "kept-suggestion"]);
    assert!(!owner.1.to_string().contains(&canary) && owner.3 == 6);
}

#[tokio::test]
async fn finished_digest_runs_keep_no_prompt() {
    let Some(pool) = try_pool().await else { return };
    let account = account(&pool, "digest-store").await;
    let now = chrono::Utc::now();
    let insert = |run_id: String, status: &'static str| {
        let pool = pool.clone();
        let account = account.clone();
        async move {
            query("INSERT INTO cloud_agent_fallback_runs(run_id,idempotency_key,request_message_id,session_id,owner_account_id,requester_account_id,status,prompt,created_at,updated_at,claimed_by,lease_expires_at) VALUES($1,$1,$1,$2,$3,$3,$4,'stored input',$5,$5,'runner-1',$6)")
                .bind(&run_id).bind(format!("digest:{account}")).bind(&account).bind(status)
                .bind(now.to_rfc3339()).bind((now + chrono::Duration::minutes(5)).to_rfc3339())
                .execute(&pool).await.unwrap();
            run_id
        }
    };
    let input = json!({"sources": [], "calendarEvents": [], "existingTasks": [], "previous": null,
        "locale": "en", "timezone": "UTC", "partial": false, "asOf": now.to_rfc3339(), "viewerAccountId": account});
    let completed = insert(format!("digest_{}", Uuid::new_v4().simple()), "running").await;
    query("INSERT INTO cloud_account_digests(account_id,input_json,input_hash,active_run_id) VALUES($1,$2,'hash',$3)")
        .bind(&account).bind(&input).bind(&completed)
        .execute(&pool).await.unwrap();
    kordi_cloud_server::digest::complete(
        &pool,
        &completed,
        "runner-1",
        r#"{"claims":[],"commitments":[],"suggestions":[],"calendarCandidates":[]}"#,
    )
    .await
    .expect("complete digest run");
    assert_eq!(digest_hints(&pool, &account).await, 1);

    let failed = insert(format!("digest_{}", Uuid::new_v4().simple()), "queued").await;
    query("UPDATE cloud_account_digests SET active_run_id = $2 WHERE account_id = $1")
        .bind(&account)
        .bind(&failed)
        .execute(&pool)
        .await
        .unwrap();
    kordi_cloud_server::digest::fail(&pool, &failed, None, "invalid_output")
        .await
        .unwrap();
    for (run_id, status) in [(completed, "completed"), (failed, "failed")] {
        let row: (String, String) =
            query_as("SELECT status, prompt FROM cloud_agent_fallback_runs WHERE run_id = $1")
                .bind(&run_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(row, (status.to_string(), String::new()));
    }
}
