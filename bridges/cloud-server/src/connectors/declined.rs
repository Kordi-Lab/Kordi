//! The owner's "Not now" on the Mac approval card (issue 1712, PR 5).
//!
//! A declined `act` call never reaches the provider. The desktop reports it
//! so the activity log shows a `denied` row: through the broker route with
//! `declinedByOwner` while the lease is active.

use sqlx_postgres::PgPool;

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
        return failure(codes::NOT_ON_LEASE, "This tool is not available to this run.");
    }
    let connector = match store::load_account_connector(pool, &lease.account_id, connector_id)
        .await
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
