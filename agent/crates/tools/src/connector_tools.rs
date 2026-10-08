//! Connector tools delivered by the server on a cloud lease (issue 1712).
//!
//! The server decides which connector tools a run may use and delivers them
//! as descriptors. The host turns each descriptor into a [`ConnectorTool`];
//! a call goes back to the server broker through the host-supplied
//! [`ConnectorToolsRuntime::call`]. No credential ever reaches the tool.
use std::{future::Future, pin::Pin, sync::Arc};

use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{
    Tool, ToolApprovalRequest, ToolContext, ToolExecutionMode, ToolLayer, ToolMetadata, ToolResult,
    ToolRiskLevel,
};

pub const CONNECTOR_TOOLS_UNAVAILABLE: &str =
    "Connector tools are not available in this run. Do not guess what the service contains.";

/// `read` never changes anything at the provider; `act` does.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectorToolGroup {
    Read,
    Act,
}

fn open_object_schema() -> Value {
    json!({ "type": "object" })
}

/// One connector tool as the server puts it on a lease (`connectorTools`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorToolDescriptor {
    pub connector_id: String,
    pub provider: String,
    /// Namespaced, for example `gmail_search`.
    pub name: String,
    pub group: ConnectorToolGroup,
    pub description: String,
    #[serde(default = "open_object_schema")]
    pub input_schema: Value,
}

impl ConnectorToolDescriptor {
    pub fn is_act(&self) -> bool {
        self.group == ConnectorToolGroup::Act
    }
}

/// Shape check for a connector tool name: `^[A-Za-z0-9_-]{1,64}$`, the
/// function-name rule model providers enforce (no dots). This is a secondary
/// check only: a name is a connector tool because the lease lists it, see
/// [`lease_tool`].
pub fn is_connector_tool_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

/// The lease descriptor for `name`, when the lease lists it and the name
/// passes the shape check. The lease is the source of truth.
pub fn lease_tool<'a>(
    descriptors: &'a [ConnectorToolDescriptor],
    name: &str,
) -> Option<&'a ConnectorToolDescriptor> {
    if !is_connector_tool_name(name) {
        return None;
    }
    descriptors
        .iter()
        .find(|descriptor| descriptor.name == name)
}

/// Lease descriptors from the raw `connectorTools` value, entry by entry. An
/// entry that does not parse is dropped with a warning (fail closed per
/// entry), so one unknown shape never removes the whole lease or its other
/// tools. Anything other than an array yields no tools.
pub fn parse_lease_descriptors(value: Value) -> Vec<ConnectorToolDescriptor> {
    let entries = match value {
        Value::Array(entries) => entries,
        Value::Null => return Vec::new(),
        _ => {
            tracing::warn!("connectorTools is not an array; ignoring it");
            return Vec::new();
        }
    };
    entries
        .into_iter()
        .enumerate()
        .filter_map(|(index, entry)| match serde_json::from_value(entry) {
            Ok(descriptor) => Some(descriptor),
            Err(error) => {
                tracing::warn!("dropping connectorTools[{index}]: {error}");
                None
            }
        })
        .collect()
}

/// `deserialize_with` helper for a `connectorTools` field.
pub fn deserialize_lease_descriptors<'de, D>(
    deserializer: D,
) -> Result<Vec<ConnectorToolDescriptor>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(parse_lease_descriptors(Value::deserialize(deserializer)?))
}

/// `deserialize_with` helper for an optional `connectorTools` field; pair it
/// with `#[serde(default)]` so a missing field stays `None`.
pub fn deserialize_optional_lease_descriptors<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<ConnectorToolDescriptor>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    Ok((!value.is_null()).then(|| parse_lease_descriptors(value)))
}

pub type ConnectorCallFuture = Pin<Box<dyn Future<Output = KordiResult<Value>> + Send>>;
pub type ConnectorCallFn =
    Arc<dyn Fn(ConnectorToolDescriptor, Value) -> ConnectorCallFuture + Send + Sync>;

/// Host-supplied connector access for one turn: the descriptors from the
/// lease and the call that reaches the server broker.
#[derive(Clone)]
pub struct ConnectorToolsRuntime {
    pub descriptors: Vec<ConnectorToolDescriptor>,
    pub call: ConnectorCallFn,
}

impl ConnectorToolsRuntime {
    pub fn descriptor(&self, name: &str) -> Option<&ConnectorToolDescriptor> {
        self.descriptors
            .iter()
            .find(|descriptor| descriptor.name == name)
    }

    /// One tool per descriptor, in lease order, skipping repeated names.
    pub fn tools(&self) -> Vec<Box<dyn Tool>> {
        let mut seen = std::collections::HashSet::new();
        self.descriptors
            .iter()
            .filter(|descriptor| seen.insert(descriptor.name.clone()))
            .map(|descriptor| Box::new(ConnectorTool::new(descriptor.clone())) as Box<dyn Tool>)
            .collect()
    }
}

/// A [`Tool`] built from a lease descriptor.
pub struct ConnectorTool {
    descriptor: ConnectorToolDescriptor,
}

impl ConnectorTool {
    pub fn new(descriptor: ConnectorToolDescriptor) -> Self {
        Self { descriptor }
    }

    pub fn descriptor(&self) -> &ConnectorToolDescriptor {
        &self.descriptor
    }
}

#[async_trait]
impl Tool for ConnectorTool {
    fn name(&self) -> &str {
        &self.descriptor.name
    }

    fn description(&self) -> &str {
        &self.descriptor.description
    }

    fn parameters_schema(&self) -> Value {
        self.descriptor.input_schema.clone()
    }

    fn metadata(&self) -> ToolMetadata {
        match self.descriptor.group {
            ConnectorToolGroup::Read => {
                ToolMetadata::new(ToolLayer::Observation, ToolRiskLevel::ReadOnly, true)
            }
            ConnectorToolGroup::Act => ToolMetadata::operator(ToolRiskLevel::High),
        }
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        crate::ensure_tool_allowed(self, ctx)?;
        // Fail closed: the runtime must be present and must still list this
        // exact tool for the current run.
        let runtime = ctx
            .connector_tools
            .as_ref()
            .ok_or_else(|| KordiError::Tool(CONNECTOR_TOOLS_UNAVAILABLE.into()))?;
        let descriptor = runtime
            .descriptor(&self.descriptor.name)
            .filter(|descriptor| descriptor.connector_id == self.descriptor.connector_id)
            .cloned()
            .ok_or_else(|| KordiError::Tool(CONNECTOR_TOOLS_UNAVAILABLE.into()))?;
        if descriptor.is_act() {
            request_act_approval(&descriptor, &params, ctx).await?;
        }
        let value = tokio::select! {
            _ = cancel.cancelled() => {
                return Err(KordiError::Tool("Connector call cancelled".into()))
            }
            result = (runtime.call)(descriptor, params) => result?,
        };
        Ok(crate::support::text_result(value.to_string(), Some(value)))
    }
}

/// Every `act` tool asks the person first ("Ask me before"). Without an
/// interactive approval hook the call is refused.
async fn request_act_approval(
    descriptor: &ConnectorToolDescriptor,
    params: &Value,
    ctx: &ToolContext,
) -> KordiResult<()> {
    let refused = |reason: &str| {
        KordiError::Tool(format!(
            "{} was not run: {reason} Nothing was changed at {}.",
            descriptor.name, descriptor.provider
        ))
    };
    if ctx.execution_mode == ToolExecutionMode::NonInteractive {
        return Err(refused("acting through a connector needs your approval."));
    }
    let Some(request_approval) = ctx.request_approval.as_ref() else {
        return Err(refused("approval is not available here."));
    };
    let outcome = request_approval(ToolApprovalRequest {
        tool_name: descriptor.name.clone(),
        title: format!(
            "Allow {} to act in {}",
            descriptor.name, descriptor.provider
        ),
        command: params.to_string(),
        reason: descriptor.description.clone(),
    })
    .await;
    if outcome.approved() {
        Ok(())
    } else {
        Err(refused("you declined."))
    }
}

#[cfg(test)]
#[path = "connector_tools_tests.rs"]
mod tests;
