//! HTTP server entry point for the cloud-native collaboration server.
//!
//! Owns the `sqlx::PgPool`, builds the router, runs the HTTP listener.

use std::sync::Arc;

use axum::Router;
use sqlx_postgres::PgPool;
use tower_http::cors::{Any, CorsLayer};

use crate::attachments::S3Config;
use crate::auth::rate_limit::{
    CloudRateLimitConfig, CloudRateLimiter, RateLimiterError,
};
use crate::events::{EventBus, EventBusError};
use crate::pg::{init_pool, PgPoolError};

pub struct ServerState {
    pool: PgPool,
    events: EventBus,
    s3: Option<S3Config>,
}

impl ServerState {
    pub fn new(pool: PgPool, events: EventBus) -> Self {
        Self { pool, events, s3: None }
    }

    pub fn with_s3(mut self, s3: S3Config) -> Self {
        self.s3 = Some(s3);
        self
    }

    pub fn db_pool(&self) -> &PgPool {
        &self.pool
    }

    pub fn events(&self) -> &EventBus {
        &self.events
    }

    pub fn s3(&self) -> Option<&S3Config> {
        self.s3.as_ref()
    }
}

/// Build the public router with the default production rate limiter
/// (in-memory). Tests and `run` use [`router_with_rate_limiter`] when
/// they need to inject a Redis-backed limiter.
pub fn router(state: Arc<ServerState>) -> Router {
    router_with_rate_limiter(
        state,
        CloudRateLimiter::memory(CloudRateLimitConfig::production()),
    )
}

pub fn router_with_rate_limiter(
    state: Arc<ServerState>,
    rate_limiter: CloudRateLimiter,
) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let ws_router = Router::new()
        .route("/v1/cloud/ws", axum::routing::get(crate::ws::ws_handler))
        .with_state(state.clone());

    Router::new()
        .merge(crate::auth::routes::routes_with_config(
            state.clone(),
            crate::auth::password::PasswordHasherConfig::production(),
            rate_limiter,
        ))
        .merge(ws_router)
        .route("/health", axum::routing::get(health))
        .layer(cors)
}

async fn health() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({ "ok": true, "server": "kordi-cloud" }))
}

#[derive(Debug)]
pub enum RunError {
    Pool(PgPoolError),
    Events(EventBusError),
    RateLimiter(RateLimiterError),
    Bind(std::io::Error),
    Serve(std::io::Error),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pool(err) => write!(f, "{err}"),
            Self::Events(err) => write!(f, "{err}"),
            Self::RateLimiter(err) => write!(f, "{err}"),
            Self::Bind(err) => write!(f, "bind: {err}"),
            Self::Serve(err) => write!(f, "serve: {err}"),
        }
    }
}

impl std::error::Error for RunError {}

/// Boot the cloud-server HTTP API. Initialises the database, optionally
/// connects to NATS for event publishing and Redis for the rate
/// limiter, builds the router, listens on `port`. `database_url` is
/// required; `nats_url` and `redis_url` are optional — when unset the
/// server falls back to no-op events and an in-memory limiter so
/// dev/CI work without those dependencies.
pub async fn run(
    port: u16,
    database_url: &str,
    nats_url: Option<&str>,
    redis_url: Option<&str>,
) -> Result<(), RunError> {
    let pool = init_pool(database_url).await.map_err(RunError::Pool)?;
    let events = match nats_url {
        Some(url) => {
            println!("Kordi cloud server connecting to NATS at {url}");
            EventBus::connect(url).await.map_err(RunError::Events)?
        }
        None => {
            println!("Kordi cloud server starting without NATS (events disabled)");
            EventBus::noop()
        }
    };
    let rate_limiter = match redis_url {
        Some(url) => {
            println!("Kordi cloud server connecting to Redis at {url}");
            CloudRateLimiter::redis(url, CloudRateLimitConfig::production())
                .await
                .map_err(RunError::RateLimiter)?
        }
        None => {
            println!(
                "Kordi cloud server starting without Redis (rate limiter is in-memory)"
            );
            CloudRateLimiter::memory(CloudRateLimitConfig::production())
        }
    };
    let mut state = ServerState::new(pool, events);
    if let Some(s3) = S3Config::from_env() {
        println!(
            "Kordi cloud server attachment store at {} (bucket={})",
            s3.endpoint, s3.bucket
        );
        state = state.with_s3(s3);
    } else {
        println!(
            "Kordi cloud server starting without S3 (attachments disabled — set S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY, S3_SECRET_KEY)"
        );
    }
    let state = Arc::new(state);
    let app = router_with_rate_limiter(state, rate_limiter);
    let addr = format!("0.0.0.0:{port}");
    println!("Kordi cloud server on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(RunError::Bind)?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await
    .map_err(RunError::Serve)?;
    Ok(())
}
