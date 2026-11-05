//! Bounded readiness probes. Responses never include connection details.
use super::ServerState;
use crate::auth::rate_limit::CloudRateLimiter;
use axum::{http::StatusCode, Json};
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
            match state.object_store() {
                Some(store) => store.ready(Duration::from_secs(2)).await,
                None => false,
            }
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
