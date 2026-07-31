use anyhow::{Context, Result};
use async_trait::async_trait;
use kordi_protocol::{ServiceSnapshot, ServiceState, ServiceStatusSummary};
use kordi_session::store;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub(super) struct BridgesStatusResponse {
    pub(super) node_id: String,
    pub(super) healthy: bool,
    pub(super) daemon: BridgesDaemonStatus,
    pub(super) coordination: BridgesComponentStatus,
    pub(super) runtime: BridgesComponentStatus,
    pub(super) reachability: BridgesReachabilityStatus,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct BridgesDaemonStatus {
    pub(super) state: String,
    pub(super) started_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct BridgesComponentStatus {
    pub(super) state: String,
    pub(super) detail: Option<String>,
    pub(super) checked_at: String,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct BridgesReachabilityStatus {
    pub(super) mode: String,
    pub(super) endpoint_hints_published: usize,
    pub(super) derp_connected: bool,
    pub(super) mailbox_fallback: bool,
    pub(super) mailbox_durable: bool,
}

#[async_trait]
pub(super) trait BridgesStatusProvider: Send + Sync {
    async fn fetch_status(&self) -> Result<BridgesStatusResponse>;
}

#[derive(Clone)]
pub(super) struct HttpBridgesStatusProvider {
    client: reqwest::Client,
    base_url: String,
}

impl HttpBridgesStatusProvider {
    pub(super) fn new(base_url: String) -> Self {
        Self {
            client: reqwest::Client::new(),
            base_url,
        }
    }
}

#[async_trait]
impl BridgesStatusProvider for HttpBridgesStatusProvider {
    async fn fetch_status(&self) -> Result<BridgesStatusResponse> {
        let response = self
            .client
            .get(format!("{}/status", self.base_url))
            .send()
            .await
            .with_context(|| format!("requesting Bridges status from {}", self.base_url))?
            .error_for_status()
            .with_context(|| format!("Bridges status request to {} failed", self.base_url))?;

        response
            .json::<BridgesStatusResponse>()
            .await
            .context("decoding Bridges status response")
    }
}

pub(super) async fn build_services_snapshot(
    sessions_db_path: &Path,
    bridges_status: &dyn BridgesStatusProvider,
) -> ServiceSnapshot {
    let runtime = match store::open_db(sessions_db_path) {
        Ok(_) => ServiceStatusSummary {
            state: ServiceState::Ready,
            detail: Some(format!(
                "session store available at {}",
                sessions_db_path.display()
            )),
            last_heartbeat_at: None,
        },
        Err(error) => ServiceStatusSummary {
            state: ServiceState::Error,
            detail: Some(format!(
                "unable to open session store {}: {error}",
                sessions_db_path.display()
            )),
            last_heartbeat_at: None,
        },
    };

    let bridges = match bridges_status.fetch_status().await {
        Ok(status) => map_bridges_status(status),
        Err(error) => ServiceStatusSummary {
            state: ServiceState::Unknown,
            detail: Some(error.to_string()),
            last_heartbeat_at: None,
        },
    };

    ServiceSnapshot {
        runtime,
        bridges,
        registry: None,
    }
}

fn map_bridges_status(status: BridgesStatusResponse) -> ServiceStatusSummary {
    let state = if status.healthy {
        ServiceState::Ready
    } else {
        ServiceState::Degraded
    };

    ServiceStatusSummary {
        state,
        detail: Some(format!(
            "node {} • daemon={} since {} • coordination={} • runtime={} • reachability={} (direct_hints={} derp={} mailbox={} durable={})",
            status.node_id,
            status.daemon.state,
            status.daemon.started_at,
            bridges_component_summary(&status.coordination),
            bridges_component_summary(&status.runtime),
            status.reachability.mode,
            status.reachability.endpoint_hints_published,
            status.reachability.derp_connected,
            status.reachability.mailbox_fallback,
            status.reachability.mailbox_durable,
        )),
        last_heartbeat_at: Some(
            status
                .coordination
                .checked_at
                .max(status.runtime.checked_at),
        ),
    }
}

fn bridges_component_summary(component: &BridgesComponentStatus) -> String {
    match &component.detail {
        Some(detail) if !detail.trim().is_empty() => format!("{} ({detail})", component.state),
        _ => component.state.clone(),
    }
}
