//! Owner-only routes under `/v1/cloud/agents/{agent_id}/proactive`, plus
//! `/v1/cloud/proactive/proposals` across all of the caller's agents, mounted
//! with the other agent routes behind the cloud session. `agent_id` is a
//! definition id or the owner's default agent, `cloud-agent:<account_id>`.

use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::agents::{agent_owner, default_owner};
use super::decision::{decide, Choice, DecisionError};
use super::ProactiveSetting;
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

const ACTIVITY_DEFAULT: i64 = 50;
const ACTIVITY_MAX: i64 = 200;
const PROPOSALS_MAX: i64 = 100;
const STATUSES: &[&str] = &[
    "pending", "approved", "declined", "expired", "running", "done", "failed",
];

fn error(code: &str, message: &str, status: StatusCode) -> Response {
    (status, Json(json!({"errorCode": code, "message": message}))).into_response()
}

fn server_error(context: &str, err: sqlx_core::Error) -> Response {
    eprintln!("[proactive] {context}: {err}");
    error(
        "server_error",
        "Could not process the proactive request.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn not_found() -> Response {
    error(
        "cloud_agent_not_found",
        "Cloud Agent definition was not found.",
        StatusCode::NOT_FOUND,
    )
}

fn forbidden() -> Response {
    error(
        "not_agent_owner",
        "Only the agent's owner can do this.",
        StatusCode::FORBIDDEN,
    )
}

/// `Ok(())` when `account` owns `agent_id`.
async fn owner_only(pool: &PgPool, account: &str, agent_id: &str) -> Result<(), Box<Response>> {
    match agent_owner(pool, agent_id).await {
        Ok(Some(owner)) if owner == account => Ok(()),
        Ok(Some(_)) => Err(Box::new(forbidden())),
        Ok(None) => Err(Box::new(not_found())),
        Err(err) => Err(Box::new(server_error("owner check", err))),
    }
}

/// The stored setting of an active definition, or `None` when there is none.
async fn definition_setting(
    pool: &PgPool,
    agent_id: &str,
) -> Result<Option<ProactiveSetting>, sqlx_core::Error> {
    let row: Option<(Value,)> = query_as(
        "SELECT proactive_json FROM cloud_agent_definitions
         WHERE agent_id = $1 AND status = 'active' AND is_system_managed = FALSE",
    )
    .bind(agent_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(value,)| ProactiveSetting::from_stored(&value)))
}

async fn current_setting(pool: &PgPool, agent_id: &str) -> Response {
    let setting = match default_owner(agent_id) {
        Some(owner) => super::setting::default_enabled(pool, owner)
            .await
            .map(|enabled| Some(ProactiveSetting { enabled })),
        None => definition_setting(pool, agent_id).await,
    };
    match setting {
        Ok(Some(setting)) => Json(setting.to_value()).into_response(),
        Ok(None) => not_found(),
        Err(err) => server_error("read setting", err),
    }
}

/// `GET /v1/cloud/agents/{agent_id}/proactive`: `{"enabled": bool}` for a
/// definition or the owner's default agent (`cloud-agent:<account_id>`).
pub(crate) async fn get_setting(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(agent_id): Path<String>,
) -> Response {
    let pool = state.db_pool();
    if let Err(response) = owner_only(pool, &session.account_id, &agent_id).await {
        return *response;
    }
    current_setting(pool, &agent_id).await
}

/// `PUT /v1/cloud/agents/{agent_id}/proactive` with `{"enabled": bool}`.
/// Turning it off cancels queued evaluations and expires pending offers.
pub(crate) async fn put_setting(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(agent_id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let pool = state.db_pool();
    if let Err(response) = owner_only(pool, &session.account_id, &agent_id).await {
        return *response;
    }
    let setting = match ProactiveSetting::parse(&body) {
        Ok(setting) => setting,
        Err(message) => return error("invalid_proactive", &message, StatusCode::BAD_REQUEST),
    };
    if default_owner(&agent_id).is_some() {
        if let Err(err) =
            super::setting::set_default(pool, &session.account_id, setting.enabled).await
        {
            return server_error("store setting", err);
        }
        return current_setting(pool, &agent_id).await;
    }
    let stored = match serde_json::from_value(json!({"proactive": setting.to_value()})) {
        Ok(input) => {
            crate::cloud_agents::store::update_agent_definition(
                pool,
                &session.account_id,
                &agent_id,
                input,
                chrono::Utc::now(),
            )
            .await
        }
        Err(err) => Err(crate::cloud_agents::store::CloudAgentStoreError::Invalid(
            err.to_string(),
        )),
    };
    match stored {
        Ok(Some(agent)) => Json(agent.proactive.to_value()).into_response(),
        Ok(None) => not_found(),
        Err(err) => {
            eprintln!("[proactive] store setting: {err}");
            error(
                "server_error",
                "Could not process the proactive request.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    }
}

/// RFC 3339 in UTC with milliseconds, as the proposal hint writes it.
macro_rules! utc {
    ($column:literal) => {
        concat!(
            "to_char(",
            $column,
            " AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
        )
    };
}

/// One proposal as the routes return it.
const PROPOSAL_SELECT: &str = concat!(
    "SELECT jsonb_build_object(
         'proposalId', p.proposal_id, 'agentId', p.agent_id,
         'conversationId', p.conversation_id::text, 'sessionId', p.session_id,
         'conversationTitle', COALESCE(c.group_title, c.shared_title),
         'triggerMessageId', p.trigger_message_id, 'evidence', p.evidence_json,
         'problem', p.problem, 'offer', p.offer, 'plan', p.plan, 'status', p.status,
         'evaluationRunId', p.evaluation_run_id, 'runId', p.run_id,
         'replyMessageId', CASE WHEN p.status = 'done' THEN run.response_message_id END,
         'error', CASE WHEN p.status = 'failed' THEN run.error_code END,
         'createdAt', ",
    utc!("p.created_at"),
    ",
         'decidedAt', ",
    utc!("p.decided_at"),
    ",
         'expiresAt', ",
    utc!("p.expires_at"),
    ")
     FROM cloud_agent_proactive_proposals p
     LEFT JOIN cloud_chat_conversations c ON c.conversation_id = p.conversation_id
     LEFT JOIN cloud_agent_fallback_runs run ON run.run_id = p.run_id"
);

async fn load_proposal(
    pool: &PgPool,
    proposal_id: &str,
) -> Result<Option<Value>, sqlx_core::Error> {
    let row: Option<(Value,)> = query_as(&format!("{PROPOSAL_SELECT} WHERE p.proposal_id = $1"))
        .bind(proposal_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(proposal,)| proposal))
}

#[derive(Debug, Deserialize)]
pub(crate) struct DecisionBody {
    decision: String,
}

pub(crate) async fn post_decision(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path((agent_id, proposal_id)): Path<(String, String)>,
    Json(body): Json<DecisionBody>,
) -> Response {
    let Some(choice) = Choice::parse(body.decision.trim()) else {
        return error(
            "invalid_decision",
            "decision must be \"allow\" or \"decline\".",
            StatusCode::BAD_REQUEST,
        );
    };
    let pool = state.db_pool();
    match decide(pool, &session.account_id, &agent_id, &proposal_id, choice).await {
        Ok(_) => match load_proposal(pool, &proposal_id).await {
            Ok(Some(proposal)) => Json(json!({"proposal": proposal})).into_response(),
            Ok(None) => not_found(),
            Err(err) => server_error("load proposal", err),
        },
        Err(DecisionError::NotFound) => error(
            "proposal_not_found",
            "The proposal was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(DecisionError::Forbidden) => forbidden(),
        Err(DecisionError::Conflict) => error(
            "proposal_not_pending",
            "This offer is no longer waiting for a decision.",
            StatusCode::CONFLICT,
        ),
        Err(DecisionError::Database(err)) => server_error("decision", err),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProposalsQuery {
    status: Option<String>,
    conversation_id: Option<String>,
}

/// The caller's proposals with `params.status` (default `pending`), for one
/// agent or, with `None`, every agent the caller owns: active definitions
/// and the default agent. Pending proposals past their time are expired
/// first, with their hints, so a pending list never shows them.
async fn proposals(
    pool: &PgPool,
    account: &str,
    agent_id: Option<&str>,
    params: &ProposalsQuery,
) -> Response {
    let status = params
        .status
        .as_deref()
        .map(str::trim)
        .filter(|status| !status.is_empty())
        .unwrap_or("pending");
    if !STATUSES.contains(&status) {
        return error(
            "invalid_status",
            "Unknown proposal status.",
            StatusCode::BAD_REQUEST,
        );
    }
    let conversation = match params.conversation_id.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(id) => match Uuid::parse_str(id) {
            Ok(id) => Some(id),
            Err(_) => {
                return error(
                    "invalid_conversation",
                    "conversationId must be a conversation id.",
                    StatusCode::BAD_REQUEST,
                )
            }
        },
    };
    let expired = async {
        let mut tx = pool.begin().await?;
        super::proposal::expire_due(&mut tx, Some(account)).await?;
        tx.commit().await
    };
    if let Err(err) = expired.await {
        return server_error("expire proposals", err);
    }
    let sql = format!(
        "{PROPOSAL_SELECT} WHERE p.owner_account_id = $1 AND p.status = $2
           AND ($3::text IS NULL OR p.agent_id = $3)
           AND ($4::uuid IS NULL OR p.conversation_id = $4)
           AND (p.agent_id = 'cloud-agent:' || p.owner_account_id
             OR EXISTS (SELECT 1 FROM cloud_agent_definitions d
                        WHERE d.agent_id = p.agent_id AND d.owner_account_id = p.owner_account_id
                          AND d.status = 'active' AND d.is_system_managed = FALSE))
         ORDER BY p.created_at DESC LIMIT $5"
    );
    let rows: Result<Vec<(Value,)>, _> = query_as(&sql)
        .bind(account)
        .bind(status)
        .bind(agent_id)
        .bind(conversation)
        .bind(PROPOSALS_MAX)
        .fetch_all(pool)
        .await;
    match rows {
        Ok(rows) => Json(json!({
            "proposals": rows.into_iter().map(|(proposal,)| proposal).collect::<Vec<_>>()
        }))
        .into_response(),
        Err(err) => server_error("list proposals", err),
    }
}

/// `GET /v1/cloud/agents/{agent_id}/proactive/proposals?status=&conversationId=`
pub(crate) async fn list_proposals(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(agent_id): Path<String>,
    Query(params): Query<ProposalsQuery>,
) -> Response {
    let pool = state.db_pool();
    if let Err(response) = owner_only(pool, &session.account_id, &agent_id).await {
        return *response;
    }
    proposals(pool, &session.account_id, Some(&agent_id), &params).await
}

/// `GET /v1/cloud/proactive/proposals?status=&conversationId=`: the caller's
/// proposals across all of their agents, so a client can show the offers
/// for the open conversation with one call. Other people's never appear.
pub(crate) async fn list_all_proposals(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Query(params): Query<ProposalsQuery>,
) -> Response {
    proposals(state.db_pool(), &session.account_id, None, &params).await
}

#[derive(Debug, Deserialize)]
pub(crate) struct ActivityQuery {
    limit: Option<i64>,
}

type ActivityRow = (
    String,
    String,
    String,
    Option<String>,
    Option<Uuid>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// The decision an evaluation run stands for: `offer` when it made a
/// proposal, `silence` when it completed without one, otherwise `pending`
/// while it runs or `failed`/`cancelled`.
fn activity_decision(run_status: &str, has_proposal: bool) -> &'static str {
    match (run_status, has_proposal) {
        (_, true) => "offer",
        ("completed", false) => "silence",
        ("failed", false) => "failed",
        ("cancelled", false) => "cancelled",
        _ => "pending",
    }
}

pub(crate) async fn list_activity(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(agent_id): Path<String>,
    Query(params): Query<ActivityQuery>,
) -> Response {
    let pool = state.db_pool();
    if let Err(response) = owner_only(pool, &session.account_id, &agent_id).await {
        return *response;
    }
    let limit = params
        .limit
        .unwrap_or(ACTIVITY_DEFAULT)
        .clamp(1, ACTIVITY_MAX);
    let rows: Result<Vec<ActivityRow>, _> = query_as(
        "SELECT run.run_id, run.created_at, run.status, run.error_code, c.conversation_id,
                COALESCE(c.group_title, c.shared_title), p.proposal_id, p.status, p.problem,
                p.run_id, approved.error_code
         FROM cloud_agent_fallback_runs run
         LEFT JOIN cloud_chat_conversations c ON c.legacy_session_id = run.session_id
         LEFT JOIN cloud_agent_proactive_proposals p ON p.evaluation_run_id = run.run_id
         LEFT JOIN cloud_agent_fallback_runs approved ON approved.run_id = p.run_id
         WHERE run.execution_agent_id = $1 AND run.owner_account_id = $2
           AND starts_with(run.run_id, 'proactive_eval_')
         ORDER BY run.created_at DESC LIMIT $3",
    )
    .bind(&agent_id)
    .bind(&session.account_id)
    .bind(limit)
    .fetch_all(pool)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(err) => return server_error("list activity", err),
    };
    let items: Vec<Value> = rows
        .into_iter()
        .map(|row| {
            let decision = activity_decision(&row.2, row.6.is_some());
            let mut item = json!({
                "at": row.1,
                "evaluationRunId": row.0,
                "conversationId": row.4.map(|id| id.to_string()),
                "conversationTitle": row.5,
                "decision": decision,
            });
            if decision == "offer" {
                let status = row.7.unwrap_or_default();
                item["proposalId"] = json!(row.6);
                item["problem"] = json!(row.8);
                item["runId"] = json!(row.9);
                item["error"] = json!(row.10.filter(|_| status == "failed"));
                item["status"] = json!(status);
            } else if decision == "failed" {
                item["error"] = json!(row.3);
            }
            item
        })
        .collect();
    Json(json!({"activity": items})).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn activity_decisions_read_from_the_run_and_proposal() {
        assert_eq!(activity_decision("completed", false), "silence");
        assert_eq!(activity_decision("completed", true), "offer");
        assert_eq!(activity_decision("failed", false), "failed");
        assert_eq!(activity_decision("queued", false), "pending");
        assert_eq!(activity_decision("cancelled", false), "cancelled");
    }
}
