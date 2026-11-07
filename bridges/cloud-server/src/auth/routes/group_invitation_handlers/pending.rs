//! Invitations an account claimed on the web so the app can offer to join
//! them later. Claiming never adds the account to the group: joining still
//! redeems the invitation, with the same checks as opening its link.

use super::*;

/// The most live pending invitations one account may hold.
const MAX_LIVE_PENDING: i64 = 5;

/// Pending invitations that are neither dismissed nor used, on links that are
/// still live, for groups the account is not a member of. `$1` is the account
/// and `$2` the current time.
const LIVE_PENDING_FROM: &str = "FROM cloud_pending_group_invitations pending \
 JOIN cloud_group_invitations invite ON invite.invitation_id = pending.invitation_id \
 WHERE pending.account_id = $1 AND pending.dismissed_at IS NULL AND pending.consumed_at IS NULL \
   AND invite.revoked_at IS NULL AND invite.expires_at > $2 \
   AND NOT EXISTS (SELECT 1 FROM cloud_chat_conversations conversation \
     JOIN cloud_chat_conversation_members member \
       ON member.conversation_id = conversation.conversation_id \
     WHERE conversation.legacy_session_id = invite.group_id AND conversation.kind = 'group' \
       AND member.account_id = pending.account_id AND member.membership_state = 'active')";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingGroupInvitation {
    pub(super) id: String,
    pub(super) invitation_id: String,
    pub(super) group_name: String,
    pub(super) inviter_name: String,
    pub(super) member_count: usize,
    pub(super) expires_at: String,
}

pub(super) enum ClaimOutcome {
    Claimed(PendingGroupInvitation),
    Unavailable,
    AlreadyMember { conversation_id: Option<String> },
    GroupFull,
    TooManyPending,
}

pub(super) fn inviter_name(record: &GroupInvitationRecord) -> String {
    record
        .inviter_display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or("A Kordi user")
        .to_string()
}

pub(super) fn is_group_member(record: &GroupInvitationRecord, account_id: &str) -> bool {
    record
        .snapshot
        .participants
        .iter()
        .any(|participant| participant.account_id == account_id)
}

fn pending_from_record(id: String, record: &GroupInvitationRecord) -> PendingGroupInvitation {
    PendingGroupInvitation {
        id,
        invitation_id: record.invitation_id.clone(),
        group_name: record.snapshot.group_title.clone(),
        inviter_name: inviter_name(record),
        member_count: record.snapshot.participants.len(),
        expires_at: record.expires_at.clone(),
    }
}

async fn group_conversation_id<'e, E>(
    executor: E,
    group_id: &str,
) -> Result<Option<String>, sqlx_core::Error>
where
    E: sqlx_core::executor::Executor<'e, Database = sqlx_postgres::Postgres>,
{
    let row: Option<(String,)> = query_as(
        "SELECT conversation_id::TEXT FROM cloud_chat_conversations \
         WHERE legacy_session_id = $1 AND kind = 'group'",
    )
    .bind(group_id)
    .fetch_optional(executor)
    .await?;
    Ok(row.map(|(id,)| id))
}

/// Saves the invitation behind `token` for `account_id`. Claiming the same
/// invitation again returns the same pending invitation.
pub(super) async fn claim_for_account(
    pool: &PgPool,
    token: &str,
    account_id: &str,
) -> Result<ClaimOutcome, sqlx_core::Error> {
    let GroupInvitationLookup::Valid(record) = lookup_group_invitation(pool, token).await? else {
        return Ok(ClaimOutcome::Unavailable);
    };
    let Some(record) = refresh_group_invitation_record(pool, *record).await? else {
        return Ok(ClaimOutcome::Unavailable);
    };
    if is_group_member(&record, account_id) {
        let conversation_id = group_conversation_id(pool, &record.snapshot.group_id).await?;
        return Ok(ClaimOutcome::AlreadyMember { conversation_id });
    }
    if !group_invitation_has_capacity(&record.snapshot) {
        return Ok(ClaimOutcome::GroupFull);
    }
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("pending-group-invitations:{account_id}"))
        .execute(&mut *tx)
        .await?;
    let existing: Option<(String, bool)> = query_as(
        "SELECT pending_id, dismissed_at IS NULL AND consumed_at IS NULL \
         FROM cloud_pending_group_invitations WHERE account_id = $1 AND invitation_id = $2",
    )
    .bind(account_id)
    .bind(&record.invitation_id)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some((pending_id, true)) = existing {
        tx.commit().await?;
        return Ok(ClaimOutcome::Claimed(pending_from_record(
            pending_id, &record,
        )));
    }
    let now = Utc::now().to_rfc3339();
    let (live,): (i64,) = query_as(&format!("SELECT COUNT(*) {LIVE_PENDING_FROM}"))
        .bind(account_id)
        .bind(&now)
        .fetch_one(&mut *tx)
        .await?;
    if live >= MAX_LIVE_PENDING {
        return Ok(ClaimOutcome::TooManyPending);
    }
    let (pending_id,): (String,) = query_as(
        "INSERT INTO cloud_pending_group_invitations \
         (pending_id, account_id, invitation_id, created_at) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (account_id, invitation_id) DO UPDATE \
         SET created_at = EXCLUDED.created_at, dismissed_at = NULL, consumed_at = NULL \
         RETURNING pending_id",
    )
    .bind(format!("gipend_{}", uuid::Uuid::new_v4().simple()))
    .bind(account_id)
    .bind(&record.invitation_id)
    .bind(&now)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(ClaimOutcome::Claimed(pending_from_record(
        pending_id, &record,
    )))
}

/// The account's live pending invitations, newest first.
pub(super) async fn list_for_account(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<PendingGroupInvitation>, sqlx_core::Error> {
    let rows: Vec<(String, String)> = query_as(&format!(
        "SELECT pending.pending_id, pending.invitation_id {LIVE_PENDING_FROM} \
         ORDER BY pending.created_at DESC LIMIT 20"
    ))
    .bind(account_id)
    .bind(Utc::now().to_rfc3339())
    .fetch_all(pool)
    .await?;
    let mut invitations = Vec::with_capacity(rows.len());
    for (pending_id, invitation_id) in rows {
        let GroupInvitationLookup::Valid(record) =
            lookup_group_invitation_by_id_in_pool(pool, &invitation_id).await?
        else {
            continue;
        };
        let Some(record) = refresh_group_invitation_record(pool, *record).await? else {
            continue;
        };
        if !is_group_member(&record, account_id) {
            invitations.push(pending_from_record(pending_id, &record));
        }
    }
    Ok(invitations)
}

fn server_error() -> Response {
    err(
        "server_error",
        "Could not load the invitation. Try again.",
        StatusCode::INTERNAL_SERVER_ERROR,
    )
}

fn unavailable() -> Response {
    err(
        "invitation_unavailable",
        "This link expired. Ask the sender for a new one.",
        StatusCode::NOT_FOUND,
    )
}

fn group_full() -> Response {
    err("group_full", "This group is full.", StatusCode::CONFLICT)
}

/// `POST /v1/cloud/invitations/groups/claim/:token`
pub(crate) async fn claim_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(token): axum::extract::Path<String>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(INVITATION_ACCEPT_LIMIT, &session.account_id)
        .await
    {
        return limited_response(retry_after);
    }
    match claim_for_account(state.db_pool(), &token, &session.account_id).await {
        Ok(ClaimOutcome::Claimed(pending)) => Json(serde_json::json!({
            "pending": pending,
            "deepLink": group_invite_deep_link(&token),
        }))
        .into_response(),
        Ok(ClaimOutcome::Unavailable) => unavailable(),
        Ok(ClaimOutcome::AlreadyMember { conversation_id }) => (
            StatusCode::CONFLICT,
            Json(serde_json::json!({
                "errorCode": "already_member",
                "message": "You are already in this group.",
                "conversationId": conversation_id,
            })),
        )
            .into_response(),
        Ok(ClaimOutcome::GroupFull) => group_full(),
        Ok(ClaimOutcome::TooManyPending) => err(
            "too_many_pending",
            "Join or dismiss an invitation you already have first.",
            StatusCode::TOO_MANY_REQUESTS,
        ),
        Err(_) => server_error(),
    }
}

/// `GET /v1/cloud/invitations/groups/pending`
pub(crate) async fn list_pending_group_invitations(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match list_for_account(state.db_pool(), &session.account_id).await {
        Ok(invitations) => Json(serde_json::json!({ "invitations": invitations })).into_response(),
        Err(_) => server_error(),
    }
}

/// `POST /v1/cloud/invitations/groups/pending/:pending_id/accept`
pub(crate) async fn accept_pending_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(pending_id): axum::extract::Path<String>,
) -> Response {
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(INVITATION_ACCEPT_LIMIT, &session.account_id)
        .await
    {
        return limited_response(retry_after);
    }
    let pool = state.db_pool();
    let row: Result<Option<(String,)>, _> = query_as(
        "SELECT invitation_id FROM cloud_pending_group_invitations \
         WHERE pending_id = $1 AND account_id = $2 AND dismissed_at IS NULL",
    )
    .bind(pending_id.trim())
    .bind(&session.account_id)
    .fetch_optional(pool)
    .await;
    let invitation_id = match row {
        Ok(Some((invitation_id,))) => invitation_id,
        Ok(None) => return unavailable(),
        Err(_) => return server_error(),
    };
    let Ok(mut tx) = pool.begin().await else {
        return server_error();
    };
    let response = match redeem_group_invitation_by_id(
        &mut tx,
        &invitation_id,
        &session.account_id,
        GROUP_INVITE_MIN_MEMBERS,
    )
    .await
    {
        Redemption::Done(response) => response,
        Redemption::Failed("group_invitation_full", _) => return group_full(),
        Redemption::Failed("server_error", response) => return response,
        Redemption::Failed(_, _) => return unavailable(),
    };
    let finished = async {
        query(
            "UPDATE cloud_pending_group_invitations \
             SET consumed_at = COALESCE(consumed_at, $2) WHERE pending_id = $1",
        )
        .bind(pending_id.trim())
        .bind(Utc::now().to_rfc3339())
        .execute(&mut *tx)
        .await?;
        let conversation_id = group_conversation_id(&mut *tx, &response.group_id).await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(conversation_id)
    }
    .await;
    let Ok(conversation_id) = finished else {
        return server_error();
    };
    if response.status == "joined" {
        audit_join(&state, &session, &invitation_id, &response.group_space_id).await;
    }
    Json(serde_json::json!({
        "conversationId": conversation_id,
        "status": response.status,
        "groupId": response.group_id,
        "groupSpaceId": response.group_space_id,
        "groupTitle": response.group_title,
    }))
    .into_response()
}

/// `DELETE /v1/cloud/invitations/groups/pending/:pending_id`
pub(crate) async fn dismiss_pending_group_invitation(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    axum::extract::Path(pending_id): axum::extract::Path<String>,
) -> Response {
    let result = query(
        "UPDATE cloud_pending_group_invitations SET dismissed_at = COALESCE(dismissed_at, $3) \
         WHERE pending_id = $1 AND account_id = $2",
    )
    .bind(pending_id.trim())
    .bind(&session.account_id)
    .bind(Utc::now().to_rfc3339())
    .execute(state.db_pool())
    .await;
    match result {
        Ok(done) if done.rows_affected() > 0 => StatusCode::NO_CONTENT.into_response(),
        Ok(_) => unavailable(),
        Err(_) => server_error(),
    }
}

/// Routes for pending invitations. Mounted behind the session middleware that
/// accepts an app's bearer token or the web session cookie (with the CSRF
/// rule for state-changing requests). Invitations belong to the account, so
/// no organization is required to match.
pub(crate) fn pending_routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route(
            "/v1/cloud/invitations/groups/claim/:token",
            post(claim_group_invitation),
        )
        .route(
            "/v1/cloud/invitations/groups/pending",
            get(list_pending_group_invitations),
        )
        .route(
            "/v1/cloud/invitations/groups/pending/:pending_id/accept",
            post(accept_pending_group_invitation),
        )
        .route(
            "/v1/cloud/invitations/groups/pending/:pending_id",
            delete(dismiss_pending_group_invitation),
        )
}
