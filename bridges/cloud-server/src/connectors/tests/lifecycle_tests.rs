//! Disconnect and event retention.

use super::*;

#[tokio::test]
async fn disconnect_deletes_secret_and_events_and_queues_removal() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (owner, token) = signed_in_account(&pool, "disconnect").await;
    let (other, other_token) = signed_in_account(&pool, "disconnect_other").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    for external in ["evt-1", "evt-2"] {
        events::record_event(
            &pool,
            NewConnectorEvent {
                connector_id: &connector_id,
                provider: STUB.id,
                kind: "item.created",
                external_id: Some(external),
                occurred_at: Utc::now(),
                payload: &json!({ "title": "Standup" }),
            },
        )
        .await
        .unwrap();
    }
    let app = super::super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime),
    ));

    // List shows the connector without any secret-shaped key.
    let list = app
        .clone()
        .oneshot(authed("GET", "/v1/cloud/connectors", &token, None))
        .await
        .unwrap();
    assert_eq!(list.status(), StatusCode::OK);
    let list = body_json(list).await;
    assert_eq!(list["connectors"][0]["connectorId"], connector_id);
    assert_no_secret_keys("GET /v1/cloud/connectors", list);

    // Act cannot be turned on without act scopes.
    let act = app
        .clone()
        .oneshot(authed(
            "POST",
            &format!("/v1/cloud/connectors/{connector_id}/act"),
            &token,
            Some(json!({ "enabled": true })),
        ))
        .await
        .unwrap();
    assert_eq!(act.status(), StatusCode::CONFLICT);

    // Agent grants accept only the account's agents.
    let foreign_agent = app
        .clone()
        .oneshot(authed(
            "PUT",
            &format!("/v1/cloud/connectors/{connector_id}/agents"),
            &token,
            Some(json!({ "agentIds": [store::default_agent_id(&other)] })),
        ))
        .await
        .unwrap();
    assert_eq!(foreign_agent.status(), StatusCode::BAD_REQUEST);
    let own_agent = app
        .clone()
        .oneshot(authed(
            "PUT",
            &format!("/v1/cloud/connectors/{connector_id}/agents"),
            &token,
            Some(json!({ "agentIds": [store::default_agent_id(&owner)] })),
        ))
        .await
        .unwrap();
    assert_eq!(own_agent.status(), StatusCode::OK);
    assert_eq!(
        body_json(own_agent).await["connector"]["agentIds"][0],
        store::default_agent_id(&owner)
    );

    // Another account cannot see or delete it.
    let stranger_delete = app
        .clone()
        .oneshot(authed(
            "DELETE",
            &format!("/v1/cloud/connectors/{connector_id}"),
            &other_token,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(stranger_delete.status(), StatusCode::NOT_FOUND);

    let deleted = app
        .clone()
        .oneshot(authed(
            "DELETE",
            &format!("/v1/cloud/connectors/{connector_id}"),
            &token,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(body_json(deleted).await, json!({ "deletedEvents": 2 }));
    assert!(
        stub.calls().contains(&"revoke".to_string()),
        "provider revoke is attempted; its failure is not fatal"
    );

    let count = |sql: &'static str| {
        let pool = pool.clone();
        let connector_id = connector_id.clone();
        async move {
            let (n,): (i64,) = query_as(sql)
                .bind(&connector_id)
                .fetch_one(&pool)
                .await
                .unwrap();
            n
        }
    };
    assert_eq!(
        count("SELECT COUNT(*) FROM cloud_connector_secrets WHERE connector_id = $1").await,
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM cloud_connector_events WHERE connector_id = $1").await,
        0
    );
    assert_eq!(
        count("SELECT COUNT(*) FROM cloud_connector_agent_grants WHERE connector_id = $1").await,
        0
    );
    assert_eq!(
        count(
            "SELECT COUNT(*) FROM cloud_connector_removal_requests \
             WHERE connector_id = $1 AND processed_at IS NULL"
        )
        .await,
        1
    );
    let (status, revoked_at_set): (String, bool) = query_as(
        "SELECT status, revoked_at IS NOT NULL FROM cloud_connectors WHERE connector_id = $1",
    )
    .bind(&connector_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((status.as_str(), revoked_at_set), ("revoked", true));
    let outcomes = audit_outcomes(&pool, &connector_id).await;
    assert_eq!(
        outcomes.last().unwrap(),
        &("connector.disconnect".to_string(), "completed".to_string())
    );

    // The audit log stays readable, newest first, and paginates.
    let audit = app
        .clone()
        .oneshot(authed(
            "GET",
            &format!("/v1/cloud/connectors/{connector_id}/audit?limit=1"),
            &token,
            None,
        ))
        .await
        .unwrap();
    assert_eq!(audit.status(), StatusCode::OK);
    let audit = body_json(audit).await;
    assert_eq!(audit["entries"][0]["tool"], "connector.disconnect");
    assert!(audit["nextBefore"].is_string());
    assert_no_secret_keys("GET audit", audit);

    // A revoked connector no longer lists, and a reconnect makes a new row.
    let list = body_json(
        app.clone()
            .oneshot(authed("GET", "/v1/cloud/connectors", &token, None))
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(list["connectors"], json!([]));
    let (runtime, _) = stub_runtime();
    let reconnected = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    assert_ne!(reconnected, connector_id);
}

#[tokio::test]
async fn retention_sweep_removes_only_expired_events() {
    let Some(pool) = pool().await else { return };
    let (runtime, _) = stub_runtime();
    let (owner, _) = signed_in_account(&pool, "retention").await;
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    let kept = events::record_event(
        &pool,
        NewConnectorEvent {
            connector_id: &connector_id,
            provider: STUB.id,
            kind: "item.created",
            external_id: None,
            occurred_at: Utc::now(),
            payload: &json!({}),
        },
    )
    .await
    .unwrap();
    let expired = events::record_event(
        &pool,
        NewConnectorEvent {
            connector_id: &connector_id,
            provider: STUB.id,
            kind: "item.created",
            external_id: None,
            occurred_at: Utc::now(),
            payload: &json!({}),
        },
    )
    .await
    .unwrap();
    query("UPDATE cloud_connector_events SET expires_at = now() - interval '1 day' WHERE event_id = $1")
        .bind(&expired)
        .execute(&pool)
        .await
        .unwrap();
    events::sweep_expired_events(&pool, Utc::now())
        .await
        .unwrap();
    let remaining: Vec<(String,)> =
        query_as("SELECT event_id FROM cloud_connector_events WHERE connector_id = $1")
            .bind(&connector_id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(remaining, [(kept,)]);
}
