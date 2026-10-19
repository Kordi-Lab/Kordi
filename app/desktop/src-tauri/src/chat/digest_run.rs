//! A digest run on this Mac (the server's `digest::desktop`).
//!
//! The server hands a claimed digest run's prompt, system prompt, and two
//! read-only observation tools to this command. It runs one turn in a
//! throwaway profiled session with the owner's local provider route and no
//! other tools; each tool call goes back to the server, which answers it from
//! the run's frozen input. The reply text goes back to the caller, which
//! submits it to the server for the same checks a cloud reply gets.

use std::sync::Arc;

use kordi_cli::desktop_runtime::{DesktopRuntimeProfile, DesktopRuntimeSession};
use kordi_core::error::KordiError;
use kordi_tools::connector_tools::{
    ConnectorCallFuture, ConnectorToolDescriptor, ConnectorToolGroup, ConnectorToolsRuntime,
};
use kordi_tools::ExecutionPolicy;
use serde::Deserialize;
use serde_json::{json, Value};

use super::DesktopChatMessageRoute;

const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopDigestTool {
    name: String,
    description: String,
    #[serde(default)]
    parameters: Value,
}

fn descriptors(tools: &[DesktopDigestTool]) -> Vec<ConnectorToolDescriptor> {
    tools
        .iter()
        .map(|tool| ConnectorToolDescriptor {
            connector_id: "digest".into(),
            provider: "digest".into(),
            name: tool.name.clone(),
            group: ConnectorToolGroup::Read,
            description: tool.description.clone(),
            input_schema: if tool.parameters.is_object() {
                tool.parameters.clone()
            } else {
                json!({"type": "object"})
            },
        })
        .collect()
}

fn observe_body(claim_id: &str, tool: &str, arguments: Value) -> Value {
    json!({"claimId": claim_id, "tool": tool, "arguments": arguments})
}

async fn post_observe(url: &str, token: &str, body: &Value) -> Result<Value, KordiError> {
    let unavailable = || KordiError::Tool("The digest input could not be read.".into());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| unavailable())?;
    let mut response = client
        .post(url)
        .bearer_auth(token)
        .json(body)
        .send()
        .await
        .map_err(|_| unavailable())?;
    if !response.status().is_success() {
        return Err(unavailable());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(unavailable());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| unavailable())
}

/// The observation tools, each call answered by the server for this claim.
fn observation_runtime(
    run_id: &str,
    claim_id: &str,
    tools: &[DesktopDigestTool],
    api_base: &str,
    token: String,
) -> ConnectorToolsRuntime {
    let url = format!(
        "{}/v1/cloud/digest/desktop/{run_id}/observe",
        api_base.trim_end_matches('/')
    );
    let claim_id = claim_id.to_string();
    ConnectorToolsRuntime {
        descriptors: descriptors(tools),
        call: Arc::new(move |tool, arguments| {
            let (url, token) = (url.clone(), token.clone());
            let body = observe_body(&claim_id, &tool.name, arguments);
            Box::pin(async move { post_observe(&url, &token, &body).await }) as ConnectorCallFuture
        }),
        report_declined: None,
        offer_request_connect: false,
    }
}

/// The execution lease this Mac holds for the digest run.
fn lease(
    run_id: &str,
    claim_id: &str,
    owner_account_id: &str,
) -> Result<kordi_cli::desktop_runtime::DesktopCloudExecutionLease, String> {
    serde_json::from_value(json!({
        "sessionId": format!("digest:{owner_account_id}"),
        "runId": run_id,
        "claimId": claim_id,
        "ownerAccountId": owner_account_id,
    }))
    .map_err(|error| error.to_string())
}

/// Runs one claimed digest run and returns the model's reply.
#[tauri::command]
pub async fn desktop_digest_run(
    run_id: String,
    claim_id: String,
    owner_account_id: String,
    system_prompt: String,
    prompt: String,
    tools: Vec<DesktopDigestTool>,
    route: DesktopChatMessageRoute,
) -> Result<String, String> {
    let session = crate::cloud_session::cloud_session_load()?
        .filter(|session| session.account_id == owner_account_id && !session.token.is_empty())
        .ok_or_else(|| "Sign in to Kordi to run the digest.".to_string())?;
    let api_base = crate::cloud_api_base_url_from_env()?;
    let workspace = std::env::temp_dir().join("kordi-digest-runs");
    std::fs::create_dir_all(&workspace).map_err(|error| error.to_string())?;
    // A hosted account has no credential on this Mac: the server hands over
    // short-lived material for this claimed run, exactly as for a chat turn.
    let hosted = super::hosted_provider_auth::route_uses_hosted_auth(Some(&route));
    let hosted_auth = if hosted {
        Some(
            super::hosted_provider_auth::resolve_for_lease(
                &route,
                &lease(&run_id, &claim_id, &owner_account_id)?,
            )
            .await?,
        )
    } else {
        None
    };
    let profile = DesktopRuntimeProfile {
        provider: if hosted {
            None
        } else {
            route.auth_provider.clone()
        },
        model: if hosted { None } else { route.model.clone() },
        thinking: route.thinking.clone(),
        system_prompt: Some(system_prompt),
        // Only the observation tools: no files, shell, network, or messages.
        tool_names: Some(tools.iter().map(|tool| tool.name.clone()).collect()),
        execution_policy: Some(ExecutionPolicy::Safety),
        ..DesktopRuntimeProfile::default()
    };
    let session_id = format!("session:digest:{}", uuid::Uuid::new_v4());
    let result = async {
        let mut runtime =
            DesktopRuntimeSession::create_profiled_with_id(workspace, &session_id, profile)
                .await
                .map_err(|error| error.to_string())?;
        super::message_route::apply_desktop_chat_message_route(&mut runtime, Some(&route))?;
        if let Some(auth) = hosted_auth {
            runtime
                .set_ephemeral_provider_auth_with_options(
                    &auth.provider,
                    auth.auth,
                    auth.base_url,
                    auth.api.as_deref(),
                )
                .map_err(|error| error.to_string())?;
        }
        runtime.set_connector_tools_runtime(Some(observation_runtime(
            &run_id,
            &claim_id,
            &tools,
            &api_base,
            session.token,
        )));
        let detail = runtime
            .send_message(prompt, Vec::new())
            .await
            .map_err(|error| error.to_string())?;
        detail
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "assistant" && !message.text.trim().is_empty())
            .map(|message| message.text.clone())
            .ok_or_else(|| "The model finished without writing a digest.".to_string())
    }
    .await;
    let _ = kordi_cli::desktop_runtime::delete_session_forever(&session_id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_tools_are_read_only_and_call_the_server_for_this_claim() {
        let tools = vec![DesktopDigestTool {
            name: "digest_read_session".into(),
            description: "Read one session.".into(),
            parameters: json!({"type":"object","properties":{"sessionId":{"type":"string"}}}),
        }];
        let descriptors = descriptors(&tools);
        assert_eq!(descriptors.len(), 1);
        assert_eq!(descriptors[0].group, ConnectorToolGroup::Read);
        assert_eq!(
            descriptors[0].input_schema["properties"]["sessionId"]["type"],
            "string"
        );
        let body = observe_body("claim", "digest_read_session", json!({"sessionId":"s1"}));
        assert_eq!(
            body,
            json!({"claimId":"claim","tool":"digest_read_session","arguments":{"sessionId":"s1"}})
        );
        let runtime = observation_runtime(
            "digest_run",
            "claim",
            &tools,
            "http://127.0.0.1:1/",
            "t".into(),
        );
        assert_eq!(
            runtime.tools().len(),
            1,
            "no request-connect tool is offered"
        );
    }
}
