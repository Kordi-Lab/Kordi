//! The owner's "Not now" on the Mac (issue 1712, PR 5): a decline leaves a
//! `denied` row even when the lease lapsed during the five-minute wait, and
//! never runs the tool.

use super::broker_tests::{call, desktop, lease_run_for};
use super::*;
use crate::connectors::declined::{self, DeclinedAuditRequest};

/// tool, outcome, run id, agent id, summary
type AuditRow = (String, String, Option<String>, Option<String>, String);

#[tokio::test]
async fn a_decline_is_audited_after_the_lease_lapsed() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (owner, owner_token) = signed_in_account(&pool, "declined_owner").await;
    let (_, stranger_token) = signed_in_account(&pool, "declined_stranger").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Act).await;
    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();
    let mac = desktop(&owner);
    let (claim, _) = lease_run_for(
        &pool,
        &runtime,
        &owner,
        &owner,
        RunTrigger::PersonStarted,
        &mac,
    )
    .await;
    let before = audit_outcomes(&pool, &connector_id).await.len();

    // The card stayed open past the lease: the lease path refuses.
    query("UPDATE cloud_agent_fallback_runs SET lease_expires_at = $2 WHERE run_id = $1")
        .bind(&claim)
        .bind((Utc::now() - ChronoDuration::seconds(1)).to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();
    let mut on_lease = call(&claim, &connector_id, STUB_ACT_TOOL);
    on_lease.declined_by_owner = true;
    let refused = declined::record_on_lease(&pool, &runtime, &mac, &on_lease).await;
    assert_eq!(refused.error_code(), Some(codes::LEASE_INVALID));
    assert_eq!(audit_outcomes(&pool, &connector_id).await.len(), before);

    // The account route needs no lease.
    let app = super::super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime.clone()),
    ));
    let uri = format!("/v1/cloud/connectors/{connector_id}/audit/declined");
    let body = json!({ "tool": STUB_ACT_TOOL, "summary": "Send\n an email.", "runId": claim });
    let recorded = app
        .clone()
        .oneshot(authed("POST", &uri, &owner_token, Some(body.clone())))
        .await
        .unwrap();
    assert_eq!(recorded.status(), StatusCode::OK);
    let rows: Vec<AuditRow> = query_as(
        "SELECT tool, outcome, run_id, agent_id, summary FROM cloud_connector_audit \
         WHERE connector_id = $1 ORDER BY created_at DESC, audit_id DESC LIMIT 1",
    )
    .bind(&connector_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    let (tool, outcome, run_id, agent_id, summary) = rows[0].clone();
    assert_eq!((tool.as_str(), outcome.as_str()), (STUB_ACT_TOOL, "denied"));
    assert_eq!(run_id.as_deref(), Some(claim.as_str()));
    let (run_agent,): (Option<String>,) =
        query_as("SELECT execution_agent_id FROM cloud_agent_fallback_runs WHERE run_id = $1")
            .bind(&claim)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(agent_id, run_agent);
    assert_eq!(
        summary,
        format!("{} (Send an email.)", declined::DECLINED_SUMMARY)
    );

    // Another account cannot write to this connector's log, and only an
    // `act` tool of the provider can be named.
    let foreign = app
        .clone()
        .oneshot(authed("POST", &uri, &stranger_token, Some(body)))
        .await
        .unwrap();
    assert_eq!(foreign.status(), StatusCode::NOT_FOUND);
    let read_tool = declined::record_for_account(
        &pool,
        &runtime,
        &owner,
        &connector_id,
        &DeclinedAuditRequest {
            tool: STUB_READ_TOOL.into(),
            ..Default::default()
        },
    )
    .await;
    assert!(matches!(
        read_tool,
        Err(declined::DeclinedAuditError::UnknownTool)
    ));
    // A run id the account does not own is not recorded on the row.
    declined::record_for_account(
        &pool,
        &runtime,
        &owner,
        &connector_id,
        &DeclinedAuditRequest {
            tool: STUB_ACT_TOOL.into(),
            summary: String::new(),
            run_id: Some("car_someone_else".into()),
        },
    )
    .await
    .unwrap();
    let (run_id, summary): (Option<String>, String) = query_as(
        "SELECT run_id, summary FROM cloud_connector_audit WHERE connector_id = $1 \
         ORDER BY created_at DESC, audit_id DESC LIMIT 1",
    )
    .bind(&connector_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(run_id, None);
    assert_eq!(summary, declined::DECLINED_SUMMARY);
    assert_eq!(audit_outcomes(&pool, &connector_id).await.len(), before + 2);
    assert!(!stub
        .calls()
        .iter()
        .any(|call| call.starts_with(&format!("execute:{STUB_ACT_TOOL}"))));
}
