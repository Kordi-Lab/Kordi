use super::*;

pub(crate) async fn accept_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    headers: HeaderMap,
    axum::extract::Path(token): axum::extract::Path<String>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(client_ip(&headers, connect_info.as_ref()))
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

    // Someone the inviter blocked cannot use the inviter's links. Links
    // created by other admins still work, and the invitee's own blocks do
    // not stop them.
    match crate::relationships::has_blocked(
        &mut *tx,
        &record.inviter_account_id,
        &session.account_id,
    )
    .await
    {
        Ok(false) => {}
        Ok(true) => {
            return err(
                "invalid_group_invitation",
                "This group invitation is invalid or was revoked.",
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
    }

    // Active members are already in. A member an admin removed stays out of
    // a link they already used; a member who left may come back.
    let is_active_member = record
        .snapshot
        .participants
        .iter()
        .any(|participant| participant.account_id == session.account_id);
    let removed_after_accepting = if is_active_member {
        false
    } else {
        match removed_after_accepting_invitation(&mut tx, &record, &session.account_id).await {
            Ok(value) => value,
            Err(_) => {
                return err(
                    "server_error",
                    "Could not check invitation status.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        }
    };
    if is_active_member || removed_after_accepting {
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

/// Whether the caller accepted this invitation before and an admin has since
/// removed them from the group root.
async fn removed_after_accepting_invitation(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    record: &GroupInvitationRecord,
    account_id: &str,
) -> Result<bool, sqlx_core::Error> {
    query_as::<_, (bool,)>(
        "SELECT EXISTS (SELECT 1 FROM cloud_group_invitation_acceptances \
                        WHERE invitation_id = $1 AND account_id = $2) \
            AND EXISTS (SELECT 1 FROM cloud_chat_conversation_members member \
                        JOIN cloud_chat_conversations conversation \
                          ON conversation.conversation_id = member.conversation_id \
                        WHERE conversation.legacy_session_id = $3 \
                          AND conversation.kind = 'group' \
                          AND member.account_id = $2 \
                          AND member.membership_state = 'removed')",
    )
    .bind(&record.invitation_id)
    .bind(account_id)
    .bind(&record.snapshot.group_id)
    .fetch_one(&mut **tx)
    .await
    .map(|(value,)| value)
}
