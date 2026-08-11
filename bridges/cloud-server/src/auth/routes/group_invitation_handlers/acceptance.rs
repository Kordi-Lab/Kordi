use super::*;

pub(crate) async fn accept_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    axum::extract::Path(token): axum::extract::Path<String>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(ip_from_extension(connect_info.as_ref()))
        .await
    {
        return limited_response(retry_after);
    }
    let record = match lookup_group_invitation(state.db_pool(), &token).await {
        Ok(GroupInvitationLookup::Valid(record)) => *record,
        Ok(GroupInvitationLookup::Invalid) => {
            return err(
                "invalid_group_invitation",
                "This group invitation is invalid or was revoked.",
                StatusCode::NOT_FOUND,
            );
        }
        Ok(GroupInvitationLookup::Expired) => {
            return err(
                "group_invitation_expired",
                "This group invitation has expired. Ask a group admin for a new link.",
                StatusCode::GONE,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Could not load group invitation.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    if session.account_id == record.inviter_account_id {
        return err(
            "self_group_invitation",
            "You created this invitation. Open the group from your sidebar instead.",
            StatusCode::CONFLICT,
        );
    }
    let mut tx = match state.db_pool().begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return err(
                "server_error",
                "Could not start joining the group.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(&record.snapshot.group_id)
        .execute(&mut *tx)
        .await
        .is_err()
    {
        return err(
            "server_error",
            "Could not lock the group invitation.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    let record = match refresh_group_invitation_record_in_transaction(&mut tx, record).await {
        Ok(Some(record)) => record,
        Ok(None) => {
            return err(
                "invalid_group_invitation",
                "This invitation is no longer available because its creator cannot invite members.",
                StatusCode::NOT_FOUND,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Could not verify the group invitation.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let already_accepted: Option<(i32,)> = match query_as(
        "SELECT 1 FROM cloud_group_invitation_acceptances WHERE invitation_id = $1 AND account_id = $2",
    )
    .bind(&record.invitation_id)
    .bind(&session.account_id)
    .fetch_optional(&mut *tx)
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not check invitation status.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    if already_accepted.is_some()
        || record
            .snapshot
            .participants
            .iter()
            .any(|participant| participant.account_id == session.account_id)
    {
        return Json(GroupInvitationAcceptanceResponse {
            status: "already_joined",
            group_id: record.snapshot.group_id,
            group_space_id: record.snapshot.group_space_id,
            group_title: record.snapshot.group_title,
        })
        .into_response();
    }
    if !group_invitation_has_capacity(&record.snapshot) {
        return err(
            "group_invitation_full",
            "This group already has the maximum number of members.",
            StatusCode::CONFLICT,
        );
    }

    let accepted_at = Utc::now();
    if let Err(error) = crate::chat_sync::store::accept_invited_conversation_member(
        &mut tx,
        &record.inviter_account_id,
        &record.snapshot.group_id,
        &session.account_id,
    )
    .await
    {
        return match error {
            crate::chat_sync::store::StoreError::Forbidden
            | crate::chat_sync::store::StoreError::NotFound => err(
                "invalid_group_invitation",
                "This invitation no longer matches an active group.",
                StatusCode::CONFLICT,
            ),
            crate::chat_sync::store::StoreError::InvalidInput(_) => err(
                "group_invitation_full",
                "This group cannot accept another member.",
                StatusCode::CONFLICT,
            ),
            _ => err(
                "server_error",
                "Could not join the group. No changes were saved; try again.",
                StatusCode::INTERNAL_SERVER_ERROR,
            ),
        };
    }

    if query(
        "INSERT INTO cloud_group_invitation_acceptances (invitation_id, account_id, accepted_at) \
         VALUES ($1, $2, $3) ON CONFLICT (invitation_id, account_id) DO NOTHING",
    )
    .bind(&record.invitation_id)
    .bind(&session.account_id)
    .bind(accepted_at.to_rfc3339())
    .execute(&mut *tx)
    .await
    .is_err()
    {
        return err(
            "server_error",
            "Could not save the invitation acceptance. No changes were saved; try again.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    if tx.commit().await.is_err() {
        return err(
            "server_error",
            "Could not finish joining the group. Try again.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let _ = write_audit(
        state.db_pool(),
        Some(&session.account_id),
        Some(&session.device_id),
        "group.invitation.accepted",
        serde_json::json!({
            "invitation_id": record.invitation_id,
            "group_space_id": record.snapshot.group_space_id,
        }),
    )
    .await;

    Json(GroupInvitationAcceptanceResponse {
        status: "joined",
        group_id: record.snapshot.group_id,
        group_space_id: record.snapshot.group_space_id,
        group_title: record.snapshot.group_title,
    })
    .into_response()
}

pub(crate) async fn revoke_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(invitation_id): axum::extract::Path<String>,
) -> Response {
    let result = query(
        "UPDATE cloud_group_invitations SET revoked_at = $1 \
         WHERE invitation_id = $2 AND inviter_account_id = $3 AND revoked_at IS NULL",
    )
    .bind(Utc::now().to_rfc3339())
    .bind(invitation_id.trim())
    .bind(&session.account_id)
    .execute(state.db_pool())
    .await;
    match result {
        Ok(done) if done.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => err(
            "group_invitation_missing",
            "Invitation was not found.",
            StatusCode::NOT_FOUND,
        ),
        Err(_) => err(
            "server_error",
            "Could not revoke group invitation.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}
