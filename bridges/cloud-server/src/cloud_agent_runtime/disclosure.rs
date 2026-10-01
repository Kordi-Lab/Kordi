//! "About this reply": which agent wrote a reply, whose it is, who asked,
//! where it ran, and, for Kordi Cloud runs, the provider and model the server
//! recorded for that run.
//!
//! `POST /v1/cloud/agent-runs/disclosures` answers only active members of the
//! conversation. Replies run on the owner's Mac report no provider or model:
//! the Mac chooses it and does not tell Kordi. The requested route model is
//! never reported as the model used.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::post,
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::auth::routes::{cloud_session_middleware, CloudSession};
use crate::server::ServerState;

const MAX_REPLIES: usize = 50;

pub fn routes(state: Arc<ServerState>) -> Router {
    Router::new()
        .route("/v1/cloud/agent-runs/disclosures", post(disclosures))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            cloud_session_middleware,
        ))
        .with_state(state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DisclosureRequest {
    session_id: String,
    replies: Vec<ReplyRef>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplyRef {
    key: String,
    request_id: String,
    owner_account_id: String,
}

fn error(code: &str, message: &str, status: StatusCode) -> Response {
    (status, Json(json!({"errorCode": code, "message": message}))).into_response()
}

async fn disclosures(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(input): Json<DisclosureRequest>,
) -> Response {
    if input.replies.is_empty() || input.replies.len() > MAX_REPLIES {
        return error(
            "invalid_disclosure_request",
            "Ask about 1 to 50 replies at a time.",
            StatusCode::BAD_REQUEST,
        );
    }
    // Replies from Kordi's own service agents run on Kordi's model account.
    let mut service_owners: Vec<String> = Vec::new();
    if let Some(support) = state.support() {
        service_owners.push(support.config().owner_account_id.clone());
    }
    if let Some(pip) = crate::pip::service_account_id() {
        service_owners.push(pip.to_string());
    }
    match lookup(
        state.db_pool(),
        &session.account_id,
        &input,
        &service_owners,
    )
    .await
    {
        Ok(Some(disclosures)) => Json(json!({"disclosures": disclosures})).into_response(),
        Ok(None) => error(
            "run_not_found",
            "Details aren't available for this conversation.",
            StatusCode::NOT_FOUND,
        ),
        Err(err) => {
            eprintln!("[cloud_agent_runtime] reply disclosures: {err}");
            error(
                "server_error",
                "Couldn't load details. Try again.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

/// owner, request, backend, agent id, turn identity, requester, provider,
/// model, owner name, requester name, agent name.
type RunRow = (
    String,
    String,
    String,
    String,
    Option<Value>,
    String,
    Option<String>,
    Option<String>,
    String,
    String,
    String,
);

/// `None` when the caller is not an active member of the conversation.
async fn lookup(
    pool: &PgPool,
    account_id: &str,
    input: &DisclosureRequest,
    service_owners: &[String],
) -> Result<Option<Vec<Value>>, sqlx_core::Error> {
    let session_id = input.session_id.trim();
    let conversation: Option<(Uuid, Option<String>)> = query_as(
        "SELECT c.conversation_id, c.legacy_session_id FROM cloud_chat_conversations c
         JOIN cloud_chat_conversation_members m ON m.conversation_id = c.conversation_id
         WHERE (c.legacy_session_id = $1 OR c.conversation_id = $3)
           AND m.account_id = $2 AND m.membership_state = 'active'
         LIMIT 1",
    )
    .bind(session_id)
    .bind(account_id)
    .bind(Uuid::parse_str(session_id).ok())
    .fetch_optional(pool)
    .await?;
    let Some((conversation_id, legacy_session_id)) = conversation else {
        return Ok(None);
    };
    let sessions: Vec<String> = legacy_session_id
        .into_iter()
        .chain([conversation_id.to_string()])
        .collect();
    let owners: Vec<String> = input
        .replies
        .iter()
        .map(|reply| reply.owner_account_id.trim().to_string())
        .collect();
    let requests: Vec<String> = input
        .replies
        .iter()
        .map(|reply| reply.request_id.trim().to_string())
        .collect();
    let rows: Vec<RunRow> = query_as(
        "SELECT DISTINCT ON (r.owner_account_id, r.request_message_id)
                r.owner_account_id, r.request_message_id, r.execution_backend,
                COALESCE(NULLIF(r.execution_agent_id, ''), 'cloud-agent:' || r.owner_account_id),
                r.turn_identity, r.requester_account_id, r.disclosed_provider, r.disclosed_model,
                owner.display_name, requester.display_name,
                COALESCE(definition.name, profile.display_name, 'Kordi')
         FROM cloud_agent_fallback_runs r
         JOIN unnest($2::text[], $3::text[]) AS asked(owner_account_id, request_message_id)
           ON asked.owner_account_id = r.owner_account_id
          AND asked.request_message_id = r.request_message_id
         JOIN cloud_accounts owner ON owner.account_id = r.owner_account_id
         JOIN cloud_accounts requester ON requester.account_id = r.requester_account_id
         LEFT JOIN cloud_agent_definitions definition
           ON definition.agent_id = r.execution_agent_id
          AND definition.owner_account_id = r.owner_account_id
         LEFT JOIN cloud_default_agent_profiles profile
           ON profile.owner_account_id = r.owner_account_id
         WHERE r.session_id = ANY($1)
         ORDER BY r.owner_account_id, r.request_message_id, r.legacy_duplicate, r.created_at DESC",
    )
    .bind(&sessions)
    .bind(&owners)
    .bind(&requests)
    .fetch_all(pool)
    .await?;
    let by_request: HashMap<(String, String), RunRow> = rows
        .into_iter()
        .map(|row| ((row.0.clone(), row.1.clone()), row))
        .collect();
    Ok(Some(
        input
            .replies
            .iter()
            .filter_map(|reply| {
                let key = (
                    reply.owner_account_id.trim().to_string(),
                    reply.request_id.trim().to_string(),
                );
                by_request
                    .get(&key)
                    .map(|row| disclosure(&reply.key, row, service_owners))
            })
            .collect(),
    ))
}

fn disclosure(key: &str, row: &RunRow, service_owners: &[String]) -> Value {
    let (
        owner,
        _,
        backend,
        agent_id,
        identity,
        requester,
        provider,
        model,
        owner_name,
        requester_name,
        agent_name,
    ) = row;
    let label = |field: &str, fallback: &str| {
        identity
            .as_ref()
            .and_then(|identity| identity[field].as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(fallback)
            .to_string()
    };
    let cloud = backend == "cloud";
    let provider = provider.as_deref().filter(|_| cloud);
    json!({
        "key": key,
        "agentId": agent_id,
        "agentName": label("agentName", agent_name),
        "ownerAccountId": owner,
        "ownerName": label("ownerName", owner_name),
        "requesterAccountId": requester,
        "requesterName": label("requesterName", requester_name),
        "runtime": if cloud { "kordi_cloud" } else { "owner_device" },
        "credentials": cloud.then(|| {
            if service_owners.iter().any(|service| service == owner) { "kordi" } else { "owner" }
        }),
        "provider": provider,
        "providerLabel": provider.map(crate::cloud_agent_runtime::provider_auth::provider_display_label),
        "model": model.as_deref().filter(|_| cloud),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(backend: &str, provider: Option<&str>, model: Option<&str>) -> RunRow {
        (
            "acct_owner".into(),
            "request-1".into(),
            backend.into(),
            "cloud-agent:acct_owner".into(),
            Some(json!({"agentName": "Scout", "ownerName": "Olive", "requesterName": "Riley"})),
            "acct_requester".into(),
            provider.map(str::to_string),
            model.map(str::to_string),
            "Olive Account".into(),
            "Riley Account".into(),
            "Kordi".into(),
        )
    }

    #[test]
    fn cloud_runs_disclose_the_recorded_provider_and_model() {
        let value = disclosure("k1", &row("cloud", Some("openai"), Some("gpt-5")), &[]);
        assert_eq!(value["runtime"], "kordi_cloud");
        assert_eq!(value["credentials"], "owner");
        assert_eq!(value["provider"], "openai");
        assert_eq!(value["providerLabel"], "OpenAI");
        assert_eq!(value["model"], "gpt-5");
        assert_eq!(value["agentName"], "Scout");
        assert_eq!(value["ownerName"], "Olive");
        assert_eq!(value["requesterName"], "Riley");
        let service = disclosure("k1", &row("cloud", None, None), &["acct_owner".to_string()]);
        assert_eq!(service["credentials"], "kordi");
        assert_eq!(service["model"], Value::Null);
    }

    #[test]
    fn only_plausible_model_names_are_recorded() {
        let request =
            |model: Option<String>| crate::cloud_agent_runtime::runs::CompleteRunRequest {
                runner_id: "runner".into(),
                response_text: "Done".into(),
                model,
            };
        assert_eq!(
            request(Some(" gpt-5 ".into())).disclosed_model().as_deref(),
            Some("gpt-5")
        );
        assert_eq!(
            request(Some("m".repeat(200)))
                .disclosed_model()
                .map(|m| m.len()),
            Some(200)
        );
        assert_eq!(request(Some("m".repeat(201))).disclosed_model(), None);
        assert_eq!(request(Some("  ".into())).disclosed_model(), None);
        assert_eq!(request(None).disclosed_model(), None);
        let older: crate::cloud_agent_runtime::runs::CompleteRunRequest =
            serde_json::from_value(json!({"runnerId": "runner", "responseText": "Done"})).unwrap();
        assert_eq!(older.disclosed_model(), None);
    }

    #[test]
    fn mac_runs_never_report_a_provider_or_model() {
        let value = disclosure("k2", &row("desktop", Some("openai"), Some("gpt-5")), &[]);
        assert_eq!(value["runtime"], "owner_device");
        assert_eq!(value["credentials"], Value::Null);
        assert_eq!(value["provider"], Value::Null);
        assert_eq!(value["providerLabel"], Value::Null);
        assert_eq!(value["model"], Value::Null);
    }
}
