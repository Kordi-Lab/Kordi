//! HTTP server entry point for the cloud-native collaboration server.
//!
//! Owns its own `ServerState`, its own router, its own `run`. Independent
//! from `bridges/cli`'s server in every respect.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use rusqlite::Connection;
use tower_http::cors::{Any, CorsLayer};

use crate::db_runner::{DbRunner, DbRunnerError};
use crate::error::ServerInitError;
use crate::schema::{configure_server_connection, init_server_db};

/// Shared state for cloud-server routes.
pub struct ServerState {
    pub db_path: PathBuf,
    pub db_runner: tokio::sync::OnceCell<DbRunner>,
}

impl ServerState {
    pub fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            db_runner: tokio::sync::OnceCell::new(),
        }
    }

    pub fn open_connection(&self) -> Result<Connection, rusqlite::Error> {
        let conn = Connection::open(&self.db_path)?;
        configure_server_connection(&conn)?;
        Ok(conn)
    }

    pub async fn db_runner(&self) -> Result<&DbRunner, DbRunnerError> {
        self.db_runner
            .get_or_try_init(|| async { DbRunner::new(self.db_path.clone()) })
            .await
    }
}

/// Build the full axum router for the cloud server.
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

/// Boot the cloud-server HTTP API. Initialises the database, builds the
/// router, and listens on `port`.
pub async fn run(port: u16, db_path: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let conn = Connection::open(db_path)?;
    configure_server_connection(&conn)?;
    init_server_db(&conn).map_err(|err| -> Box<dyn std::error::Error + Send + Sync> {
        Box::new(err)
    })?;
    drop(conn);

    let state = Arc::new(ServerState::new(Path::new(db_path).to_path_buf()));
    let app = router(state);
    let addr = format!("0.0.0.0:{port}");
    println!("Kordi cloud server on {addr}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .await?;
    Ok(())
}

#[cfg(test)]
pub fn make_test_state() -> Arc<ServerState> {
    let db_path =
        std::env::temp_dir().join(format!("kordi-cloud-test-{}.db", uuid::Uuid::new_v4()));
    let conn = Connection::open(&db_path).expect("open test db");
    configure_server_connection(&conn).expect("configure");
    init_server_db(&conn).expect("init");
    drop(conn);
    Arc::new(ServerState::new(db_path))
}
