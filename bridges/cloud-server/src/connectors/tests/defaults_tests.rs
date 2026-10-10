//! A connected service is usable at once: connect grants read and act
//! together, turns acting on, and grants the account's default agent.

use super::*;

fn app_for(pool: &PgPool, runtime: ConnectorRuntime) -> axum::Router {
    super::super::routes::routes(Arc::new(
        ServerState::new(pool.clone(), EventBus::noop()).with_connector_runtime(runtime),
    ))
}

async fn set_act(app: &axum::Router, token: &str, connector_id: &str, enabled: bool) -> Value {
    let response = app
        .clone()
        .oneshot(authed(
            "POST",
            &format!("/v1/cloud/connectors/{connector_id}/act"),
            token,
            Some(json!({ "enabled": enabled })),
        ))
        .await
        .unwrap();
    let status = response.status();
    let body = body_json(response).await;
    assert_eq!(status, StatusCode::OK, "act {enabled}: {body}");
    body
}

async fn list(app: &axum::Router, token: &str) -> Value {
    body_json(
        app.clone()
            .oneshot(authed("GET", "/v1/cloud/connectors", token, None))
            .await
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn connect_turns_act_on_and_grants_the_default_agent() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (owner, token) = signed_in_account(&pool, "defaults_connect").await;
    let app = app_for(&pool, runtime.clone());
    let code = pending_stub_grant(&pool, &runtime, &owner, ConnectorToolGroup::Read, "c1").await;
    let completed = app
        .clone()
        .oneshot(authed(
            "POST",
            "/v1/cloud/connectors/oauth/complete",
            &token,
            Some(json!({ "completionCode": code })),
        ))
        .await
        .unwrap();
    assert_eq!(completed.status(), StatusCode::OK);
    let connector = body_json(completed).await["connector"].clone();
    let default_agent = store::default_agent_id(&owner);
    assert_eq!(connector["readScopes"], json!(["stub.read"]));
    assert_eq!(connector["actScopes"], json!(["stub.act"]));
    assert_eq!(connector["actEnabled"], true);
    assert_eq!(connector["agentIds"], json!([default_agent]));

    // The list route shows the same defaults, and the built-in agent once,
    // marked as the default.
    let listed = list(&app, &token).await;
    assert_eq!(listed["connectors"][0]["actEnabled"], true);
    assert_eq!(listed["connectors"][0]["agentIds"], json!([default_agent]));
    let defaults = listed["agents"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|agent| agent["isDefault"] == true)
        .collect::<Vec<_>>();
    assert_eq!(defaults.len(), 1);
    assert_eq!(defaults[0]["agentId"], default_agent);
    assert_eq!(listed["agents"][0]["agentId"], default_agent);

    // Acting turns off and on again without another OAuth round trip.
    let connector_id = connector["connectorId"].as_str().unwrap().to_string();
    let off = set_act(&app, &token, &connector_id, false).await;
    assert_eq!(off["connector"]["actEnabled"], false);
    let on = set_act(&app, &token, &connector_id, true).await;
    assert_eq!(on["connector"]["actEnabled"], true);
    assert_eq!(stub.calls(), ["exchange:c1"], "no new grant was needed");
    let tools = audit_outcomes(&pool, &connector_id)
        .await
        .into_iter()
        .map(|(tool, _)| tool)
        .collect::<Vec<_>>();
    assert_eq!(
        tools,
        ["oauth.grant", "connector.act_off", "connector.act_on"]
    );
}

#[tokio::test]
async fn read_only_scopes_leave_act_off_until_an_act_grant() {
    let Some(pool) = pool().await else { return };
    let (runtime, stub) = stub_runtime();
    let (owner, token) = signed_in_account(&pool, "defaults_read_only").await;
    let app = app_for(&pool, runtime.clone());
    stub.grant_only_read_scopes(true);
    let connector_id = connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Read).await;
    let record = store::load_account_connector(&pool, &owner, &connector_id)
        .await
        .unwrap()
        .unwrap();
    assert!(record.act_scopes.is_empty() && !record.act_enabled);

    let refused = app
        .clone()
        .oneshot(authed(
            "POST",
            &format!("/v1/cloud/connectors/{connector_id}/act"),
            &token,
            Some(json!({ "enabled": true })),
        ))
        .await
        .unwrap();
    assert_eq!(refused.status(), StatusCode::CONFLICT);
    assert_eq!(body_json(refused).await["errorCode"], "act_not_granted");

    // The person removes every agent; a later act grant keeps that choice.
    store::replace_agent_grants(&pool, &connector_id, &[])
        .await
        .unwrap();
    let auth_url = oauth::start_grant(
        &pool,
        &runtime,
        &owner,
        STUB.id,
        ConnectorToolGroup::Act,
        None,
    )
    .await
    .unwrap();
    assert!(auth_url.contains("stub.act"));
    stub.grant_only_read_scopes(false);
    assert_eq!(
        connect_stub(&pool, &runtime, &owner, ConnectorToolGroup::Act).await,
        connector_id
    );
    let listed = list(&app, &token).await;
    assert_eq!(listed["connectors"][0]["actScopes"], json!(["stub.act"]));
    assert_eq!(listed["connectors"][0]["actEnabled"], true);
    assert_eq!(listed["connectors"][0]["agentIds"], json!([]));
}
