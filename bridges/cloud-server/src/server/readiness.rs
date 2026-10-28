//! Bounded readiness probes. Responses never include connection details.
use super::ServerState;
use crate::auth::rate_limit::CloudRateLimiter;
use axum::{http::StatusCode, Json};
use rusty_s3::{
    actions::{HeadBucket, S3Action},
    Bucket, Credentials, UrlStyle,
};
use std::{sync::Arc, time::Duration};

pub(super) async fn ready(
    state: Arc<ServerState>,
    limiter: Arc<CloudRateLimiter>,
) -> (StatusCode, Json<serde_json::Value>) {
    let probe = async {
        let database = async {
            sqlx_core::query::query("SELECT 1")
                .execute(state.db_pool())
                .await
                .is_ok()
        };
        let storage = async {
            let Some(config) = state.s3() else {
                return false;
            };
            let Ok(bucket) = Bucket::new(
                config.endpoint.clone(),
                UrlStyle::Path,
                config.bucket.clone(),
                config.region.clone(),
            ) else {
                return false;
            };
            let credentials =
                Credentials::new(config.access_key.clone(), config.secret_key.clone());
            let url = HeadBucket::new(&bucket, Some(&credentials)).sign(Duration::from_secs(30));
            // Do not follow redirects with signed requests or log their URLs.
            let Ok(client) = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2))
                .build()
            else {
                return false;
            };
            client
                .head(url)
                .send()
                .await
                .is_ok_and(|reply| reply.status().is_success())
        };
        let (db, nats, redis, s3) = tokio::join!(
            database,
            state.events().is_ready(),
            limiter.is_ready(),
            storage
        );
        db && nats && redis && s3 && state.signup_email().is_some()
    };
    let ok = tokio::time::timeout(Duration::from_secs(3), probe)
        .await
        .unwrap_or(false);
    (
        if ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        },
        Json(serde_json::json!({"ok": ok})),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{auth::rate_limit::CloudRateLimitConfig, events::EventBus};

    #[tokio::test]
    async fn missing_dependencies_never_report_ready() {
        let pool = sqlx_postgres::PgPoolOptions::new()
            .connect_lazy("postgresql://localhost/unused")
            .unwrap();
        pool.close().await;
        let state = Arc::new(ServerState::new(pool, EventBus::noop()));
        let limiter = Arc::new(CloudRateLimiter::memory(CloudRateLimitConfig::production()));
        let (status, body) = ready(state, limiter).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(body.0, serde_json::json!({"ok": false}));
    }
}
