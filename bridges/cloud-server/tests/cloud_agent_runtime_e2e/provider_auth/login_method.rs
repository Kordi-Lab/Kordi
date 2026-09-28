//! The optional login `method`: `api-key` asks a provider that also offers
//! OAuth for a pasted key instead. Every credential below is synthetic.

use kordi_cloud_server::cloud_agent_runtime::provider_auth::{
    EnvProviderAuthCipher, ProviderAuthCipher,
};

use super::login_session::{
    assert_no_material, login_request, login_router, session_status, start_login,
};
use super::omp_worker::mock_worker;
use super::*;

#[tokio::test]
async fn provider_login_api_key_method_saves_an_anthropic_key() {
    let Some(pool) = try_pool().await else { return };
    let (worker, _worker_env) = mock_worker().await;
    let router = login_router(&pool);
    let owner = signup(&router, "provider-login-method-owner", "Owner").await;

    for body in [
        json!({ "provider": "anthropic", "label": "Keys", "method": "password" }),
        json!({ "provider": "anthropic", "label": "Keys", "method": 7 }),
        json!({ "provider": "openai-codex", "label": "Keys", "mode": "device", "method": "api-key" }),
    ] {
        let (status, rejected) =
            login_request(&router, &owner.token, "POST", "/start", Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{rejected}");
        assert_eq!(rejected["errorCode"], "invalid_login_input");
    }

    let session_id = start_login(
        &router,
        &owner.token,
        json!({ "provider": "anthropic", "label": "Anthropic key", "method": "api-key" }),
    )
    .await;
    assert_eq!(worker.login(&session_id).unwrap().method, "api-key");
    assert_eq!(session_status(&pool, &session_id).await, "running");
    let method: (String,) = sqlx_core::query_as::query_as(
        "SELECT method FROM cloud_agent_provider_login_sessions WHERE session_id = $1",
    )
    .bind(&session_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(method.0, "api-key");

    let (status, waiting) = login_request(
        &router,
        &owner.token,
        "GET",
        &format!("/{session_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{waiting}");
    assert_eq!(waiting["status"], "awaiting-input");
    assert_eq!(waiting["step"]["type"], "api-key");
    let (status, _) = login_request(
        &router,
        &owner.token,
        "POST",
        &format!("/{session_id}/input"),
        Some(json!({ "value": "synthetic-anthropic-key" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, completed) = login_request(
        &router,
        &owner.token,
        "GET",
        &format!("/{session_id}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{completed}");
    assert_no_material(&completed);
    assert_eq!(completed["snapshot"]["provider"], "anthropic");
    assert_eq!(completed["snapshot"]["label"], "Anthropic key");

    let encrypted: (Vec<u8>,) = sqlx_core::query_as::query_as(
        "SELECT encrypted_payload FROM cloud_agent_provider_auth_snapshots WHERE snapshot_id = $1",
    )
    .bind(completed["snapshot"]["snapshotId"].as_str().unwrap())
    .fetch_one(&pool)
    .await
    .unwrap();
    let payload: Value = serde_json::from_slice(
        &EnvProviderAuthCipher::from_env()
            .unwrap()
            .decrypt(&encrypted.0)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["apiMode"], "api-key");
    assert_eq!(payload["apiKey"], "synthetic-anthropic-key");
}
