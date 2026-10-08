//! `connectors_request_connect`: the chat affordance for connectors
//! (issue 1712, PR 5).
//!
//! When someone asks their agent to "connect my Gmail", the agent cannot and
//! must not grant access itself. This tool only returns a Kordi deep link
//! that opens the Connectors settings on that provider; the person connects
//! it there. It performs no grant and reads no connector data.
use async_trait::async_trait;
use kordi_core::error::{KordiError, KordiResult};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{Tool, ToolContext, ToolLayer, ToolMetadata, ToolResult, ToolRiskLevel};

pub const REQUEST_CONNECT_TOOL_NAME: &str = "connectors_request_connect";

/// Provider ids the settings screen knows, with their display names.
pub const REQUEST_CONNECT_PROVIDERS: [(&str, &str); 4] = [
    ("gmail", "Gmail"),
    ("google_calendar", "Google Calendar"),
    ("github", "GitHub"),
    ("slack", "Slack"),
];

pub const REQUEST_CONNECT_DESCRIPTION: &str = "Give the person a link that opens Kordi's Connectors settings for a service (Gmail, Google Calendar, GitHub, or Slack) so they can connect it themselves. Use it when they ask you to connect a service or when a task needs a service that is not connected. It does not connect anything.";

/// The settings deep link for `provider`.
pub fn request_connect_url(provider: &str) -> String {
    format!("kordi://settings/connectors?provider={provider}")
}

pub fn request_connect_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "provider": {
                "type": "string",
                "enum": REQUEST_CONNECT_PROVIDERS.map(|(id, _)| id),
                "description": "The service to connect."
            }
        },
        "required": ["provider"],
        "additionalProperties": false
    })
}

/// The tool result for `args`, or a clear error for an unknown provider.
pub fn request_connect_result(args: &Value) -> Result<Value, String> {
    let requested = args
        .get("provider")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    let Some((id, label)) = REQUEST_CONNECT_PROVIDERS
        .iter()
        .find(|(id, _)| *id == requested)
    else {
        return Err(format!(
            "Unknown service \"{requested}\". Use one of: gmail, google_calendar, github, slack."
        ));
    };
    let url = request_connect_url(id);
    Ok(json!({
        "openUrl": url,
        "message": format!("Open Connectors settings to connect {label}: [Connect {label}]({url})"),
        "instruction": format!("Show the person the link above as a Markdown link and tell them they need to connect {label} themselves in settings. You cannot connect it for them, and nothing is connected yet."),
    }))
}

/// Mac host tool. Registered with the connector tools for the owner's own
/// turns only; it never serves a shared request.
pub struct ConnectorRequestConnectTool;

#[async_trait]
impl Tool for ConnectorRequestConnectTool {
    fn name(&self) -> &str {
        REQUEST_CONNECT_TOOL_NAME
    }

    fn description(&self) -> &str {
        REQUEST_CONNECT_DESCRIPTION
    }

    fn parameters_schema(&self) -> Value {
        request_connect_schema()
    }

    fn metadata(&self) -> ToolMetadata {
        ToolMetadata::new(ToolLayer::Observation, ToolRiskLevel::ReadOnly, true)
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
        _cancel: CancellationToken,
    ) -> KordiResult<ToolResult> {
        crate::ensure_tool_allowed(self, ctx)?;
        let value = request_connect_result(&params).map_err(KordiError::Tool)?;
        Ok(crate::support::text_result(value.to_string(), Some(value)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_only_a_settings_link_for_known_providers() {
        let value = request_connect_result(&json!({"provider": "gmail"})).unwrap();
        assert_eq!(
            value["openUrl"],
            "kordi://settings/connectors?provider=gmail"
        );
        assert!(
            value["message"]
                .as_str()
                .unwrap()
                .contains("[Connect Gmail]")
        );
        assert!(
            value["instruction"]
                .as_str()
                .unwrap()
                .contains("themselves")
        );
        for (id, _) in REQUEST_CONNECT_PROVIDERS {
            let value = request_connect_result(&json!({ "provider": id })).unwrap();
            assert_eq!(value["openUrl"], request_connect_url(id));
        }
        assert!(request_connect_result(&json!({"provider": "outlook"})).is_err());
        assert!(request_connect_result(&json!({})).is_err());
        let schema = request_connect_schema();
        assert_eq!(
            schema["properties"]["provider"]["enum"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
    }

    #[tokio::test]
    async fn the_tool_is_owner_only_and_read_only() {
        let tool = ConnectorRequestConnectTool;
        assert!(!tool.allows_shared_requests());
        assert_eq!(tool.metadata().risk, ToolRiskLevel::ReadOnly);
        let ctx = ToolContext::default();
        let result = tool
            .execute(
                json!({"provider": "github"}),
                &ctx,
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            result.details.unwrap()["openUrl"],
            "kordi://settings/connectors?provider=github"
        );
        let shared = ToolContext {
            execution_policy: crate::ExecutionPolicy::Shared,
            ..Default::default()
        };
        assert!(
            tool.execute(
                json!({"provider": "github"}),
                &shared,
                CancellationToken::new()
            )
            .await
            .is_err()
        );
    }
}
