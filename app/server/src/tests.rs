use super::*;
use axum::body::Body;
use chrono::Utc;
use kordi_core::types::{EntryBase, EntryId, UserMessage};
use tokio::sync::Notify;

mod bootstrap_and_sessions;
mod turns;

#[derive(Clone)]
struct FakeBridgesStatusProvider {
    response: std::result::Result<BridgesStatusResponse, String>,
}

#[async_trait]
impl BridgesStatusProvider for FakeBridgesStatusProvider {
    async fn fetch_status(&self) -> Result<BridgesStatusResponse> {
        self.response.clone().map_err(anyhow::Error::msg)
    }
}

#[derive(Clone, Default)]
struct FakeTurnExecutor {
    calls: Arc<Mutex<Vec<TurnExecution>>>,
    gate: Option<Arc<Notify>>,
}

#[async_trait]
impl TurnExecutor for FakeTurnExecutor {
    async fn run_turn(&self, execution: TurnExecution) -> Result<()> {
        self.calls.lock().await.push(execution);
        if let Some(gate) = &self.gate {
            gate.notified().await;
        }
        Ok(())
    }
}

fn test_server(
    cwd: PathBuf,
    sessions_db_path: PathBuf,
    bridges_status: std::result::Result<BridgesStatusResponse, String>,
    turn_executor: FakeTurnExecutor,
) -> AppServer {
    AppServer {
        state: Arc::new(AppState {
            cwd,
            sessions_db_path,
            bridges_status: Arc::new(FakeBridgesStatusProvider {
                response: bridges_status,
            }),
            turn_executor: Arc::new(turn_executor),
            active_turns: Arc::new(Mutex::new(HashMap::new())),
        }),
    }
}

fn create_session_with_message(
    conn: &rusqlite::Connection,
    cwd: &str,
    name: &str,
    message: &str,
) -> String {
    let session_id = store::create_session(conn, cwd).expect("create session");
    store::set_session_name(conn, &session_id, Some(name)).expect("set session name");
    let entry = SessionEntry::Message {
        base: EntryBase {
            id: EntryId::generate(),
            parent_id: None,
            timestamp: Utc::now(),
        },
        message: AgentMessage::User(UserMessage {
            content: vec![ContentBlock::Text {
                text: message.to_string(),
            }],
            timestamp: Utc::now().timestamp(),
        }),
    };
    store::append_entry(conn, &session_id, &entry).expect("append entry");
    session_id
}

fn sample_bridges_status() -> BridgesStatusResponse {
    BridgesStatusResponse {
        node_id: "kd_test".to_string(),
        healthy: true,
        daemon: BridgesDaemonStatus {
            state: "online".to_string(),
            started_at: "2026-04-19T00:00:00Z".to_string(),
        },
        coordination: BridgesComponentStatus {
            state: "healthy".to_string(),
            detail: Some("coord ok".to_string()),
            checked_at: "2026-04-19T00:01:00Z".to_string(),
        },
        runtime: BridgesComponentStatus {
            state: "healthy".to_string(),
            detail: Some("runtime ok".to_string()),
            checked_at: "2026-04-19T00:02:00Z".to_string(),
        },
        reachability: BridgesReachabilityStatus {
            mode: "direct_and_relay".to_string(),
            endpoint_hints_published: 1,
            derp_connected: true,
            mailbox_fallback: true,
            mailbox_durable: true,
        },
    }
}
