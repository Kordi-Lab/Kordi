use rusqlite::{Connection, TransactionBehavior};

use super::super::{
    open_db, open_or_create_session_in_db, upsert_identity_in_db, upsert_message_in_transaction,
    ApplyCanonicalSelfAgentSyncPlanRequest, CanonicalSelfAgentSyncBatch,
    OpenCanonicalSessionFastResult,
};
use super::groups::select_session_participants;

const MAX_SELF_AGENT_SYNC_SESSIONS: usize = 2_000;
const MAX_SELF_AGENT_SYNC_MESSAGES: usize = 20_000;

pub(crate) fn apply_canonical_self_agent_sync_plan_in_db(
    conn: &mut Connection,
    request: ApplyCanonicalSelfAgentSyncPlanRequest,
) -> Result<CanonicalSelfAgentSyncBatch, String> {
    if request.session_requests.len() > MAX_SELF_AGENT_SYNC_SESSIONS {
        return Err(format!(
            "At most {MAX_SELF_AGENT_SYNC_SESSIONS} self-agent sessions can be restored at once"
        ));
    }
    if request.message_requests.len() > MAX_SELF_AGENT_SYNC_MESSAGES {
        return Err(format!(
            "At most {MAX_SELF_AGENT_SYNC_MESSAGES} self-agent messages can be restored at once"
        ));
    }

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let identity = upsert_identity_in_db(&tx, request.agent_identity_request)?;
    let mut sessions = Vec::with_capacity(request.session_requests.len());
    for session_request in request.session_requests {
        let session = open_or_create_session_in_db(&tx, session_request)?;
        let participants = select_session_participants(&tx, &session.id)?;
        sessions.push(OpenCanonicalSessionFastResult {
            session,
            participants,
        });
    }
    let mut messages = Vec::with_capacity(request.message_requests.len());
    for message_request in request.message_requests {
        messages.push(upsert_message_in_transaction(&tx, message_request)?);
    }
    tx.commit().map_err(|error| error.to_string())?;

    Ok(CanonicalSelfAgentSyncBatch {
        identity,
        sessions,
        messages,
    })
}

pub(crate) fn desktop_canonical_apply_self_agent_sync_plan(
    request: ApplyCanonicalSelfAgentSyncPlanRequest,
) -> Result<CanonicalSelfAgentSyncBatch, String> {
    let mut conn = open_db()?;
    apply_canonical_self_agent_sync_plan_in_db(&mut conn, request)
}
