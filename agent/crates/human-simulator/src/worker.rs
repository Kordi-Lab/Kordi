use anyhow::{Context, Result};
use chrono::Utc;
use reqwest::Method;
use serde_json::{Value, json};
use tokio::time::{Duration, sleep};
use uuid::Uuid;

use crate::client::{AccountClient, AccountCredentials, ApiClient, required_env};
use crate::protocol::*;

pub async fn run(actor: &str) -> Result<()> {
    let api = ApiClient::new(
        &required_env("KORDI_SIMULATOR_API_BASE")?,
        required_env("KORDI_SIM_ACTOR_TOKEN")?,
    )?;
    run_configured(api, actor, AccountCredentials::from_env()?).await
}

pub async fn run_configured(
    api: ApiClient,
    actor: &str,
    credentials: AccountCredentials,
) -> Result<()> {
    anyhow::ensure!(
        !actor.is_empty()
            && actor.len() <= 64
            && actor
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Invalid actor ID"
    );
    let path = format!("/v1/sim/actors/{actor}");
    let status: Value = api.get(&format!("{path}/status")).await?;
    if matches!(status["status"].as_str(), Some("finished" | "stopped")) {
        return Ok(());
    }
    let owner = Uuid::new_v4();
    let mut view: ActorView = api
        .post(&format!("{path}/lease"), &LeaseRequest { owner })
        .await?;
    let ownership = OwnedRequest {
        owner,
        generation: view.generation,
    };
    let connected =
        AccountClient::connect(&view.kordi_api_base, &view.config.account_id, credentials).await;
    let mut account = match connected {
        Ok(account) => account,
        Err(error) => {
            let _ = api
                .post::<Value>(&format!("{path}/release"), &ownership)
                .await;
            return Err(error);
        }
    };
    // Login may outlast the lease. Revalidate before dispatching any pending send.
    renew(&api, &path, &ownership).await?;
    // Renewal runs independently of provider calls. Losing ownership cancels the work loop.
    let work = work_loop(&api, &path, &ownership, &mut view, &mut account);
    tokio::pin!(work);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    heartbeat.tick().await;
    let result = loop {
        tokio::select! {
            result = &mut work => break result,
            _ = heartbeat.tick() => {
                if renew(&api, &path, &ownership).await.is_err() {
                    break Err(anyhow::anyhow!("Actor ownership lost or control service unavailable; stopping dispatch"));
                }
            },
            _ = crate::shutdown_signal() => break Ok(()),
        }
    };
    // Pending actions were checkpointed before dispatch; release never erases them.
    let _ = api
        .post::<Value>(&format!("{path}/release"), &ownership)
        .await;
    result
}

async fn renew(api: &ApiClient, path: &str, owned: &OwnedRequest) -> Result<()> {
    tokio::time::timeout(
        Duration::from_secs(10),
        api.post::<Value>(&format!("{path}/heartbeat"), owned),
    )
    .await
    .context("Lease renewal timed out")??;
    Ok(())
}

async fn work_loop(
    api: &ApiClient,
    path: &str,
    owned: &OwnedRequest,
    view: &mut ActorView,
    account: &mut AccountClient,
) -> Result<()> {
    loop {
        if view.state.status != "running" {
            return Ok(());
        }
        if let Some(pending) = view.state.pending.clone() {
            // Re-sending after a crash uses the identical canonical client_message_id.
            let message: Value = account
                .request(
                    Method::POST,
                    &format!(
                        "/v2/chat/conversations/{}/messages",
                        view.config.conversation_id
                    ),
                    &json!({"client_message_id":pending.client_message_id,"kind":"text",
                    "content":{"schema":1,"blocks":[{"type":"text","text":pending.text}]},
                    "reply_to_message_id":null,"attachment_ids":[]}),
                )
                .await?;
            let message_id = message["message"]["id"]
                .as_str()
                .context("Kordi returned no canonical message ID")?
                .parse()?;
            *view = api
                .post(
                    &format!("{path}/confirm"),
                    &ConfirmRequest {
                        owner: owned.owner,
                        generation: owned.generation,
                        revision: view.revision,
                        client_message_id: pending.client_message_id,
                        message_id,
                    },
                )
                .await?;
            println!(
                "{{\"event\":\"message_confirmed\",\"messages_sent\":{}}}",
                view.messages_sent
            );
            continue;
        }
        let cursor = view.state.cursor.as_deref().unwrap_or_default();
        let query: String = reqwest::Url::parse_with_params(
            "http://localhost/v2/chat/sync",
            if cursor.is_empty() {
                // Canonical content can be 256 KiB per event. Keep pages
                // within the bounded HTTP decoder even for large messages.
                vec![("limit", "4")]
            } else {
                vec![("limit", "4"), ("cursor", cursor)]
            },
        )?
        .query()
        .unwrap_or_default()
        .to_owned();
        let sync: Value = account
            .request(Method::GET, &format!("/v2/chat/sync?{query}"), &Value::Null)
            .await?;
        let events = sync["events"]
            .as_array()
            .context("Sync response has no events")?;
        let next = sync["next_cursor"]
            .as_str()
            .context("Sync response has no cursor")?
            .to_string();
        if view.state.cursor.as_ref() != Some(&next) || !view.state.initialized {
            let mut state = view.state.clone();
            state.apply_events(&view.config, events, next);
            *view = api
                .post(
                    &format!("{path}/checkpoint"),
                    &CheckpointRequest {
                        owner: owned.owner,
                        generation: owned.generation,
                        revision: view.revision,
                        state,
                    },
                )
                .await?;
        }
        if sync["has_more"] == true {
            continue;
        }
        let due = view.state.wake_at.is_some_and(|at| at <= Utc::now());
        if view.state.needs_decision || due {
            *view = api
                .post(
                    &format!("{path}/decide"),
                    &DecisionRequest {
                        owner: owned.owner,
                        generation: owned.generation,
                        revision: view.revision,
                    },
                )
                .await?;
            println!(
                "{{\"event\":\"decision_persisted\",\"model_calls\":{}}}",
                view.model_calls
            );
            continue;
        }
        sleep(Duration::from_secs(view.config.poll_seconds)).await;
    }
}
