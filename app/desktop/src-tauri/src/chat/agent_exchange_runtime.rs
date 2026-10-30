//! Cloud transports messages; the existing lease still runs tools on the Mac.
use kordi_cli::desktop_runtime::DesktopCloudExecutionLease;
use kordi_core::error::{KordiError, KordiResult};
use kordi_tools::{ReachOutRequest, ReachOutResponse, ReachOutRuntime};
use serde_json::{json, Value};
use std::sync::Arc;

fn unavailable() -> KordiError {
    KordiError::Tool("Agent communication is unavailable or this execution lease expired. Do not claim that a request was sent.".into())
}
struct Transport {
    lease: DesktopCloudExecutionLease,
    endpoint: String,
    client: reqwest::Client,
}
impl Transport {
    async fn call(&self, action: &str, id: &str, args: Value) -> KordiResult<Value> {
        let owner = self.lease.owner_account_id.clone();
        let token = tokio::task::spawn_blocking(move || {
            let session = crate::cloud_session::cloud_session_load()
                .ok()
                .flatten()
                .ok_or_else(unavailable)?;
            if session.account_id != owner || session.token.is_empty() {
                return Err(unavailable());
            }
            Ok(session.token)
        })
        .await
        .map_err(|_| unavailable())??;
        let response=self.client.post(&self.endpoint).bearer_auth(token).json(&json!({"claimId":self.lease.claim_id,"action":action,"toolCallId":id,"arguments":args})).send().await.map_err(|_|unavailable())?;
        if !response.status().is_success() {
            return Err(unavailable());
        }
        response.json().await.map_err(|_| unavailable())
    }
}

pub(super) async fn build(
    lease: Option<&DesktopCloudExecutionLease>,
    owner_request: bool,
) -> Option<(ReachOutRuntime, String)> {
    if !owner_request {
        return None;
    }
    let lease = lease?.clone();
    let base = crate::cloud_api_base_url_from_env().ok()?;
    let transport = Arc::new(Transport {
        endpoint: format!(
            "{}/v1/cloud/agent-runs/desktop/{}/agent-exchange",
            base.trim_end_matches('/'),
            lease.run_id
        ),
        lease,
        client: reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok()?,
    });
    // A missing capability on an older backend leaves the tool hidden.
    let capabilities = transport.call("capabilities", "", json!({})).await.ok()?;
    if capabilities["available"] != true || capabilities["targets"].as_array()?.is_empty() {
        return None;
    }
    let guidance = format!(
        "Use reach_out to contact another agent in this conversation. Send only the explicit question, never private context or files. Use an exact agentId or an unambiguous @handle from this directory: {}. A successful call queues the request. Briefly acknowledge and end this turn; the reply automatically resumes the original task. Do not poll or resend.",
        capabilities["targets"]
    );
    Some((
        ReachOutRuntime {
            reach_out: Arc::new(move |request: ReachOutRequest| {
                let transport = transport.clone();
                Box::pin(async move {
                    let id = request.tool_call_id.as_deref().ok_or_else(unavailable)?;
                    let response = transport
                        .call(
                            "send",
                            id,
                            json!({"target":request.target,"message":request.message}),
                        )
                        .await?;
                    Ok(ReachOutResponse {
                        conversation_id: response["exchangeId"]
                            .as_str()
                            .ok_or_else(unavailable)?
                            .into(),
                        target_kind: "agent".into(),
                        target_display_name: response["target"]["name"]
                            .as_str()
                            .unwrap_or("Agent")
                            .into(),
                        target_owner_name: None,
                        response_text: Some(
                            response["message"].as_str().unwrap_or_default().into(),
                        ),
                        status: response["status"].as_str().unwrap_or("pending").into(),
                        timed_out: false,
                    })
                })
            }),
        },
        guidance,
    ))
}
