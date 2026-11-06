//! One live invitation link per group.
//!
//! A link's token is `kordi_gi_` plus an HMAC-SHA256 of its random invitation
//! id under a server secret, so the database still keeps only the token's
//! SHA-256 hash while the server can show the same link to every group admin
//! again. Older links made from random tokens keep working through their hash
//! until they expire, but cannot be shown again, so the first request for a
//! group's link after them makes a derived one.

use super::*;
use hmac::{Hmac, Mac};

const GROUP_INVITE_TOKEN_CONTEXT: &[u8] = b"kordi-group-invite-v1:";

/// Group links are derived under the secret that derives document share
/// links (`KORDI_DOCUMENT_SHARE_SECRET`, else `KORDI_CHAT_SYNC_CURSOR_SECRET`),
/// with their own context. Without it, links are random and never reused.
fn group_invite_secret() -> Option<Vec<u8>> {
    crate::document_shares::tokens::share_secret()
}

pub(super) fn derived_group_invite_token(secret: &[u8], invitation_id: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(GROUP_INVITE_TOKEN_CONTEXT);
    mac.update(invitation_id.as_bytes());
    format!(
        "{GROUP_INVITE_TOKEN_PREFIX}{}",
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

/// A group's shareable link: its id, its token and when it expires.
pub(crate) struct NewGroupInvitation {
    pub(crate) invitation_id: String,
    pub(crate) token: String,
    pub(crate) expires_at: String,
    /// False when an existing link was returned.
    pub(crate) created: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LinkRequest {
    /// The group's live link, if it has one.
    Current,
    /// The group's live link, made when it has none.
    CurrentOrNew,
    /// Revoke every live link of the group and make a new one.
    Reset,
}

pub(crate) enum LinkOutcome {
    /// The requester may not invite to this group.
    Forbidden,
    /// The group has no link that can be shown.
    Missing,
    Link(NewGroupInvitation),
}

fn renewed_expiry() -> String {
    (Utc::now() + ChronoDuration::days(GROUP_INVITE_LIFETIME_DAYS)).to_rfc3339()
}

/// The group link `requester` asked for. Only a group owner or admin gets one;
/// a new link also needs the group to have at least `min_members` people.
/// Returning a live link renews its expiry.
pub(crate) async fn group_invitation_link_in_transaction(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    requester: &str,
    group_id: &str,
    group_space_id: &str,
    group_title: &str,
    min_members: usize,
    request: LinkRequest,
) -> Result<LinkOutcome, sqlx_core::Error> {
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(group_space_id)
        .execute(&mut **tx)
        .await?;
    if !is_group_admin(tx, requester, group_id).await? {
        return Ok(LinkOutcome::Forbidden);
    }
    let secret = group_invite_secret();
    let now = Utc::now().to_rfc3339();
    if request == LinkRequest::Reset {
        query(
            "UPDATE cloud_group_invitations SET revoked_at = $1 \
             WHERE group_space_id = $2 AND revoked_at IS NULL",
        )
        .bind(&now)
        .bind(group_space_id)
        .execute(&mut **tx)
        .await?;
    } else if let Some(secret) = secret.as_deref() {
        if let Some(link) = live_link(tx, secret, requester, group_id, group_space_id).await? {
            return Ok(LinkOutcome::Link(link));
        }
    }
    if request == LinkRequest::Current {
        return Ok(LinkOutcome::Missing);
    }

    let snapshot = authorized_group_invitation_snapshot_in_transaction(
        tx,
        requester,
        group_id,
        group_space_id,
        group_title,
        min_members,
    )
    .await?;
    let Some(snapshot) = snapshot else {
        return Ok(LinkOutcome::Forbidden);
    };
    let snapshot_json = serde_json::to_value(&snapshot)
        .map_err(|error| sqlx_core::Error::Protocol(error.to_string()))?;
    let invitation_id = format!("groupinv_{}", uuid::Uuid::new_v4().simple());
    let token = match secret.as_deref() {
        Some(secret) => derived_group_invite_token(secret, &invitation_id),
        None => {
            // A random link cannot be shown again, so it replaces the
            // requester's earlier ones instead of piling up.
            query(
                "UPDATE cloud_group_invitations SET revoked_at = $1 \
                 WHERE inviter_account_id = $2 AND group_space_id = $3 \
                   AND revoked_at IS NULL AND expires_at > $1",
            )
            .bind(&now)
            .bind(requester)
            .bind(group_space_id)
            .execute(&mut **tx)
            .await?;
            new_group_invite_token()
        }
    };
    let expires_at = renewed_expiry();
    query(
        "INSERT INTO cloud_group_invitations \
         (invitation_id, inviter_account_id, token_hash, group_id, group_space_id, group_title, group_snapshot, created_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(&invitation_id)
    .bind(requester)
    .bind(hash_group_invite_token(&token))
    .bind(group_id)
    .bind(group_space_id)
    .bind(group_title)
    .bind(snapshot_json)
    .bind(&now)
    .bind(&expires_at)
    .execute(&mut **tx)
    .await?;
    Ok(LinkOutcome::Link(NewGroupInvitation {
        invitation_id,
        token,
        expires_at,
        created: true,
    }))
}

/// The oldest live link of the group whose token can be rebuilt and whose
/// creator can still invite, with its expiry renewed. A derived link whose
/// creator is no longer an admin already fails to open, so it is revoked here
/// and the next admin's link takes its place.
async fn live_link(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    secret: &[u8],
    requester: &str,
    group_id: &str,
    group_space_id: &str,
) -> Result<Option<NewGroupInvitation>, sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let rows: Vec<(String, String, String)> = query_as(
        "SELECT invitation_id, inviter_account_id, token_hash FROM cloud_group_invitations \
         WHERE group_space_id = $1 AND revoked_at IS NULL AND expires_at > $2 \
         ORDER BY created_at ASC, invitation_id ASC",
    )
    .bind(group_space_id)
    .bind(&now)
    .fetch_all(&mut **tx)
    .await?;
    for (invitation_id, inviter, token_hash) in rows {
        let token = derived_group_invite_token(secret, &invitation_id);
        if hash_group_invite_token(&token) != token_hash {
            continue;
        }
        if inviter != requester && !is_group_admin(tx, &inviter, group_id).await? {
            query("UPDATE cloud_group_invitations SET revoked_at = $1 WHERE invitation_id = $2")
                .bind(&now)
                .bind(&invitation_id)
                .execute(&mut **tx)
                .await?;
            continue;
        }
        let expires_at = renewed_expiry();
        query("UPDATE cloud_group_invitations SET expires_at = $1 WHERE invitation_id = $2")
            .bind(&expires_at)
            .bind(&invitation_id)
            .execute(&mut **tx)
            .await?;
        return Ok(Some(NewGroupInvitation {
            invitation_id,
            token,
            expires_at,
            created: false,
        }));
    }
    Ok(None)
}

/// Keeps a link that people are joining through from expiring under them.
pub(super) async fn renew_group_invitation(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    invitation_id: &str,
) -> Result<(), sqlx_core::Error> {
    let expires_at = renewed_expiry();
    query(
        "UPDATE cloud_group_invitations SET expires_at = $1 \
         WHERE invitation_id = $2 AND revoked_at IS NULL AND expires_at < $1",
    )
    .bind(&expires_at)
    .bind(invitation_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn is_group_admin(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    account_id: &str,
    group_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let row: Option<(i32,)> = query_as(
        "SELECT 1 FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members member
           ON member.conversation_id = conversation.conversation_id
         WHERE conversation.legacy_session_id = $1
           AND conversation.kind = 'group'
           AND member.account_id = $2
           AND member.membership_state = 'active'
           AND member.role IN ('owner', 'admin')",
    )
    .bind(group_id)
    .bind(account_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.is_some())
}
