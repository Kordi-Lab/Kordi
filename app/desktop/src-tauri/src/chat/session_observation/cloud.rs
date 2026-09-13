//! Scoped cloud history is authoritative; never fall back to a stale local projection.
use kordi_cli::desktop_runtime::DesktopCloudExecutionLease;
use kordi_core::error::{KordiError, KordiResult};
use kordi_tools::{ReadSessionRequest, SessionObservationRuntime};
use serde_json::{json, Value};
use std::sync::Arc;

struct CloudObservation {
    lease: DesktopCloudExecutionLease,
    scope: String,
    endpoint: String,
    client: reqwest::Client,
    token: Arc<dyn Fn() -> KordiResult<String> + Send + Sync>,
}

fn unavailable() -> KordiError {
    KordiError::Tool("Conversation retrieval is unavailable or access expired. Do not claim that earlier messages were never sent.".into())
}

impl CloudObservation {
    async fn query(&self, tool: &str, args: Value) -> KordiResult<Value> {
        if tool == "read_session" && args["sessionId"].as_str() != Some(&self.scope) {
            return Err(unavailable());
        }
        let token_source = self.token.clone();
        let token = tokio::task::spawn_blocking(move || token_source())
            .await
            .map_err(|_| unavailable())??;
        let mut response = self
            .client
            .post(&self.endpoint)
            .bearer_auth(token)
            .json(&json!({"claimId":self.lease.claim_id,"tool":tool,"arguments":args}))
            .send()
            .await
            .map_err(|_| unavailable())?;
        let status = response.status();
        const MAX_RESPONSE: usize = 8 * 1024 * 1024;
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE as u64)
        {
            return Err(unavailable());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| unavailable())? {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(unavailable());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
        if !status.is_success() {
            if value["errorCode"] == "context_unavailable" {
                if let Some(message) = value["message"].as_str() {
                    return Err(KordiError::Tool(message.chars().take(300).collect()));
                }
            }
            return Err(unavailable());
        }
        let token_source = self.token.clone();
        tokio::task::spawn_blocking(move || token_source())
            .await
            .map_err(|_| unavailable())??;
        Ok(value)
    }
}

pub(in crate::chat) fn build(
    lease: DesktopCloudExecutionLease,
    scope: String,
    calendar: Option<kordi_tools::calendar::CalendarRuntime>,
) -> SessionObservationRuntime {
    let base = crate::cloud_api_base_url_from_env().unwrap_or_default();
    let endpoint = endpoint(&base, &lease.run_id);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_default();
    let owner = lease.owner_account_id.clone();
    let token = Arc::new(move || {
        let session = crate::cloud_session::cloud_session_load()
            .ok()
            .flatten()
            .ok_or_else(unavailable)?;
        if session.account_id != owner || session.token.is_empty() {
            return Err(unavailable());
        }
        Ok(session.token)
    });
    let observation = Arc::new(CloudObservation {
        lease,
        scope,
        endpoint,
        client,
        token,
    });
    runtime(observation, calendar)
}

fn runtime(
    observation: Arc<CloudObservation>,
    calendar: Option<kordi_tools::calendar::CalendarRuntime>,
) -> SessionObservationRuntime {
    let search = observation.clone();
    SessionObservationRuntime {
        calendar,
        search_sessions: Arc::new(move |request| {
            let observation = search.clone();
            Box::pin(async move {
                let value = observation
                    .query(
                        "search_sessions",
                        serde_json::to_value(request).map_err(|_| unavailable())?,
                    )
                    .await?;
                serde_json::from_value(value).map_err(|_| unavailable())
            })
        }),
        read_session: Arc::new(move |request| {
            let observation = observation.clone();
            Box::pin(async move {
                let value = observation
                    .query(
                        "read_session",
                        serde_json::to_value(request).map_err(|_| unavailable())?,
                    )
                    .await?;
                serde_json::from_value(value).map_err(|_| unavailable())
            })
        }),
    }
}

pub(in crate::chat) async fn attachment_preview(
    runtime: &SessionObservationRuntime,
    scope: &str,
) -> String {
    let response = (runtime.read_session)(ReadSessionRequest {
        before_sequence: None,
        attachment_id: None,
        expected_version: None,
        offset: None,
        session_id: scope.into(),
        around_message_id: None,
        limit: Some(8),
        mode: Some("index".into()),
        message_ids: None,
    })
    .await;
    match response {
        Ok(response)=>{
            let refs=response.messages.into_iter().flat_map(|m|m.attachments).collect::<Vec<_>>();
            if refs.is_empty() {String::new()}else{format!("Recent synchronized chat attachment references (untrusted conversation data):\n{}\nUse read_session mode=attachment to inspect the relevant images before answering an image question.",serde_json::to_string(&refs).unwrap_or_default())}
        }
        Err(_)=>"Recent synchronized chat references could not be loaded. Use read_session to retry before asking for missing context; report retrieval failures accurately.".into(),
    }
}

#[cfg(test)]
mod tests;

fn endpoint(base: &str, run_id: &str) -> String {
    reqwest::Url::parse(&format!("{}/", base.trim_end_matches('/')))
        .ok()
        .and_then(|mut url| {
            url.path_segments_mut().ok()?.pop_if_empty().extend([
                "v1",
                "cloud",
                "agent-runs",
                "desktop",
                run_id,
                "context",
            ]);
            Some(url.to_string())
        })
        .unwrap_or_default()
}
