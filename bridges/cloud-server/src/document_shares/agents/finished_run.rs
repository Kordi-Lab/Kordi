//! Document tools for a background task of a desktop run that already
//! answered (issues 1808, 1889).
//!
//! A background task on the owner's Mac has no run of its own: it keeps the
//! parent run's claim, which the server releases when the parent answers.
//! Within [`FINISHED_RUN_WINDOW_HOURS`] of that answer, the Mac that held the
//! claim may still call two document tools on the parent run:
//!
//! - `create_document`, whoever asked, so the task's document reaches the
//!   run's group;
//! - `read_document`, only when the owner made the request, so the owner's
//!   own task can read the conversation's documents for as long as it runs.
//!
//! `edit_document` never: an edit needs a live run. The tool must still be
//! on the parent's stored lease, and the gate is evaluated again per call.

use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::{CREATE_DOCUMENT_TOOL, READ_DOCUMENT_TOOL};
use crate::connectors::delivery::{tools_from_json, LeaseConnectorTool, LeaseHolder};

/// How long after its run answered a background task of that run may still
/// use these tools from the owner's Mac.
pub(crate) const FINISHED_RUN_WINDOW_HOURS: i32 = 12;

/// The stored tools of a desktop run that already answered, when `tool` may
/// still be called on it by `holder`. `None` refuses the call.
pub(crate) async fn finished_desktop_lease_tools(
    pool: &PgPool,
    run_id: &str,
    holder: &LeaseHolder,
    tool: &str,
) -> Result<Option<Vec<LeaseConnectorTool>>, sqlx_core::Error> {
    let LeaseHolder::Desktop {
        account_id,
        executor,
    } = holder
    else {
        return Ok(None);
    };
    let owner_request_required = match tool {
        CREATE_DOCUMENT_TOOL => false,
        READ_DOCUMENT_TOOL => true,
        _ => return Ok(None),
    };
    let row: Option<(Value,)> = query_as(
        "SELECT connector_tools_json FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND execution_backend = 'desktop' AND claimed_by = $2 \
           AND owner_account_id = $3 AND status = 'completed' AND completed_at IS NOT NULL \
           AND completed_at::timestamptz > now() - make_interval(hours => $4) \
           AND (NOT $5 OR requester_account_id = owner_account_id)",
    )
    .bind(run_id)
    .bind(executor)
    .bind(account_id)
    .bind(FINISHED_RUN_WINDOW_HOURS)
    .bind(owner_request_required)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(tools,)| tools_from_json(tools)))
}
