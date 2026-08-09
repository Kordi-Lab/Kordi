use super::*;

pub(super) fn accepted_group_control_body(
    record: &GroupInvitationRecord,
    recipient: GroupInvitationParticipant,
    accepted_at_ms: i64,
) -> String {
    let mut participants = record.snapshot.participants.clone();
    if !participants
        .iter()
        .any(|participant| participant.account_id == recipient.account_id)
    {
        participants.push(recipient.clone());
    }
    participants.sort_by(|left, right| left.account_id.cmp(&right.account_id));
    let inviter = participants
        .iter()
        .find(|participant| participant.account_id == record.inviter_account_id)
        .cloned()
        .unwrap_or_else(|| GroupInvitationParticipant {
            account_id: record.inviter_account_id.clone(),
            display_name: record
                .inviter_display_name
                .clone()
                .unwrap_or_else(|| "Group admin".to_string()),
            avatar_url: record.inviter_avatar_url.clone(),
            role: "admin".to_string(),
        });
    let envelope = serde_json::json!({
        "kind": "group-invite",
        "groupId": record.snapshot.group_id,
        "groupSpaceId": record.snapshot.group_space_id,
        "groupTitle": record.snapshot.group_title,
        "createdByAccountId": record.snapshot.created_by_account_id,
        "actor": {
            "accountId": inviter.account_id,
            "displayName": inviter.display_name,
            "avatarUrl": inviter.avatar_url,
            "role": "admin",
        },
        "participants": participants,
        "memberJoins": [{
            "eventId": format!("groupjoin_{}_{}", record.invitation_id, recipient.account_id),
            "accountId": recipient.account_id,
            "displayName": recipient.display_name,
            "createdAtMs": accepted_at_ms,
        }],
        "message": null,
    });
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&envelope).unwrap_or_default());
    format!("{CLOUD_GROUP_CONTROL_PREFIX}{encoded}")
}

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
    let record = match lookup_group_invitation_in_transaction(&mut tx, &token).await {
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
                "Could not revalidate the group invitation.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
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

    let recipient_row: Option<(Option<String>, Option<String>)> =
        match query_as("SELECT display_name, avatar_url FROM cloud_accounts WHERE account_id = $1")
            .bind(&session.account_id)
            .fetch_optional(&mut *tx)
            .await
        {
            Ok(value) => value,
            Err(_) => {
                return err(
                    "server_error",
                    "Could not load your profile.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        };
    let Some((recipient_display_name, recipient_avatar_url)) = recipient_row else {
        return err(
            "wrong_group_invitation_account",
            "Sign in with the account that should join this group.",
            StatusCode::FORBIDDEN,
        );
    };
    let recipient = GroupInvitationParticipant {
        account_id: session.account_id.clone(),
        display_name: recipient_display_name.unwrap_or_else(|| "Kordi member".to_string()),
        avatar_url: recipient_avatar_url
            .as_deref()
            .and_then(syncable_cloud_avatar_url),
        role: "person".to_string(),
    };
    let accepted_at = Utc::now();
    let body = accepted_group_control_body(&record, recipient, accepted_at.timestamp_millis());
    let mut target_account_ids = record
        .snapshot
        .participants
        .iter()
        .map(|participant| participant.account_id.clone())
        .chain(std::iter::once(session.account_id.clone()))
        .collect::<Vec<_>>();
    target_account_ids.sort();
    target_account_ids.dedup();

    let mut published = Vec::new();
    for target_account_id in target_account_ids {
        let message_id = format!("msg_{}", uuid::Uuid::new_v4().simple());
        let client_message_id = format!(
            "group-invitation:{}:{}:{}",
            record.invitation_id, session.account_id, target_account_id
        );
        let now = accepted_at.to_rfc3339();
        let read_at = (target_account_id == record.inviter_account_id).then_some(now.as_str());
        let outcome = persist_cloud_message_in_transaction(
            &mut tx,
            PersistCloudMessageInput {
                message_id: &message_id,
                from_account_id: &record.inviter_account_id,
                to_account_id: &target_account_id,
                client_message_id: Some(&client_message_id),
                body: &body,
                session_id: Some(&record.snapshot.group_id),
                created_at: &now,
                delivered_at: &now,
                read_at,
                attachments: &[],
                claim_legacy_self_replay: false,
            },
        )
        .await;
        let Ok(outcome) = outcome else {
            return err(
                "server_error",
                "Could not join the group. No changes were saved; try again.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        };
        if outcome.inserted {
            published.push((
                outcome.message.message_id,
                outcome.message.to_account_id,
                outcome.message.created_at,
            ));
        }
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

    if !published.is_empty() {
        let events = state.events().clone();
        let from_account_id = record.inviter_account_id.clone();
        let published_body = body.clone();
        let session_id = record.snapshot.group_id.clone();
        tokio::spawn(async move {
            for (message_id, to_account_id, created_at) in published {
                events
                    .publish_message_arrived(crate::events::MessageArrived {
                        message_id: &message_id,
                        from_account_id: &from_account_id,
                        to_account_id: &to_account_id,
                        body: &published_body,
                        created_at: &created_at,
                        session_id: Some(&session_id),
                        attachments: serde_json::json!([]),
                    })
                    .await;
            }
        });
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
