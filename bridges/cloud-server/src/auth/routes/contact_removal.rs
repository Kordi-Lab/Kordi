//! `DELETE /v1/cloud/contacts/:account_id` (#1945): removes a contact for
//! both accounts. The direct conversation and its messages stay; adding the
//! person again takes a new request, which the existing flow accepts as
//! usual (including the mutual-request auto-accept, which only reads
//! pending requests and contact rows).

use super::*;

#[cfg(test)]
mod tests;

pub(super) async fn remove_contact(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(account_id): axum::extract::Path<String>,
) -> Response {
    let peer = account_id.trim().to_string();
    if peer == session.account_id {
        return err(
            "self_contact",
            "You cannot remove yourself.",
            StatusCode::BAD_REQUEST,
        );
    }
    if state
        .support()
        .is_some_and(|support| support.config().owner_account_id == peer)
    {
        return err(
            "system_contact",
            "This contact can't be removed.",
            StatusCode::FORBIDDEN,
        );
    }
    let pool = state.db_pool();
    let removed = match remove_both_sides(pool, &session.account_id, &peer).await {
        Ok(removed) => removed,
        Err(error) => {
            eprintln!("[contacts] remove contact: {error}");
            return err(
                "server_error",
                "Could not remove the contact.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if !removed {
        return err(
            "contact_not_found",
            "This contact isn't available.",
            StatusCode::NOT_FOUND,
        );
    }
    let _ = write_audit(
        pool,
        Some(&session.account_id),
        Some(&session.device_id),
        "contact.removed",
        serde_json::json!({ "peer": peer }),
    )
    .await;
    let events = state.events().clone();
    let actor = session.account_id.clone();
    tokio::spawn(async move {
        events.publish_contact_removed(&actor, &peer).await;
        events.publish_contact_removed(&peer, &actor).await;
    });
    StatusCode::NO_CONTENT.into_response()
}

/// Deletes both contact rows and the accepted requests that made them, so no
/// accepted request outlives the contact. `false` when the caller had no
/// contact row for `peer`.
async fn remove_both_sides(pool: &PgPool, viewer: &str, peer: &str) -> sqlx_core::Result<bool> {
    let mut tx = pool.begin().await?;
    let mine = query("DELETE FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2")
        .bind(viewer)
        .bind(peer)
        .execute(&mut *tx)
        .await?;
    if mine.rows_affected() == 0 {
        return Ok(false);
    }
    query("DELETE FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2")
        .bind(peer)
        .bind(viewer)
        .execute(&mut *tx)
        .await?;
    query(
        "DELETE FROM cloud_contact_requests WHERE status = 'accepted' \
           AND ((from_account_id = $1 AND to_account_id = $2) \
             OR (from_account_id = $2 AND to_account_id = $1))",
    )
    .bind(viewer)
    .bind(peer)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(true)
}
