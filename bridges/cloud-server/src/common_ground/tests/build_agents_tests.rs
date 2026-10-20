//! Card builds from agent files the app read on the Mac.

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;

use super::db_fixture::{account, app, pool, send};
use super::support::{card_reply, claim, RUNNER};
use crate::common_ground::complete;

const BUILD: &str = "/v1/cloud/common-ground/card/build";

#[tokio::test]
async fn agent_files_feed_the_build_redacted() {
    let Some(pool) = pool().await else {
        return;
    };
    let service = account(&pool, "service").await;
    let app = app(&pool, Some(&service));
    let (alex, token) = super::db_fixture::signed_in(&pool, "Alex").await;

    // Over the total cap: rejected before anything is read.
    let long = "a".repeat(30_001);
    let (status, body) = send(
        &app,
        "POST",
        BUILD,
        &token,
        Some(json!({"agents": [{"label": "A", "text": long}, {"label": "B", "text": long}]})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("common_ground_invalid_build")),
        "{body}"
    );
    assert_eq!(body["message"], "Agent files are too long.", "{body}");

    // Empty files are not a source.
    let (status, body) = send(
        &app,
        "POST",
        BUILD,
        &token,
        Some(json!({"agents": [{"label": "AGENTS.md", "text": "  \n "}]})),
    )
    .await;
    assert_eq!(
        (status, body["errorCode"].as_str()),
        (400, Some("common_ground_no_sources")),
        "{body}"
    );

    let agents = json!([
        {"label": "Codex · AGENTS.md", "text": "# Rules\n\nI build agent memory for Kordi.\nMail ada@example.test, notes in /Users/example/notes.md"},
        {"label": "Empty", "text": ""},
        {"label": "Claude · MEMORY.md", "text": "- Evaluates retrieval with OPENAI_API_KEY=abc123abc123abc123"},
    ]);
    let (status, body) = send(&app, "POST", BUILD, &token, Some(json!({"agents": agents}))).await;
    assert_eq!(status, 202, "{body}");
    assert_eq!(body["used"], json!(["Agents"]));

    let (prompt, stored): (String, Value) = query_as(
        "SELECT run.prompt, card.build_evidence_json FROM cloud_agent_fallback_runs run
         JOIN cloud_common_ground_cards card ON card.active_run_id = run.run_id
         WHERE card.account_id = $1",
    )
    .bind(&alex)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(
        prompt.contains("[0] undated · Agents on this Mac · Codex · AGENTS.md\n# Rules I build agent memory for Kordi."),
        "{prompt}"
    );
    assert!(
        prompt.contains(
            "[1] undated · Agents on this Mac · Claude · MEMORY.md\n- Evaluates retrieval"
        ),
        "{prompt}"
    );
    assert!(
        !prompt.contains("Empty") && !prompt.contains("[2]"),
        "{prompt}"
    );
    for leaked in ["ada@example.test", "/Users/", "abc123abc"] {
        assert!(!prompt.contains(leaked), "{leaked} leaked: {prompt}");
        assert!(!stored.to_string().contains(leaked), "{leaked} stored");
    }
    assert!(
        prompt.contains("[email]") && prompt.contains("[path]"),
        "{prompt}"
    );
    assert_eq!(stored.as_array().map(Vec::len), Some(2));

    let run_id = claim(&pool, &alex).await;
    let reply = card_reply(&["Agent memory"], &["Retrieval"], &[], &[]);
    complete(&pool, &run_id, RUNNER, &reply).await.unwrap();
    let (status, body) = send(&app, "GET", "/v1/cloud/common-ground/card", &token, None).await;
    assert_eq!(status, 200, "{body}");
    let evidence = &body["card"]["profile"]["evidence"]["e1"];
    assert_eq!(evidence["source"], "Agents on this Mac", "{body}");
    assert_eq!(evidence["title"], "Codex · AGENTS.md", "{body}");
    assert_eq!(evidence["date"], Value::Null, "{body}");
}
