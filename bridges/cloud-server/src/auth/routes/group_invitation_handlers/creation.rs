use super::*;

pub(crate) async fn create_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    Json(req): Json<CreateGroupInvitationRequest>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(ip_from_extension(connect_info.as_ref()))
        .await
    {
        return limited_response(retry_after);
    }
    let group_id = req.group_id.trim();
    let group_space_id = req.group_space_id.trim();
    let Some(group_title) = clean_group_title(&req.group_title) else {
        return err(
            "invalid_group_invitation",
            "Enter a group name before sharing an invitation.",
            StatusCode::BAD_REQUEST,
        );
    };
    if group_id.is_empty()
        || group_id.len() > 256
        || group_space_id.is_empty()
        || group_space_id.len() > 256
        || group_id != group_space_id
        || group_id.starts_with("session:direct-")
    {
        return err(
            "invalid_group_invitation",
            "This group cannot create a share link.",
            StatusCode::BAD_REQUEST,
        );
    }

    let snapshot = match authorized_group_invitation_snapshot(
        state.db_pool(),
        &session.account_id,
        group_id,
        group_space_id,
        &group_title,
    )
    .await
    {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => {
            return err(
                "group_invitation_permission_denied",
                "Only a verified group admin can create this invitation link.",
                StatusCode::FORBIDDEN,
            );
        }
        Err(_) => {
            return err(
                "server_error",
                "Could not verify group membership.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let token = new_group_invite_token();
    let invitation_id = format!("groupinv_{}", uuid::Uuid::new_v4().simple());
    let created_at = Utc::now();
    let expires_at = created_at + ChronoDuration::days(GROUP_INVITE_LIFETIME_DAYS);
    let snapshot_json = match serde_json::to_value(&snapshot) {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not create invitation.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let mut tx = match state.db_pool().begin().await {
        Ok(tx) => tx,
        Err(_) => {
            return err(
                "server_error",
                "Could not create invitation.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let created_at_text = created_at.to_rfc3339();
    if query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(group_space_id)
        .execute(&mut *tx)
        .await
        .is_err()
        || query(
            "UPDATE cloud_group_invitations SET revoked_at = $1 \
             WHERE inviter_account_id = $2 AND group_space_id = $3 \
               AND revoked_at IS NULL AND expires_at > $1",
        )
        .bind(&created_at_text)
        .bind(&session.account_id)
        .bind(group_space_id)
        .execute(&mut *tx)
        .await
        .is_err()
        || query(
        "INSERT INTO cloud_group_invitations \
         (invitation_id, inviter_account_id, token_hash, group_id, group_space_id, group_title, group_snapshot, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&invitation_id)
    .bind(&session.account_id)
    .bind(hash_group_invite_token(&token))
    .bind(group_id)
    .bind(group_space_id)
    .bind(&group_title)
    .bind(snapshot_json)
    .bind(&created_at_text)
    .bind(expires_at.to_rfc3339())
    .execute(&mut *tx)
    .await
    .is_err()
        || tx.commit().await.is_err()
    {
        return err(
            "server_error",
            "Could not create invitation.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let _ = write_audit(
        state.db_pool(),
        Some(&session.account_id),
        Some(&session.device_id),
        "group.invitation.created",
        serde_json::json!({
            "invitation_id": invitation_id,
            "group_space_id": group_space_id,
        }),
    )
    .await;

    Json(GroupInvitationResponse {
        invitation_id,
        invite_url: group_invite_url(&token),
        expires_at: expires_at.to_rfc3339(),
    })
    .into_response()
}

pub(crate) async fn get_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    axum::extract::Path(token): axum::extract::Path<String>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(ip_from_extension(connect_info.as_ref()))
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

pub(crate) async fn list_active_group_invitations(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(group_space_id): axum::extract::Path<String>,
) -> Response {
    let group_space_id = group_space_id.trim();
    if group_space_id.is_empty() || group_space_id.len() > 256 {
        return err(
            "invalid_group_invitation",
            "A valid group is required.",
            StatusCode::BAD_REQUEST,
        );
    }
    let rows: Result<Vec<(String, String)>, _> = query_as(
        "SELECT invitation_id, expires_at FROM cloud_group_invitations \
         WHERE inviter_account_id = $1 AND group_space_id = $2 \
           AND revoked_at IS NULL AND expires_at > $3 \
         ORDER BY created_at DESC LIMIT 20",
    )
    .bind(&session.account_id)
    .bind(group_space_id)
    .bind(Utc::now().to_rfc3339())
    .fetch_all(state.db_pool())
    .await;
    match rows {
        Ok(rows) => Json(GroupInvitationListResponse {
            invitations: rows
                .into_iter()
                .map(
                    |(invitation_id, expires_at)| GroupInvitationSummaryResponse {
                        invitation_id,
                        expires_at,
                    },
                )
                .collect(),
        })
        .into_response(),
        Err(_) => err(
            "server_error",
            "Could not load active group invitations.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ),
    }
}

pub(crate) async fn group_invitation_landing(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    connect_info: Option<ConnectInfo<SocketAddr>>,
    axum::extract::Path(token): axum::extract::Path<String>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_ip(ip_from_extension(connect_info.as_ref()))
        .await
    {
        return limited_response(retry_after);
    }
    let release_download_url = configured_release_download_url();
    match lookup_group_invitation(state.db_pool(), &token).await {
        Ok(GroupInvitationLookup::Valid(record)) => {
            match refresh_group_invitation_record(state.db_pool(), *record).await {
                Ok(Some(record)) => {
                    let inviter = record
                        .inviter_display_name
                        .as_deref()
                        .map(str::trim)
                        .filter(|name| !name.is_empty())
                        .unwrap_or("A Kordi user");
                    let message = group_invitation_landing_message(inviter);
                    let deep_link = group_invite_deep_link(&token);
                    invitation_landing_html_with_open_action(
                        StatusCode::OK,
                        &format!("Join {}", record.snapshot.group_title),
                        &message,
                        Some(("Open Kordi", &deep_link)),
                        release_download_url.as_deref(),
                    )
                }
                Ok(None) => invitation_landing_html_with_open_action(
                    StatusCode::NOT_FOUND,
                    "Invitation not available",
                    "The group changed and this invitation is no longer available. Ask a current group admin for a new link.",
                    None,
                    release_download_url.as_deref(),
                ),
                Err(_) => invitation_landing_html_with_open_action(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Invitation unavailable",
                    "Kordi could not verify this invitation. Please try again shortly.",
                    None,
                    release_download_url.as_deref(),
                ),
            }
        }
        Ok(GroupInvitationLookup::Invalid) => invitation_landing_html_with_open_action(
            StatusCode::NOT_FOUND,
            "Invitation not available",
            "This group invitation is invalid or has been revoked. Ask a group admin for a new link.",
            None,
            release_download_url.as_deref(),
        ),
        Ok(GroupInvitationLookup::Expired) => invitation_landing_html_with_open_action(
            StatusCode::GONE,
            "Invitation expired",
            "Ask a group admin for a new invitation link.",
            None,
            release_download_url.as_deref(),
        ),
        Err(_) => invitation_landing_html_with_open_action(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Invitation unavailable",
            "Kordi could not load this invitation. Please try again shortly.",
            None,
            release_download_url.as_deref(),
        ),
    }
}

pub(super) fn group_invitation_landing_message(inviter: &str) -> String {
    format!("{inviter} invited you to this group.")
}
