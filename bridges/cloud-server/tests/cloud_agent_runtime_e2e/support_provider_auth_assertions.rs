use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use super::*;

pub(super) async fn assert_support_run_failure(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    run_id: &str,
) {
    let failed = router
        .clone()
        .oneshot(post_json_with_runner_token(
            &format!("/v1/cloud/agent-runs/{run_id}/fail"),
            "runner-test-token",
            json!({
                "runnerId": "runner-support-service",
                "errorCode": "missing_provider_auth",
                "message": "simulated runner failure"
            }),
        ))
        .await
        .unwrap();
    assert_eq!(failed.status(), StatusCode::OK);
    let failed = read_json(failed).await;
    assert_eq!(failed["run"]["status"], "failed");
    assert_eq!(failed["run"]["errorCode"], "missing_provider_auth");
    let response_message_id = failed["run"]["responseMessageId"].as_str().unwrap();
    let response: (String,) =
        sqlx_core::query_as::query_as("SELECT body FROM cloud_messages WHERE message_id = $1")
            .bind(response_message_id)
            .fetch_one(pool)
            .await
            .unwrap();
    let encoded = response
        .0
        .strip_prefix("kordi-cloud-agent-response:")
        .expect("support failure response envelope");
    let envelope: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
    assert_eq!(envelope["deliveryState"], "failed");
    assert_eq!(
        envelope["text"],
        "Kordi Support is temporarily unavailable. Try again shortly."
    );
}
