//! Helpers for the agent database tests: a state for direct tool calls, a
//! stand-in runner that leases one run, and comment posting.

use std::sync::Arc;

use axum::http::StatusCode;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use uuid::Uuid;

use super::db_fixture::*;
use crate::attachments::S3Config;
use crate::cloud_agent_runtime::runs::lease_canary_run;
use crate::connectors::delivery::{deliver_to_run, LeaseConnectorTool, LeaseHolder};
use crate::connectors::models::{BrokerCallRequest, BrokerCallResponse};
use crate::document_shares::agents::{tools, DOCUMENT_CONNECTOR_ID};
use crate::events::EventBus;
use crate::server::ServerState;

pub(super) async fn state(f: &Fixture) -> Arc<ServerState> {
    let s3 = S3Config {
        endpoint: url::Url::parse(&storage_stub().await).unwrap(),
        region: "us-east-1".into(),
        bucket: "documents".into(),
        access_key: "test-access".into(),
        secret_key: "test-secret".into(),
    };
    Arc::new(ServerState::new(f.pool.clone(), EventBus::noop()).with_s3(s3))
}

pub(super) fn comments_uri(f: &Fixture) -> String {
    format!("/v1/cloud/documents/{}/comments", f.attachment_id)
}

/// Posts a comment as the account behind `token` and returns it.
pub(super) async fn post_comment(f: &Fixture, token: &str, block_id: &str, body: &str) -> Value {
    let (status, comment) = send(
        &f.app,
        "POST",
        &comments_uri(f),
        Some(token),
        Some(json!({ "blockId": block_id, "body": body })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{comment}");
    comment
}

/// `(run_id, owner, requester, agent, trigger, status)` of the runs a
/// comment started.
pub(super) type RunRow = (String, String, String, String, String, String);

pub(super) async fn runs_of(f: &Fixture, comment_id: &str) -> Vec<RunRow> {
    query_as(
        "SELECT run_id, owner_account_id, requester_account_id, execution_agent_id, \
                run_trigger, status \
         FROM cloud_agent_fallback_runs WHERE document_comment_id = $1 ORDER BY created_at",
    )
    .bind(comment_id)
    .fetch_all(&f.pool)
    .await
    .unwrap()
}

pub(super) async fn only_run(f: &Fixture, comment: &Value) -> RunRow {
    let mut runs = runs_of(f, comment["commentId"].as_str().unwrap()).await;
    assert_eq!(runs.len(), 1, "{comment}");
    runs.remove(0)
}

/// Leases `run_id` as a new runner, delivers its tools, and returns the
/// runner id and the tools on the lease.
pub(super) async fn lease(
    f: &Fixture,
    state: &ServerState,
    run_id: &str,
) -> (String, Vec<LeaseConnectorTool>) {
    let runner = format!("runner-doc-{}", Uuid::new_v4().simple());
    let leased = lease_canary_run(&f.pool, &runner, run_id)
        .await
        .unwrap()
        .expect("the queued run is leased");
    assert_eq!(leased.run_id, run_id);
    let tools = deliver_to_run(&f.pool, &state.connectors().providers, run_id).await;
    (runner, tools)
}

pub(super) fn tool_names(tools: &[LeaseConnectorTool]) -> Vec<&str> {
    tools.iter().map(|tool| tool.name.as_str()).collect()
}

/// Calls a document tool the way the cloud runner does, through the broker
/// request shape.
pub(super) async fn call_tool(
    state: &ServerState,
    runner: &str,
    run_id: &str,
    tool: &str,
    args: Value,
) -> (StatusCode, BrokerCallResponse) {
    let request: BrokerCallRequest = serde_json::from_value(json!({
        "leaseId": run_id,
        "runnerId": runner,
        "connectorId": DOCUMENT_CONNECTOR_ID,
        "tool": tool,
        "args": args,
    }))
    .unwrap();
    let holder = LeaseHolder::Runner {
        runner_id: runner.to_string(),
    };
    tools::call(state, &holder, &request).await
}

pub(super) async fn document(f: &Fixture, token: &str) -> Value {
    let uri = format!("/v1/cloud/documents/{}", f.attachment_id);
    let (status, document) = send(&f.app, "GET", &uri, Some(token), None).await;
    assert_eq!(status, StatusCode::OK, "{document}");
    document
}

pub(super) fn comment_in<'a>(document: &'a Value, comment_id: &str) -> &'a Value {
    document["comments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|comment| comment["commentId"] == comment_id)
        .unwrap_or_else(|| panic!("comment {comment_id} in {document}"))
}

pub(super) fn replies_to<'a>(document: &'a Value, comment_id: &str) -> Vec<&'a Value> {
    document["comments"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|comment| comment["parentCommentId"] == comment_id)
        .collect()
}
