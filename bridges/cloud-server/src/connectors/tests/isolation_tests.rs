//! Cross-account isolation, credential value scans, audit wording, and
//! audit paging.

use super::broker_tests::{call, leased_run, runner};
use super::*;

async fn app_for(pool: &PgPool, runtime: ConnectorRuntime) -> axum::Router {
    super::super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime),
    ))
}

#[tokio::test]
async fn another_account_cannot_change_or_read_a_connector() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "isolation_owner").await;
    let (other, other_token) = signed_in_account(&pool, "isolation_other").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Act).await;
    let app = app_for(&pool, runtime).await;
    let audit_before = audit_outcomes(&pool, &connector_id).await;

    let attempts = [
        (
            "POST",
            format!("/v1/cloud/connectors/{connector_id}/act"),
            Some(json!({ "enabled": false })),
        ),
        (
            "PUT",
            format!("/v1/cloud/connectors/{connector_id}/agents"),
            Some(json!({ "agentIds": [store::default_agent_id(&other)] })),
        ),
        (
            "GET",
            format!("/v1/cloud/connectors/{connector_id}/audit"),
            None,
        ),
    ];
    for (method, uri, body) in attempts {
        let response = app
            .clone()
            .oneshot(authed(method, &uri, &other_token, body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method} {uri}");
        assert_eq!(
            body_json(response).await["errorCode"],
            "connector_not_found"
        );
    }
    let record = store::load_account_connector(&pool, &owner, &connector_id)
        .await
        .unwrap()
        .unwrap();
    assert!(record.act_enabled, "act stays on");
    let grants = store::agent_grants(&pool, std::slice::from_ref(&connector_id))
        .await
        .unwrap();
    assert!(!grants.contains_key(&connector_id), "no grant was added");
    assert_eq!(audit_outcomes(&pool, &connector_id).await, audit_before);
}

#[tokio::test]
async fn responses_never_contain_credential_values() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, token) = signed_in_account(&pool, "value_scan").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Act).await;
    store::replace_agent_grants(&pool, &connector_id, &[store::default_agent_id(&owner)])
        .await
        .unwrap();

    // Broker: success, a provider failure, and a denial.
    let (person, _) = leased_run(&pool, &runtime, &owner, RunTrigger::PersonStarted).await;
    let (background, _) = leased_run(&pool, &runtime, &owner, RunTrigger::Background).await;
    let holder = runner();
    let ok = broker::call_connector_tool(
        &pool,
        &runtime,
        &holder,
        &call(&person, &connector_id, STUB_READ_TOOL),
    )
    .await;
    assert!(ok.ok, "{ok:?}");
    let mut failing = call(&person, &connector_id, STUB_READ_TOOL);
    failing.args = json!({ "fail": true });
    let failed = broker::call_connector_tool(&pool, &runtime, &holder, &failing).await;
    assert_eq!(failed.error_code(), Some(codes::PROVIDER_FAILED));
    let blocked = broker::call_connector_tool(
        &pool,
        &runtime,
        &holder,
        &call(&background, &connector_id, STUB_ACT_TOOL),
    )
    .await;
    assert_eq!(blocked.error_code(), Some(codes::BLOCKED_BACKGROUND));
    for (label, response) in [("ok", ok), ("failed", failed), ("blocked", blocked)] {
        let value = serde_json::to_value(&response).unwrap();
        assert_no_stub_credentials(&format!("broker {label}"), &value);
    }

    // The provider failure is audited with fixed wording only.
    let (summary,): (String,) = query_as(
        "SELECT summary FROM cloud_connector_audit \
         WHERE connector_id = $1 AND outcome = 'failed' ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&connector_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(summary, "Failed: The service rejected the request.");

    let app = app_for(&pool, runtime).await;
    for uri in [
        "/v1/cloud/connectors".to_string(),
        format!("/v1/cloud/connectors/{connector_id}/audit?limit=200"),
    ] {
        let response = app
            .clone()
            .oneshot(authed("GET", &uri, &token, None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
        assert_no_stub_credentials(&uri, &body_json(response).await);
    }
}

#[tokio::test]
async fn audit_pages_by_time_and_id_without_gaps() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, token) = signed_in_account(&pool, "audit_paging").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    for index in 0..4 {
        store::insert_audit(
            &pool,
            store::NewAuditEntry {
                connector_id: &connector_id,
                account_id: &owner,
                run_id: None,
                agent_id: None,
                tool: &format!("stub.same_time_{index}"),
                tool_group: ConnectorToolGroup::Read,
                outcome: AuditOutcome::Completed,
                summary: "Completed.",
            },
        )
        .await
        .unwrap();
    }
    // Every row shares one timestamp, so only the audit id orders them.
    query("UPDATE cloud_connector_audit SET created_at = '2026-01-01T00:00:00.123456Z' WHERE connector_id = $1")
        .bind(&connector_id)
        .execute(&pool)
        .await
        .unwrap();
    let app = app_for(&pool, runtime).await;
    let mut seen = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let uri = match &before {
            Some(cursor) => {
                format!("/v1/cloud/connectors/{connector_id}/audit?limit=2&before={cursor}")
            }
            None => format!("/v1/cloud/connectors/{connector_id}/audit?limit=2"),
        };
        let page = body_json(
            app.clone()
                .oneshot(authed("GET", &uri, &token, None))
                .await
                .unwrap(),
        )
        .await;
        for entry in page["entries"].as_array().unwrap() {
            seen.push(entry["auditId"].as_str().unwrap().to_string());
        }
        match page["nextBefore"].as_str() {
            Some(cursor) => before = Some(cursor.to_string()),
            None => break,
        }
    }
    let mut expected: Vec<(String,)> = query_as(
        "SELECT audit_id FROM cloud_connector_audit WHERE connector_id = $1 \
         ORDER BY audit_id DESC",
    )
    .bind(&connector_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(expected.len(), 5, "grant row plus four inserted rows");
    assert_eq!(
        seen,
        expected.drain(..).map(|(id,)| id).collect::<Vec<_>>(),
        "every entry appears once, in order"
    );

    let bad = app
        .oneshot(authed(
            "GET",
            &format!("/v1/cloud/connectors/{connector_id}/audit?before=2026-01-01T00:00:00Z"),
            &token,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(bad.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn audit_cursor_round_trips_time_and_id() {
    let created = "2026-01-01T00:00:00.123456+00:00";
    let cursor = store::encode_audit_cursor(created, "cnaud_x");
    let (time, id) = store::decode_audit_cursor(&cursor).unwrap();
    assert_eq!(time.to_rfc3339(), created);
    assert_eq!(id, "cnaud_x");
    assert!(store::decode_audit_cursor("2026-01-01T00:00:00Z").is_none());
    assert!(store::decode_audit_cursor("").is_none());
}
