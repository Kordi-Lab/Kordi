//! The one way two accounts become contacts: a request the other accepts.
//!
//! `POST /v1/cloud/contacts/requests` and the older one-sided
//! `POST /v1/cloud/contacts` both call [`request_or_accept_contact`]. Neither
//! inserts contact rows directly; rows are written only when a request is
//! accepted, and always in pairs.

use sqlx_core::executor::Executor;
use sqlx_postgres::Postgres;

use super::*;
use crate::relationships::{are_contacts, blocks_between, lock_pair};

pub(super) enum ContactRequestOutcome {
    /// The two accounts are already contacts. Nothing changed.
    AlreadyContacts,
    /// The peer had already asked the caller; that request was accepted.
    Accepted(Box<ContactRequestResponse>),
    /// The caller's pending request to the peer, new or existing.
    Pending {
        summary: Box<ContactRequestSummary>,
        created: bool,
    },
}

const MAX_REQUEST_MESSAGE_CHARS: usize = 280;

fn database_error() -> Box<Response> {
    boxed_err(
        "server_error",
        "Database error.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

/// Refuses a request while either account blocks the other. A blocked
/// caller sees a generic refusal; a caller who blocked the peer is told to
/// unblock first.
fn refusal_for_blocks(
    caller_blocked_peer: bool,
    peer_blocked_caller: bool,
) -> Result<(), Box<Response>> {
    if peer_blocked_caller {
        return Err(boxed_err(
            "contact_request_unavailable",
            "You can't send a contact request to this account.",
            StatusCode::FORBIDDEN,
        ));
    }
    if caller_blocked_peer {
        return Err(boxed_err(
            "blocked_account",
            "You blocked this account. Unblock it before sending a contact request.",
            StatusCode::CONFLICT,
        ));
    }
    Ok(())
}

async fn refuse_when_blocked<'e>(
    executor: impl Executor<'e, Database = Postgres>,
    caller: &str,
    peer: &str,
) -> Result<(), Box<Response>> {
    let (caller_blocked_peer, peer_blocked_caller) = blocks_between(executor, caller, peer)
        .await
        .map_err(|_| database_error())?;
    refusal_for_blocks(caller_blocked_peer, peer_blocked_caller)
}

pub(super) async fn request_or_accept_contact(
    state: &Arc<ServerState>,
    session: &CloudSession,
    rate_limiter: &CloudRateLimiter,
    peer_account_id: &str,
    message: Option<&str>,
) -> Result<ContactRequestOutcome, Box<Response>> {
    let peer = peer_account_id.trim().to_string();
    if peer.is_empty() {
        return Err(boxed_err(
            "invalid_account_id",
            "peerAccountId is required.",
            StatusCode::BAD_REQUEST,
        ));
    }
    if peer == session.account_id {
        return Err(boxed_err(
            "self_contact",
            "You cannot send a contact request to yourself.",
            StatusCode::BAD_REQUEST,
        ));
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(CONTACT_ADD_LIMIT, &session.account_id)
        .await
    {
        return Err(Box::new(limited_response(retry_after)));
    }
    let message = message
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            value
                .chars()
                .take(MAX_REQUEST_MESSAGE_CHARS)
                .collect::<String>()
        });

    let pool = state.db_pool();
    let Some(peer_account) = account_response_row(pool, &peer)
        .await
        .map_err(|_| database_error())?
    else {
        return Err(boxed_err(
            "account_missing",
            "No account found with that id.",
            StatusCode::NOT_FOUND,
        ));
    };
    refuse_when_blocked(pool, &session.account_id, &peer).await?;
    if are_contacts(pool, &session.account_id, &peer)
        .await
        .map_err(|_| database_error())?
    {
        return Ok(ContactRequestOutcome::AlreadyContacts);
    }

    // They already asked the caller: accepting it is the caller's answer.
    let inbound: Option<(String,)> = query_as(
        "SELECT request_id FROM cloud_contact_requests \
         WHERE from_account_id = $1 AND to_account_id = $2 AND status = 'pending'",
    )
    .bind(&peer)
    .bind(&session.account_id)
    .fetch_optional(pool)
    .await
    .map_err(|_| database_error())?;
    if let Some((request_id,)) = inbound {
        let accepted = finalize_request_acceptance(
            state,
            session,
            pool,
            &request_id,
            &peer,
            &session.account_id,
        )
        .await?;
        return Ok(ContactRequestOutcome::Accepted(Box::new(accepted)));
    }

    let mut tx = pool.begin().await.map_err(|_| database_error())?;
    lock_pair(&mut tx, &session.account_id, &peer)
        .await
        .map_err(|_| database_error())?;
    // Re-check under the pair lock: a block or an acceptance may have landed.
    refuse_when_blocked(&mut *tx, &session.account_id, &peer).await?;
    if are_contacts(&mut *tx, &session.account_id, &peer)
        .await
        .map_err(|_| database_error())?
    {
        return Ok(ContactRequestOutcome::AlreadyContacts);
    }
    let candidate_id = format!("req_{}", uuid::Uuid::new_v4().simple());
    let inserted = query(
        "INSERT INTO cloud_contact_requests \
         (request_id, from_account_id, to_account_id, status, message, created_at) \
         VALUES ($1, $2, $3, 'pending', $4, $5) ON CONFLICT DO NOTHING",
    )
    .bind(&candidate_id)
    .bind(&session.account_id)
    .bind(&peer)
    .bind(message.as_deref())
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *tx)
    .await
    .map_err(|_| database_error())?
    .rows_affected()
        == 1;
    // The caller's single pending request to this peer, new or existing.
    let pending: Option<(String, Option<String>, String)> = query_as(
        "SELECT request_id, message, created_at FROM cloud_contact_requests \
         WHERE from_account_id = $1 AND to_account_id = $2 AND status = 'pending'",
    )
    .bind(&session.account_id)
    .bind(&peer)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| database_error())?;
    let Some((request_id, stored_message, created_at)) = pending else {
        return Err(database_error());
    };
    tx.commit().await.map_err(|_| database_error())?;

    if inserted {
        let _ = write_audit(
            pool,
            Some(&session.account_id),
            Some(&session.device_id),
            "contact.request.sent",
            serde_json::json!({ "request_id": request_id, "peer": peer }),
        )
        .await;
        let events = state.events().clone();
        let (event_request_id, from, to) =
            (request_id.clone(), session.account_id.clone(), peer.clone());
        tokio::spawn(async move {
            events
                .publish_contact_request_event(
                    crate::events::ContactRequestEventKind::Created,
                    &event_request_id,
                    &from,
                    &to,
                )
                .await;
        });
    }

    Ok(ContactRequestOutcome::Pending {
        summary: Box::new(ContactRequestSummary {
            request_id,
            from_account_id: session.account_id.clone(),
            to_account_id: peer,
            status: "pending".into(),
            direction: "outgoing".into(),
            message: stored_message,
            created_at,
            decided_at: None,
            counterpart: Some(account_to_summary(peer_account)),
        }),
        created: inserted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn error_code(response: Response) -> (StatusCode, String) {
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        (status, body["errorCode"].as_str().unwrap().to_string())
    }

    #[tokio::test]
    async fn a_block_by_the_peer_reads_as_a_generic_refusal() {
        assert!(refusal_for_blocks(false, false).is_ok());
        let unavailable = (
            StatusCode::FORBIDDEN,
            "contact_request_unavailable".to_string(),
        );
        assert_eq!(
            error_code(*refusal_for_blocks(false, true).unwrap_err()).await,
            unavailable
        );
        assert_eq!(
            error_code(*refusal_for_blocks(true, true).unwrap_err()).await,
            unavailable
        );
        assert_eq!(
            error_code(*refusal_for_blocks(true, false).unwrap_err()).await,
            (StatusCode::CONFLICT, "blocked_account".to_string())
        );
    }
}
