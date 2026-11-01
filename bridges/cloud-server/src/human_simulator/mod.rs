//! Dedicated simulator control service; not mounted on the product router.
//! Its worker-facing API never returns provider credentials.
mod model;
mod routes;
pub mod store;
#[cfg(test)]
mod tests;

use crate::system_agent::{PendingSystemAgentConfig, SystemAgentProviderAuth};
use axum::{
    extract::DefaultBodyLimit,
    routing::{get, post},
    Router,
};
use kordi_human_simulator::client::validate_origin;
use sqlx_postgres::{PgPool, PgPoolOptions};
use std::{collections::HashSet, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct SimulatorService {
    pub(crate) pool: PgPool,
    pub(crate) operator_hash: String,
    pub(crate) allowed_accounts: HashSet<String>,
    pub(crate) kordi_api_base: String,
    pub(crate) provider: SystemAgentProviderAuth,
    pub(crate) model_slots: Arc<Semaphore>,
}

pub fn router(service: SimulatorService) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { axum::Json(serde_json::json!({"status":"ok"})) }),
        )
        .route("/ready", get(routes::ready))
        .route("/v1/sim/actors", post(routes::create))
        .route("/v1/sim/actors/:id/status", get(routes::status))
        .route("/v1/sim/actors/:id/stop", post(routes::stop))
        .route("/v1/sim/actors/:id/lease", post(routes::lease))
        .route("/v1/sim/actors/:id/heartbeat", post(routes::heartbeat))
        .route("/v1/sim/actors/:id/release", post(routes::release))
        .route("/v1/sim/actors/:id/checkpoint", post(routes::checkpoint))
        .route("/v1/sim/actors/:id/decide", post(routes::decide))
        .route("/v1/sim/actors/:id/confirm", post(routes::confirm))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(service)
}

/// Starts only the simulator schema and routes, never product background workers.
pub async fn serve() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let required = |name: &str| {
        std::env::var(name)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| format!("Set {name}"))
    };
    let token = required("KORDI_SIM_OPERATOR_TOKEN")?;
    if token.len() < 32 {
        return Err("Simulator operator token must have at least 32 characters".into());
    }
    let accounts: HashSet<String> = required("KORDI_SIM_ALLOWED_ACCOUNTS")?
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if accounts.is_empty() {
        return Err("Explicit synthetic account allowlist is required".into());
    }
    let provider = PendingSystemAgentConfig::from_env()?
        .ok_or("System model configuration is unavailable")?
        .provider_auth;
    let kordi_api_base = validate_origin(&required("KORDI_SIM_KORDI_API_BASE")?)?;
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .acquire_timeout(Duration::from_secs(5))
        .connect(&required("KORDI_SIM_DATABASE_URL")?)
        .await
        .map_err(|_| "Simulator database connection failed")?;
    store::initialize(&pool)
        .await
        .map_err(|_| "Simulator schema initialization failed")?;
    let service = SimulatorService {
        pool,
        operator_hash: routes::digest(&token),
        allowed_accounts: accounts,
        kordi_api_base,
        provider,
        model_slots: Arc::new(Semaphore::new(2)),
    };
    let port: u16 = std::env::var("PORT")
        .unwrap_or_else(|_| "17340".into())
        .parse()
        .map_err(|_| "Invalid PORT")?;
    let host = std::env::var("KORDI_SIM_BIND").unwrap_or_else(|_| "127.0.0.1".into());
    let listener = tokio::net::TcpListener::bind((host.as_str(), port))
        .await
        .map_err(|_| "Simulator listener failed")?;
    axum::serve(listener, router(service))
        .with_graceful_shutdown(kordi_human_simulator::shutdown_signal())
        .await?;
    Ok(())
}
