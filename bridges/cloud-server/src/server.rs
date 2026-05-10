//! HTTP server entry point for the cloud-native collaboration server.
//!
//! Owns the `sqlx::PgPool`, builds the router, runs the HTTP listener.

use std::sync::Arc;

use axum::Router;
use sqlx_postgres::PgPool;
use tower_http::cors::{Any, CorsLayer};

use crate::events::{EventBus, EventBusError};
use crate::pg::{init_pool, PgPoolError};

pub struct ServerState {
    pool: PgPool,
    events: EventBus,
}

impl ServerState {
    pub fn new(pool: PgPool, events: EventBus) -> Self {
        Self { pool, events }
    }

    pub fn db_pool(&self) -> &PgPool {
        &self.pool
    }

    pub fn events(&self) -> &EventBus {
        &self.events
    }
}

pub fn router(state: Arc<ServerState>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .merge(crate::auth::routes::routes(state.clone()))
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
    Bind(std::io::Error),
    Serve(std::io::Error),
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pool(err) => write!(f, "{err}"),
            Self::Events(err) => write!(f, "{err}"),
            Self::Bind(err) => write!(f, "bind: {err}"),
            Self::Serve(err) => write!(f, "serve: {err}"),
        }
    }
}

impl std::error::Error for RunError {}

/// Boot the cloud-server HTTP API. Initialises the database, optionally
/// connects to NATS for event publishing, builds the router, listens on
/// `port`. `database_url` is required; `nats_url` is optional (no-op
/// publisher when `None`, so dev/CI work without a broker).
pub async fn run(
    port: u16,
    database_url: &str,
    nats_url: Option<&str>,
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
    let state = Arc::new(ServerState::new(pool, events));
    let app = router(state);
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
