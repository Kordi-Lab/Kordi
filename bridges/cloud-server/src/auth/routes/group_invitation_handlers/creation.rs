use super::*;

/// Answers with the group's live link, made the first time an admin asks.
/// `reset` revokes the group's live links and makes a new one. Repeat requests
/// return the same link, so this authenticated route has no per-address limit.
pub(crate) async fn create_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(req): Json<CreateGroupInvitationRequest>,
) -> Response {
    let group_id = req.group_id.trim();
    let group_space_id = req.group_space_id.trim();
    let Some(group_title) = clean_group_title(&req.group_title) else {
        return err(
            "invalid_group_invitation",
            "Enter a group name before sharing an invitation.",
            StatusCode::BAD_REQUEST,
        );
    };
    if !is_shareable_group_id(group_id) || group_id != group_space_id {
        return err(
            "invalid_group_invitation",
            "This group cannot create a share link.",
            StatusCode::BAD_REQUEST,
        );
    }
    let request = if req.reset {
        LinkRequest::Reset
    } else {
        LinkRequest::CurrentOrNew
    };
    let outcome = group_link(&state, &session, group_id, &group_title, request).await;
    let invitation = match outcome {
        Ok(LinkOutcome::Link(invitation)) => invitation,
        Ok(LinkOutcome::Forbidden | LinkOutcome::Missing) => {
            return err(
                "group_invitation_permission_denied",
                "Only a verified group admin can create this invitation link.",
                StatusCode::FORBIDDEN,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Could not create invitation.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let NewGroupInvitation {
        invitation_id,
        token,
        expires_at,
        created,
    } = invitation;
    let event = match (req.reset, created) {
        (true, _) => Some("group.invitation.reset"),
        (false, true) => Some("group.invitation.created"),
        (false, false) => None,
    };
    if let Some(event) = event {
        let _ = write_audit(
            state.db_pool(),
            Some(&session.account_id),
            Some(&session.device_id),
            event,
            serde_json::json!({
                "invitation_id": invitation_id,
                "group_space_id": group_space_id,
            }),
        )
        .await;
    }

    Json(GroupInvitationResponse {
        invitation_id,
        invite_url: group_invite_url(&token),
        expires_at,
    })
    .into_response()
}

fn is_shareable_group_id(group_id: &str) -> bool {
    !group_id.is_empty() && group_id.len() <= 256 && !group_id.starts_with("session:direct-")
}

async fn group_link(
    state: &Arc<ServerState>,
    session: &CloudSession,
    group_id: &str,
    group_title: &str,
    request: LinkRequest,
) -> Result<LinkOutcome, sqlx_core::Error> {
    let mut tx = state.db_pool().begin().await?;
    let outcome = group_invitation_link_in_transaction(
        &mut tx,
        &session.account_id,
        group_id,
        group_id,
        group_title,
        GROUP_INVITE_MIN_MEMBERS,
        request,
    )
    .await?;
    tx.commit().await?;
    Ok(outcome)
}

pub(crate) async fn get_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
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
    match lookup_group_invitation(state.db_pool(), &token).await {
        Ok(GroupInvitationLookup::Valid(record)) => {
            match refresh_group_invitation_record(state.db_pool(), *record).await {
                Ok(Some(record)) => Json(group_invitation_preview(&record)).into_response(),
                Ok(None) => err(
                    "invalid_group_invitation",
                    "This invitation is no longer available because its creator cannot invite members.",
                    StatusCode::NOT_FOUND,
                ),
                Err(_) => err(
                    "server_error",
                    "Could not verify the group invitation.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                ),
            }
        }
        Ok(GroupInvitationLookup::Invalid) => err(
            "invalid_group_invitation",
            "This group invitation is invalid or was revoked.",
            StatusCode::NOT_FOUND,
        ),
        Ok(GroupInvitationLookup::Expired) => err(
            "group_invitation_expired",
            "This group invitation has expired. Ask a group admin for a new link.",
            StatusCode::GONE,
        ),
        Err(_) => err(
            "server_error",
            "Could not load group invitation.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

/// The group's live link for one of its admins: a list of at most one, empty
/// when the group has none yet or the viewer is not an admin.
pub(crate) async fn list_active_group_invitations(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(group_space_id): axum::extract::Path<String>,
) -> Response {
    let group_space_id = group_space_id.trim();
    if !is_shareable_group_id(group_space_id) {
        return err(
            "invalid_group_invitation",
            "A valid group is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let outcome = group_link(&state, &session, group_space_id, "", LinkRequest::Current).await;
    match outcome {
        Ok(outcome) => Json(GroupInvitationListResponse {
            invitations: match outcome {
                LinkOutcome::Link(link) => vec![GroupInvitationSummaryResponse {
                    invite_url: group_invite_url(&link.token),
                    invitation_id: link.invitation_id,
                    expires_at: link.expires_at,
                }],
                LinkOutcome::Forbidden | LinkOutcome::Missing => Vec::new(),
            },
        })
        .into_response(),
        Err(_) => err(
            "server_error",
            "Could not load active group invitations.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}
