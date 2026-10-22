//! Kordi documents as a card source, and connector picks by provider.

use chrono::{Duration, Utc};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::db_fixture::{account, app, pool, send, signed_in};

const BUILD: &str = "/v1/cloud/common-ground/card/build";
const DOCUMENTS: &str = "/v1/cloud/common-ground/documents";

/// A finalized attachment with a stored source; returns its id.
async fn document(
    pool: &PgPool,
    owner: &str,
    content_type: &str,
    source: &str,
    age_minutes: i64,
) -> String {
    let id = format!("att_{}", Uuid::new_v4().simple());
    let at = (Utc::now() - Duration::minutes(age_minutes)).to_rfc3339();
    query(
        "INSERT INTO cloud_attachments (attachment_id, owner_account_id, object_key, content_type,
             size_bytes, created_at, finalized_at)
         VALUES ($1, $2, $1, $3, $4, $5, $5)",
    )
    .bind(&id)
    .bind(owner)
    .bind(content_type)
    .bind(source.len() as i64)
    .bind(&at)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_document_contents (attachment_id, source, revision, updated_at)
         VALUES ($1, $2, 1, $3)",
    )
    .bind(&id)
    .bind(source)
    .bind(&at)
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn set(pool: &PgPool, sql: &str, id: &str, value: &str) {
    query(sql).bind(id).bind(value).execute(pool).await.unwrap();
}

/// Records `attachment_id` as written by `owner`'s agent in a run that
/// `requester` asked for.
async fn agent_document(pool: &PgPool, attachment_id: &str, owner: &str, requester: &str) {
    let run_id = format!("run_{}", Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_fallback_runs (run_id, idempotency_key, request_message_id,
             session_id, owner_account_id, requester_account_id, status, prompt, created_at,
             updated_at)
         VALUES ($1, $1, $1, 'chat', $2, $3, 'completed', 'hi', $4, $4)",
    )
    .bind(&run_id)
    .bind(owner)
    .bind(requester)
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_agent_run_documents (attachment_id, run_id, session_id,
             owner_account_id, agent_id, title, file_name, content_type, size_bytes)
         VALUES ($1, $2, 'chat', $3, 'agent', 'Agent plan', 'plan.md', 'text/markdown', 10)",
    )
    .bind(attachment_id)
    .bind(&run_id)
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
}

fn ids(body: &Value) -> Vec<String> {
    body["documents"]
        .as_array()
        .unwrap()
        .iter()
        .map(|doc| doc["attachmentId"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn the_build_reads_only_the_accounts_own_documents() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex_id, alex) = signed_in(&pool, "Alex").await;
    let (priya_id, _) = signed_in(&pool, "Priya").await;

    let plan = document(
        &pool,
        &alex_id,
        "text/markdown",
        "# Plan\n\nI build agent memory. Mail ada@example.test",
        5,
    )
    .await;
    set(
        &pool,
        "UPDATE cloud_attachments SET document_title = $2 WHERE attachment_id = $1",
        &plan,
        "Research plan",
    )
    .await;
    let plain = document(&pool, &alex_id, "text/plain", "Running log", 10).await;
    agent_document(&pool, &plain, &alex_id, &alex_id).await;
    let html = document(&pool, &alex_id, "text/html", "<h1>Page</h1>", 1).await;
    let forwarded = document(&pool, &alex_id, "text/markdown", "Forwarded", 2).await;
    let theirs = document(&pool, &priya_id, "text/markdown", "Priya's notes", 3).await;
    set(
        &pool,
        "UPDATE cloud_attachments SET document_source_attachment_id = $2 WHERE attachment_id = $1",
        &forwarded,
        &theirs,
    )
    .await;
    let asked = document(&pool, &alex_id, "text/markdown", "Priya asked my agent", 4).await;
    agent_document(&pool, &asked, &alex_id, &priya_id).await;
    let unfinished = document(&pool, &alex_id, "text/markdown", "Draft", 6).await;
    query("UPDATE cloud_attachments SET finalized_at = NULL WHERE attachment_id = $1")
        .bind(&unfinished)
        .execute(&pool)
        .await
        .unwrap();

    let (status, body) = send(&app, "GET", DOCUMENTS, &alex, None).await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(ids(&body), vec![plan.clone(), plain.clone()], "{body}");
    assert_eq!(body["documents"][0]["title"], "Research plan");
    assert_eq!(body["documents"][1]["title"], "Agent plan");
    assert_eq!(body["documents"][1]["sizeBytes"], 11);
    assert!(body["documents"][0]["updatedAt"].is_string(), "{body}");

    // Only ineligible ids: nothing to read.
    let refused = [
        html.clone(),
        forwarded.clone(),
        theirs.clone(),
        asked.clone(),
        unfinished.clone(),
    ];
    let (status, body) = send(
        &app,
        "POST",
        BUILD,
        &alex,
        Some(json!({"documents": refused})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("common_ground_no_sources")),
        "{body}"
    );

    let mut picked = vec![plain.clone(), plan.clone()];
    picked.extend(refused.iter().cloned());
    let (status, body) = send(
        &app,
        "POST",
        BUILD,
        &alex,
        Some(json!({"documents": picked})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["used"], json!(["Documents"]), "{body}");
    let (prompt, stored): (String, Value) = query_as(
        "SELECT run.prompt, card.build_evidence_json FROM cloud_agent_fallback_runs run
         JOIN cloud_common_ground_cards card ON card.active_run_id = run.run_id
         WHERE card.account_id = $1",
    )
    .bind(&alex_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        prompt.contains("· Documents · Agent plan\nRunning log"),
        "{prompt}"
    );
    assert!(
        prompt.contains("· Documents · Research plan\n# Plan I build agent memory."),
        "{prompt}"
    );
    assert!(
        !prompt.contains("ada@example.test") && prompt.contains("[email]"),
        "{prompt}"
    );
    for other in ["<h1>", "Forwarded", "Priya's notes", "Priya asked", "Draft"] {
        assert!(!prompt.contains(other), "{other} leaked: {prompt}");
    }
    assert_eq!(stored.as_array().map(Vec::len), Some(2));
    assert_eq!(stored[0]["source"], "Documents");
}

/// A connected `provider` with `count` events, the newest `age_minutes` old.
async fn connector_events(
    pool: &PgPool,
    owner: &str,
    (provider, title): (&str, &str),
    count: i32,
    age_minutes: i32,
) {
    let connector_id = format!("cn_{}", Uuid::new_v4().simple());
    query("INSERT INTO cloud_connectors (connector_id, account_id, provider, status) VALUES ($1, $2, $3, 'connected')")
        .bind(&connector_id)
        .bind(owner)
        .bind(provider)
        .execute(pool)
        .await
        .unwrap();
    query("INSERT INTO cloud_connector_agent_grants (connector_id, agent_id) VALUES ($1, $2)")
        .bind(&connector_id)
        .bind(crate::connectors::store::default_agent_id(owner))
        .execute(pool)
        .await
        .unwrap();
    query(
        "INSERT INTO cloud_connector_events (event_id, connector_id, provider, kind, occurred_at,
             payload, expires_at)
         SELECT $1 || '_' || n, $2, $3, 'message',
                now() - make_interval(mins => $5, secs => n), $4, now() + interval '1 day'
         FROM generate_series(1, $6) n",
    )
    .bind(format!("cnevt_{}", Uuid::new_v4().simple()))
    .bind(&connector_id)
    .bind(provider)
    .bind(json!({"title": title}))
    .bind(age_minutes)
    .bind(count)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn connector_picks_narrow_the_providers() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex_id, alex) = signed_in(&pool, "Alex").await;
    // More recent Gmail events than one build reads, then two older GitHub
    // ones: picking GitHub still reads them.
    let gmail = ("gmail", "Mail about retrieval");
    connector_events(&pool, &alex_id, gmail, 120, 0).await;
    connector_events(&pool, &alex_id, ("github", "PR on agent memory"), 2, 60).await;

    let (status, body) = send(
        &app,
        "POST",
        BUILD,
        &alex,
        Some(json!({"connectors": true, "connectorProviders": ["github"]})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["used"], json!(["GitHub"]), "{body}");
    let (prompt,): (String,) = query_as(
        "SELECT run.prompt FROM cloud_agent_fallback_runs run
         JOIN cloud_common_ground_cards card ON card.active_run_id = run.run_id
         WHERE card.account_id = $1",
    )
    .bind(&alex_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        prompt.contains("PR on agent memory") && !prompt.contains("Mail about"),
        "{prompt}"
    );
    assert!(
        prompt.contains("[1]") && !prompt.contains("[2]"),
        "both GitHub events: {prompt}"
    );

    // Old clients that send no providers read the newest events of every
    // provider, here all Gmail.
    let (_, sam) = signed_in(&pool, "Sam").await;
    let (status, body) = send(&app, "POST", BUILD, &sam, Some(json!({"connectors": true}))).await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("common_ground_no_sources"))
    );
    query("DELETE FROM cloud_common_ground_cards WHERE account_id = $1")
        .bind(&alex_id)
        .execute(&pool)
        .await
        .unwrap();
    let (status, body) = send(
        &app,
        "POST",
        BUILD,
        &alex,
        Some(json!({"connectors": true})),
    )
    .await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["used"], json!(["Gmail"]), "{body}");

    // The capabilities advertise documents and per-profile sources.
    let (status, body) = send(&app, "GET", "/v1/cloud/auth/capabilities", &alex, None).await;
    assert_eq!(
        (status, &body["commonGroundVersion"]),
        (200, &json!(3)),
        "{body}"
    );
}
