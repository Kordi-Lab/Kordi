//! Ending a relationship: withdrawing a request and removing a contact.

use super::*;
use crate::relationships::{delete_contact_pair, lock_pair};

/// `POST /v1/cloud/contacts/requests/:request_id/withdraw` — the sender takes
/// back a pending request. Anyone else gets 404, as if it did not exist.
pub(super) async fn withdraw_contact_request(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(request_id): axum::extract::Path<String>,
) -> Response {
    let pool = state.db_pool();
    let request_id = request_id.trim().to_string();
    let row: Option<(String, String)> = match query_as(
        "SELECT from_account_id, to_account_id FROM cloud_contact_requests WHERE request_id = $1",
    )
    .bind(&request_id)
    .fetch_optional(pool)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let Some((from_id, to_id)) = row.filter(|(from_id, _)| *from_id == session.account_id) else {
        return err(
            "not_found",
            "Contact request not found.",
            StatusCode::NOT_FOUND,
        );
    };
    match decide_pending_request(pool, &request_id, &from_id, &to_id, "withdrawn").await {
        Ok(true) => {}
        Ok(false) => return request_decided(),
        Err(_) => {
            return err(
                "server_error",
                "Could not withdraw the request.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    }

    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "contact.request.withdrawn",
        serde_json::json!({ "request_id": request_id, "to": to_id }),
    )
    .await;
    let events = state.events().clone();
    tokio::spawn(async move {
        events
            .publish_contact_request_event(
                crate::events::ContactRequestEventKind::Withdrawn,
                &request_id,
                &from_id,
                &to_id,
            )
            .await;
    });
    StatusCode::NO_CONTENT.into_response()
}

/// `DELETE /v1/cloud/contacts/:peer_account_id` — both accounts stop being
/// contacts. Chat history stays readable; sending in their direct chat,
/// calls, presence, and default-agent access stop until a new request is
/// accepted. Always 204, so repeating it is harmless.
pub(super) async fn remove_contact(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(peer_account_id): axum::extract::Path<String>,
) -> Response {
    let peer = peer_account_id.trim().to_string();
    if !peer.starts_with("acct_") {
        return err(
            "invalid_account_id",
            "A valid account id is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let pool = state.db_pool();
    let removed = match remove_contact_pair(pool, &session.account_id, &peer).await {
        Ok(removed) => removed,
        Err(_) => {
            return err(
                "server_error",
                "Could not remove the contact.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if removed {
        let _ = write_audit(
            pool,
            Some(&session.account_id),
            Some(&session.device_id),
            "contact.removed",
            serde_json::json!({ "peer": peer }),
        )
        .await;
        // Best effort: a call left ringing is also ended when either side
        // answers or hangs up, and joining an ended call is refused.
        if let Err(error) =
            crate::calls::end_direct_calls_between(pool, &session.account_id, &peer).await
        {
            eprintln!("[contacts] end direct calls after removal: {error:?}");
        }
    }
    StatusCode::NO_CONTENT.into_response()
}

/// Deletes both contact rows under the pair lock (a leftover one-way row is
/// cleared too) and, when the two had accepted each other, tells both
/// accounts' devices to refresh their directory. Returns whether they were
/// contacts.
async fn remove_contact_pair(
    pool: &PgPool,
    account_id: &str,
    peer: &str,
) -> Result<bool, crate::chat_sync::store::StoreError> {
    let mut tx = pool.begin().await?;
    lock_pair(&mut tx, account_id, peer).await?;
    if !delete_contact_pair(&mut tx, account_id, peer).await? {
        tx.commit().await?;
        return Ok(false);
    }
    for (recipient, other) in [(account_id, peer), (peer, account_id)] {
        crate::chat_sync::store::append_user_sync_events_in_transaction(
            &mut tx,
            &[recipient.to_string()],
            "account.directory.changed",
            None,
            &serde_json::json!({ "accountId": other, "reason": "contact_removed" }),
        )
        .await?;
    }
    tx.commit().await?;
    Ok(true)
}
