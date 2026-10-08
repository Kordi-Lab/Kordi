//! Wire and domain types for connectors.
//!
//! Nothing in this file may carry a credential. Secrets have their own type,
//! [`super::providers::ConnectorSecret`], which is not `Serialize`.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorStatus {
    Connected,
    NeedsReauth,
    Revoked,
}

impl ConnectorStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::NeedsReauth => "needs_reauth",
            Self::Revoked => "revoked",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "connected" => Some(Self::Connected),
            "needs_reauth" => Some(Self::NeedsReauth),
            "revoked" => Some(Self::Revoked),
            _ => None,
        }
    }
}

/// The two tool groups a connector exposes. `read` never changes anything
/// at the provider; `act` does and needs its own OAuth grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorToolGroup {
    Read,
    Act,
}

impl ConnectorToolGroup {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Act => "act",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "read" => Some(Self::Read),
            "act" => Some(Self::Act),
            _ => None,
        }
    }
}

/// Who started the run that asks for a connector tool. Stored on the run as
/// `run_trigger` and delivered on its lease. Anything that is not a run a
/// person started by sending a message is a background run.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunTrigger {
    PersonStarted,
    /// The default, so an unlabeled run fails closed to `read` tools.
    #[default]
    Background,
}

impl RunTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PersonStarted => "person_started",
            Self::Background => "background",
        }
    }

    /// Unknown values are background runs.
    pub fn parse(value: &str) -> Self {
        match value {
            "person_started" => Self::PersonStarted,
            _ => Self::Background,
        }
    }

    /// Person-started only when the person who sent the message owns the
    /// agent. A request from a contact or a shared-agent member never unlocks
    /// the owner's `act` tools.
    pub fn for_person_message(owner_account_id: &str, requester_account_id: &str) -> Self {
        let owner = owner_account_id.trim();
        if !owner.is_empty() && owner == requester_account_id.trim() {
            Self::PersonStarted
        } else {
            Self::Background
        }
    }
}

/// Who can read a run's output. Stored on the run as `connector_audience`
/// and delivered on its lease as `connectorAudience`. Connector data about
/// other people (senders, attendees, members) reaches a run only when the
/// owner alone can read what it produces.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorAudience {
    /// The owner started the run in a conversation only they and their own
    /// agent can read, or it is an owner-only background job.
    OwnerPrivate,
    /// Other accounts can read the output: group conversations, runs a
    /// contact or shared-agent member started, PiP posts, and subsessions
    /// of shared runs. The default, so an unlabeled run gets no connector
    /// tools at all.
    #[default]
    Shared,
}

impl ConnectorAudience {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OwnerPrivate => "owner_private",
            Self::Shared => "shared",
        }
    }

    /// Unknown values are shared runs.
    pub fn parse(value: &str) -> Self {
        match value {
            "owner_private" => Self::OwnerPrivate,
            _ => Self::Shared,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AuditOutcome {
    Completed,
    Approved,
    Denied,
    BlockedBackground,
    Failed,
}

impl AuditOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::BlockedBackground => "blocked_background",
            Self::Failed => "failed",
        }
    }
}

/// Columns of `cloud_connectors` that [`ConnectorRecord`] is loaded from.
/// The secrets table is never joined here.
pub(crate) const CONNECTOR_COLUMNS: &str = "connector_id, account_id, provider, status, \
     read_scopes, act_scopes, act_enabled, created_at, updated_at, revoked_at, settings, \
     provider_account_id, last_event_at";

/// One row of `cloud_connectors`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectorRecord {
    pub connector_id: String,
    pub account_id: String,
    pub provider: String,
    pub status: ConnectorStatus,
    pub read_scopes: Vec<String>,
    pub act_scopes: Vec<String>,
    pub act_enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    /// Validated provider settings, such as `{ "channels": [...] }` for Slack.
    pub settings: Value,
    /// The account at the provider (GitHub user id, Google email, Slack
    /// `team:user`). Routes webhooks; never sent to clients.
    pub provider_account_id: Option<String>,
    pub last_event_at: Option<DateTime<Utc>>,
}

/// Tool groups a run may receive from `connector` for `trigger`.
///
/// Empty unless the connector is connected. Background runs and connectors
/// with `act` turned off get `read` only. `act` is added only for a run a
/// person started on a connector whose owner turned `act` on.
pub fn allowed_tool_groups(
    connector: &ConnectorRecord,
    trigger: RunTrigger,
) -> Vec<ConnectorToolGroup> {
    if connector.status != ConnectorStatus::Connected {
        return Vec::new();
    }
    match trigger {
        RunTrigger::PersonStarted if connector.act_enabled => {
            vec![ConnectorToolGroup::Read, ConnectorToolGroup::Act]
        }
        _ => vec![ConnectorToolGroup::Read],
    }
}

/// A connector as clients see it. Built only from a [`ConnectorRecord`]
/// (a `cloud_connectors` row) and its agent grants, so it cannot carry a
/// secret-bearing field.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorSummary {
    pub connector_id: String,
    pub provider: String,
    pub status: ConnectorStatus,
    pub read_scopes: Vec<String>,
    pub act_scopes: Vec<String>,
    pub act_enabled: bool,
    pub agent_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revoked_at: Option<String>,
    /// The granted scopes as the catalog ids the clients use
    /// (`<provider>.<thing>.<access>`), alongside the native scopes above.
    pub granted_scope_ids: Vec<String>,
    pub settings: Value,
    pub last_event_at: Option<String>,
}

impl ConnectorSummary {
    pub fn from_record(record: ConnectorRecord, agent_ids: Vec<String>) -> Self {
        // Exhaustive destructuring: a new column on ConnectorRecord fails to
        // compile here until someone decides whether clients may see it.
        let ConnectorRecord {
            connector_id,
            account_id: _,
            provider,
            status,
            read_scopes,
            act_scopes,
            act_enabled,
            created_at,
            updated_at,
            revoked_at,
            settings,
            provider_account_id: _,
            last_event_at,
        } = record;
        let granted_scope_ids = super::providers::provider_spec(&provider)
            .map(|spec| {
                let granted = read_scopes.iter().chain(&act_scopes).cloned();
                spec.catalog_scope_ids(&granted.collect::<Vec<_>>())
            })
            .unwrap_or_default();
        Self {
            connector_id,
            provider,
            status,
            read_scopes,
            act_scopes,
            act_enabled,
            agent_ids,
            created_at: created_at.to_rfc3339(),
            updated_at: updated_at.to_rfc3339(),
            revoked_at: revoked_at.map(|value| value.to_rfc3339()),
            granted_scope_ids,
            settings,
            last_event_at: last_event_at.map(|value| value.to_rfc3339()),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorListResponse {
    pub connectors: Vec<ConnectorSummary>,
    /// Agents the person can grant connectors to: the built-in agent first,
    /// then active agents from `cloud_agent_definitions`.
    pub agents: Vec<ConnectorAgent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAgent {
    pub agent_id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorResponse {
    pub connector: ConnectorSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartRequest {
    pub grant: ConnectorToolGroup,
    #[serde(default)]
    pub redirect_after: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartResponse {
    pub auth_url: String,
}

#[derive(Debug, Deserialize)]
pub struct OAuthCallbackQuery {
    pub state: Option<String>,
    pub code: Option<String>,
    pub error: Option<String>,
}

/// Fragment payload handed back to the desktop or iOS app after a grant.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthCompletedFragment {
    pub connector_id: String,
    pub provider: String,
    pub grant: ConnectorToolGroup,
    pub status: ConnectorStatus,
}

#[derive(Debug, Deserialize)]
pub struct SetActRequest {
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAgentsRequest {
    pub agent_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct AuditQuery {
    pub limit: Option<i64>,
    pub before: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAuditEntry {
    pub audit_id: String,
    pub connector_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub tool: String,
    pub tool_group: ConnectorToolGroup,
    pub outcome: String,
    pub summary: String,
    pub created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorAuditResponse {
    pub entries: Vec<ConnectorAuditEntry>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_before: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectResponse {
    pub deleted_events: u64,
}

/// Body a runtime sends to the broker route.
///
/// `lease_id` is the run id of an active lease. The account, agent, and
/// trigger are always taken from that lease; the body copies are accepted for
/// compatibility, ignored, and logged when they disagree.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerCallRequest {
    pub lease_id: String,
    /// Cloud runner that holds the lease (runner-token path).
    #[serde(default)]
    pub runner_id: Option<String>,
    /// Desktop claim that holds the lease (signed-in desktop path).
    #[serde(default)]
    pub claim_id: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub trigger: Option<RunTrigger>,
    pub connector_id: String,
    pub tool: String,
    #[serde(default)]
    pub args: Value,
    /// The owner declined this `act` call on their Mac. The broker records a
    /// `denied` audit row for a tool on the lease and never executes it.
    #[serde(default)]
    pub declined_by_owner: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerCallError {
    pub code: String,
    pub message: String,
}

/// Broker answer. Carries either the provider result or an error, never the
/// credential used to reach the provider.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerCallResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<BrokerCallError>,
}

impl BrokerCallResponse {
    pub fn success(result: Value) -> Self {
        Self {
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(code: &str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            result: None,
            error: Some(BrokerCallError {
                code: code.to_string(),
                message: message.into(),
            }),
        }
    }

    pub fn error_code(&self) -> Option<&str> {
        self.error.as_ref().map(|error| error.code.as_str())
    }
}
