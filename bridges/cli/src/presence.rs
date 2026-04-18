use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComponentState {
    Healthy,
    Degraded,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReachabilityMode {
    Unknown,
    DirectOnly,
    RelayOnly,
    DirectAndRelay,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentStatus {
    pub state: ComponentState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReachabilityStatus {
    pub mode: ReachabilityMode,
    pub endpoint_hints_published: usize,
    pub derp_connected: bool,
    pub mailbox_fallback: bool,
    pub mailbox_durable: bool,
}

#[derive(Debug, Clone)]
pub struct PresenceState {
    daemon_started_at: String,
    coordination: ComponentStatus,
    runtime: ComponentStatus,
    endpoint_hints_published: usize,
    derp_connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PresenceSnapshot {
    pub daemon_started_at: String,
    pub coordination: ComponentStatus,
    pub runtime: ComponentStatus,
    pub reachability: ReachabilityStatus,
}

impl PresenceState {
    pub fn new(endpoint_hints_published: usize, derp_connected: bool) -> Self {
        Self {
            daemon_started_at: now_rfc3339(),
            coordination: ComponentStatus::unknown("no successful coordination operation yet"),
            runtime: ComponentStatus::unknown("no runtime dispatch attempted yet"),
            endpoint_hints_published,
            derp_connected,
        }
    }

    pub fn snapshot(&self) -> PresenceSnapshot {
        PresenceSnapshot {
            daemon_started_at: self.daemon_started_at.clone(),
            coordination: self.coordination.clone(),
            runtime: self.runtime.clone(),
            reachability: ReachabilityStatus {
                mode: self.reachability_mode(),
                endpoint_hints_published: self.endpoint_hints_published,
                derp_connected: self.derp_connected,
                mailbox_fallback: true,
                mailbox_durable: true,
            },
        }
    }

    pub fn note_coord_ok(&mut self, detail: impl Into<String>) {
        self.coordination = ComponentStatus::healthy(detail);
    }

    pub fn note_coord_error(&mut self, detail: impl Into<String>) {
        self.coordination = ComponentStatus::degraded(detail);
    }

    pub fn note_runtime_ok(&mut self, detail: impl Into<String>) {
        self.runtime = ComponentStatus::healthy(detail);
    }

    pub fn note_runtime_error(&mut self, detail: impl Into<String>) {
        self.runtime = ComponentStatus::degraded(detail);
    }

    pub fn set_reachability_inputs(
        &mut self,
        endpoint_hints_published: usize,
        derp_connected: bool,
    ) {
        self.endpoint_hints_published = endpoint_hints_published;
        self.derp_connected = derp_connected;
    }

    fn reachability_mode(&self) -> ReachabilityMode {
        match (self.endpoint_hints_published > 0, self.derp_connected) {
            (true, true) => ReachabilityMode::DirectAndRelay,
            (true, false) => ReachabilityMode::DirectOnly,
            (false, true) => ReachabilityMode::RelayOnly,
            (false, false) => ReachabilityMode::Unknown,
        }
    }
}

impl ComponentStatus {
    fn healthy(detail: impl Into<String>) -> Self {
        Self {
            state: ComponentState::Healthy,
            detail: Some(detail.into()),
            checked_at: now_rfc3339(),
        }
    }

    fn degraded(detail: impl Into<String>) -> Self {
        Self {
            state: ComponentState::Degraded,
            detail: Some(detail.into()),
            checked_at: now_rfc3339(),
        }
    }

    fn unknown(detail: impl Into<String>) -> Self {
        Self {
            state: ComponentState::Unknown,
            detail: Some(detail.into()),
            checked_at: now_rfc3339(),
        }
    }
}

fn now_rfc3339() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reachability_mode_classifies_transport_paths() {
        let mut presence = PresenceState::new(0, false);
        assert_eq!(
            presence.snapshot().reachability.mode,
            ReachabilityMode::Unknown
        );

        presence.set_reachability_inputs(1, false);
        assert_eq!(
            presence.snapshot().reachability.mode,
            ReachabilityMode::DirectOnly
        );

        presence.set_reachability_inputs(0, true);
        assert_eq!(
            presence.snapshot().reachability.mode,
            ReachabilityMode::RelayOnly
        );

        presence.set_reachability_inputs(2, true);
        assert_eq!(
            presence.snapshot().reachability.mode,
            ReachabilityMode::DirectAndRelay
        );
    }

    #[test]
    fn component_status_updates_to_healthy_and_degraded() {
        let mut presence = PresenceState::new(0, false);
        presence.note_coord_ok("mailbox poll succeeded");
        presence.note_runtime_error("dispatch failed");
        let snapshot = presence.snapshot();

        assert_eq!(snapshot.coordination.state, ComponentState::Healthy);
        assert_eq!(snapshot.runtime.state, ComponentState::Degraded);
        assert_eq!(
            snapshot.coordination.detail.as_deref(),
            Some("mailbox poll succeeded")
        );
        assert_eq!(snapshot.runtime.detail.as_deref(), Some("dispatch failed"));
    }
}
