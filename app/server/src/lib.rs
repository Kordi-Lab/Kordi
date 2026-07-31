use anyhow::{Context, Result};
use axum::Router;
use axum::routing::{get, post};
use kordi_core::config;
use kordi_core::settings::Settings;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

mod bridge_health;
mod configuration;
mod http;
mod protocol_mapping;
mod session_projection;
mod turn_execution;

use bridge_health::{BridgesStatusProvider, HttpBridgesStatusProvider};
use configuration::{resolve_bridges_base_url, resolve_turn_command};
use http::{
    handle_bootstrap, handle_fork_session, handle_session_detail, handle_session_forks,
    handle_sessions, handle_submit_turn,
};
use turn_execution::{ProcessTurnExecutor, TurnExecutor};

#[cfg(test)]
use async_trait::async_trait;
#[cfg(test)]
use bridge_health::{
    BridgesComponentStatus, BridgesDaemonStatus, BridgesReachabilityStatus, BridgesStatusResponse,
};
#[cfg(test)]
use kordi_core::types::{AgentMessage, ContentBlock, SessionEntry};
#[cfg(test)]
use kordi_protocol::{
    APP_PROTOCOL_VERSION, BootstrapSnapshot, ClientKind, ForkSessionResponse, ModelSelector,
    ServiceState, SessionDetail, SessionForksPage, SessionSource, SessionStatus, SessionsPage,
    SubmitTurnAccepted, SubmitTurnRequest, ThinkingLevel,
};
#[cfg(test)]
use kordi_session::store;
#[cfg(test)]
use turn_execution::{TurnExecution, protocol_thinking_level};

#[derive(Clone)]
pub struct AppServer {
    state: Arc<AppState>,
}

#[derive(Clone)]
struct AppState {
    cwd: PathBuf,
    sessions_db_path: PathBuf,
    bridges_status: Arc<dyn BridgesStatusProvider>,
    turn_executor: Arc<dyn TurnExecutor>,
    active_turns: Arc<Mutex<HashMap<String, ActiveTurn>>>,
}

#[derive(Clone, Debug)]
struct ActiveTurn {
    turn_id: String,
}

impl AppServer {
    pub fn from_cwd(cwd: PathBuf) -> Result<Self> {
        let cwd = std::fs::canonicalize(&cwd)
            .with_context(|| format!("canonicalizing cwd {}", cwd.display()))?;
        let global_settings = Settings::load_global();
        let sessions_db_path = config::session_db_path(&global_settings.storage);
        let bridges_base_url = resolve_bridges_base_url();
        let turn_command = resolve_turn_command();

        Ok(Self {
            state: Arc::new(AppState {
                cwd,
                sessions_db_path,
                bridges_status: Arc::new(HttpBridgesStatusProvider::new(bridges_base_url)),
                turn_executor: Arc::new(ProcessTurnExecutor {
                    command: turn_command,
                }),
                active_turns: Arc::new(Mutex::new(HashMap::new())),
            }),
        })
    }

    pub async fn serve(&self, listen: SocketAddr) -> Result<()> {
        let listener = tokio::net::TcpListener::bind(listen)
            .await
            .with_context(|| format!("binding app server on {}", listen))?;
        tracing::info!("kordi app server listening on {}", listen);
        axum::serve(listener, self.router())
            .await
            .context("serving app server")
    }

    pub fn router(&self) -> Router {
        Router::new()
            .route("/v1/bootstrap", get(handle_bootstrap))
            .route("/v1/sessions", get(handle_sessions))
            .route("/v1/sessions/:session_id", get(handle_session_detail))
            .route(
                "/v1/sessions/:session_id/forks",
                get(handle_session_forks).post(handle_fork_session),
            )
            .route("/v1/sessions/:session_id/turns", post(handle_submit_turn))
            .with_state(self.state.clone())
    }
}

#[cfg(test)]
mod tests;
