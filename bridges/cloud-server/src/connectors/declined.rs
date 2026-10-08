//! The owner's "Not now" on the Mac approval card (issue 1712, PR 5).
//!
//! A declined `act` call never reaches the provider. The desktop reports it
//! so the activity log shows a `denied` row: through the broker route with
//! `declinedByOwner` while the lease is active, or through the account route
//! `POST /v1/cloud/connectors/:id/audit/declined` when the lease lapsed while
//! the card was open. Neither path can run a tool.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use serde::Deserialize;
use serde_json::json;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::auth::routes::CloudSession;
use crate::server::ServerState;

use super::broker::codes;
use super::delivery::{load_active_lease, LeaseHolder};
use super::models::{
    AuditOutcome, BrokerCallRequest, BrokerCallResponse, ConnectorStatus, ConnectorToolGroup,
};
use super::store::{self, NewAuditEntry};
use super::ConnectorRuntime;

/// Error code a recorded decline answers with.
pub const DECLINED_BY_OWNER: &str = "declined_by_owner";

/// Summary written on the `denied` audit row.
pub const DECLINED_SUMMARY: &str = "Denied: You declined this in Kordi. Nothing was changed.";

fn failure(code: &str, message: &str) -> BrokerCallResponse {
    BrokerCallResponse::failure(code, message)
}

/// Records a decline for a tool on `holder`'s active lease. Never executes
/// the tool. Answers `declined_by_owner` once the row is written.
pub async fn record_on_lease(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    holder: &LeaseHolder,
    request: &BrokerCallRequest,
) -> BrokerCallResponse {
    let lease = match load_active_lease(pool, request.lease_id.trim(), holder).await {
        Ok(Some(lease)) => lease,
        Ok(None) => {
            return failure(
                codes::LEASE_INVALID,
                "This run has no active lease for connector tools.",
            )
        }
        Err(_) => return failure(codes::SERVER_ERROR, "Could not reach connector storage."),
    };
    if !lease.requester_is_owner {
        return failure(
            codes::REQUESTER_NOT_OWNER,
            "Only the owner's own runs can use connector tools.",
        );
    }
    let connector_id = request.connector_id.trim();
    let tool = request.tool.trim();
    if !lease.has_tool(connector_id, tool) {
        return failure(
            codes::NOT_ON_LEASE,
            "This tool is not available to this run.",
        );
    }
    let connector = match store::load_account_connector(pool, &lease.account_id, connector_id).await
    {
        Ok(Some(connector)) if connector.status != ConnectorStatus::Revoked => connector,
        Ok(_) => return failure(codes::NOT_FOUND, "Connector not found."),
        Err(_) => return failure(codes::SERVER_ERROR, "Could not reach connector storage."),
    };
    let group = runtime
        .providers
        .get(&connector.provider)
        .and_then(|provider| provider.tool_group(tool))
        .unwrap_or(ConnectorToolGroup::Act);
    let written = store::insert_audit(
        pool,
        NewAuditEntry {
            connector_id: &connector.connector_id,
            account_id: &connector.account_id,
            run_id: Some(&lease.run_id),
            agent_id: Some(&lease.agent_id),
            tool,
            tool_group: group,
            outcome: AuditOutcome::Denied,
            summary: DECLINED_SUMMARY,
        },
    )
    .await;
    if let Err(error) = written {
        eprintln!("[connectors] audit declined for {connector_id}: {error}");
        return failure(codes::SERVER_ERROR, "Could not record the decline.");
    }
    failure(
        DECLINED_BY_OWNER,
        "You declined this in Kordi. Nothing was changed.",
    )
}

/// Body of the account route: the declined tool and a short description.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclinedAuditRequest {
    pub tool: String,
    #[serde(default)]
    pub summary: String,
    /// The run that asked, when the desktop still knows it. Recorded only
    /// when the account owns that run.
    #[serde(default)]
    pub run_id: Option<String>,
}

#[derive(Debug)]
pub enum DeclinedAuditError {
    NotFound,
    UnknownTool,
    Storage(sqlx_core::Error),
}

impl From<sqlx_core::Error> for DeclinedAuditError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Storage(error)
    }
}

/// Single line, at most 200 characters.
fn short_summary(summary: &str) -> String {
    summary
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(200)
        .collect()
}

/// Records a decline for one of `account_id`'s connectors without a lease.
/// Only an `act` tool the provider knows can be named.
pub async fn record_for_account(
    pool: &PgPool,
    runtime: &ConnectorRuntime,
    account_id: &str,
    connector_id: &str,
    request: &DeclinedAuditRequest,
) -> Result<(), DeclinedAuditError> {
    let tool = request.tool.trim();
    let connector = store::load_account_connector(pool, account_id, connector_id.trim())
        .await?
        .filter(|connector| connector.status != ConnectorStatus::Revoked)
        .ok_or(DeclinedAuditError::NotFound)?;
    let group = runtime
        .providers
        .get(&connector.provider)
        .and_then(|provider| provider.tool_group(tool));
    if group != Some(ConnectorToolGroup::Act) {
        return Err(DeclinedAuditError::UnknownTool);
    }
    let run: Option<(String, Option<String>)> = match request.run_id.as_deref().map(str::trim) {
        Some(run_id) if !run_id.is_empty() && run_id.len() <= 256 => {
            query_as(
                "SELECT run_id, execution_agent_id FROM cloud_agent_fallback_runs \
                 WHERE run_id = $1 AND owner_account_id = $2",
            )
            .bind(run_id)
            .bind(account_id)
            .fetch_optional(pool)
            .await?
        }
        _ => None,
    };
    let detail = short_summary(&request.summary);
    let summary = if detail.is_empty() {
        DECLINED_SUMMARY.to_string()
    } else {
        format!("{DECLINED_SUMMARY} ({detail})")
    };
    store::insert_audit(
        pool,
        NewAuditEntry {
            connector_id: &connector.connector_id,
            account_id: &connector.account_id,
            run_id: run.as_ref().map(|(run_id, _)| run_id.as_str()),
            agent_id: run.as_ref().and_then(|(_, agent)| agent.as_deref()),
            tool,
            tool_group: ConnectorToolGroup::Act,
            outcome: AuditOutcome::Denied,
            summary: &summary,
        },
    )
    .await?;
    Ok(())
}

pub(super) async fn declined_route(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(connector_id): Path<String>,
    Json(input): Json<DeclinedAuditRequest>,
) -> Response {
    let recorded = record_for_account(
        state.db_pool(),
        state.connectors(),
        &session.account_id,
        &connector_id,
        &input,
    )
    .await;
    match recorded {
        Ok(()) => Json(json!({ "recorded": true })).into_response(),
        Err(DeclinedAuditError::NotFound) => super::routes::error(
            codes::NOT_FOUND,
            "Connector not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(DeclinedAuditError::UnknownTool) => super::routes::error(
            codes::UNKNOWN_TOOL,
            "This connector has no such tool.",
            StatusCode::BAD_REQUEST,
        ),
        Err(DeclinedAuditError::Storage(error)) => {
            super::routes::server_error("record declined", error)
        }
    }
}
