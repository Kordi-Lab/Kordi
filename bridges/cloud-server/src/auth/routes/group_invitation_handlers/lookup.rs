use super::*;

type GroupConversationRow = (uuid::Uuid, String, Option<String>);
type GroupParticipantRow = (String, Option<String>, Option<String>, String);

pub(super) fn snapshot_from_rows(
    conversation: GroupConversationRow,
    rows: Vec<GroupParticipantRow>,
    group_id: &str,
    group_space_id: &str,
    requested_group_title: &str,
) -> Option<GroupInvitationSnapshot> {
    let participants = rows
        .into_iter()
        .map(
            |(account_id, display_name, avatar_url, role)| GroupInvitationParticipant {
                account_id,
                display_name: display_name
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("Kordi member")
                    .chars()
                    .take(80)
                    .collect(),
                avatar_url: avatar_url.as_deref().and_then(syncable_cloud_avatar_url),
                role: if role == "owner" || role == "admin" {
                    "admin".to_string()
                } else {
                    "person".to_string()
                },
            },
        )
        .collect::<Vec<_>>();
    if participants.len() < 2 || participants.len() > GROUP_INVITE_MAX_MEMBERS {
        return None;
    }
    let group_title = conversation
        .2
        .as_deref()
        .and_then(clean_group_title)
        .or_else(|| clean_group_title(requested_group_title))?;
    Some(GroupInvitationSnapshot {
        group_id: group_id.to_string(),
        group_space_id: group_space_id.to_string(),
        group_title,
        created_by_account_id: conversation.1,
        participants,
    })
}

pub(super) async fn authorized_group_invitation_snapshot(
    pool: &PgPool,
    inviter_account_id: &str,
    group_id: &str,
    group_space_id: &str,
    group_title: &str,
) -> Result<Option<GroupInvitationSnapshot>, sqlx_core::Error> {
    let conversation: Option<GroupConversationRow> = query_as(
        "SELECT conversation.conversation_id, conversation.created_by_account_id,
                conversation.shared_title
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members inviter
           ON inviter.conversation_id = conversation.conversation_id
         WHERE conversation.legacy_session_id = $1
           AND conversation.kind = 'group'
           AND inviter.account_id = $2
           AND inviter.membership_state = 'active'
           AND inviter.role IN ('owner', 'admin')",
    )
    .bind(group_id)
    .bind(inviter_account_id)
    .fetch_optional(pool)
    .await?;
    let Some(conversation) = conversation else {
        return Ok(None);
    };
    let participants: Vec<GroupParticipantRow> = query_as(
        "SELECT member.account_id, account.display_name, account.avatar_url, member.role
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         WHERE member.conversation_id = $1 AND member.membership_state = 'active'
         ORDER BY member.account_id ASC",
    )
    .bind(conversation.0)
    .fetch_all(pool)
    .await?;
    Ok(snapshot_from_rows(
        conversation,
        participants,
        group_id,
        group_space_id,
        group_title,
    ))
}

async fn authorized_group_invitation_snapshot_in_transaction(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    inviter_account_id: &str,
    group_id: &str,
    group_space_id: &str,
    group_title: &str,
) -> Result<Option<GroupInvitationSnapshot>, sqlx_core::Error> {
    let conversation: Option<GroupConversationRow> = query_as(
        "SELECT conversation.conversation_id, conversation.created_by_account_id,
                conversation.shared_title
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members inviter
           ON inviter.conversation_id = conversation.conversation_id
         WHERE conversation.legacy_session_id = $1
           AND conversation.kind = 'group'
           AND inviter.account_id = $2
           AND inviter.membership_state = 'active'
           AND inviter.role IN ('owner', 'admin')
         FOR UPDATE OF conversation",
    )
    .bind(group_id)
    .bind(inviter_account_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(conversation) = conversation else {
        return Ok(None);
    };
    let participants: Vec<GroupParticipantRow> = query_as(
        "SELECT member.account_id, account.display_name, account.avatar_url, member.role
         FROM cloud_chat_conversation_members member
         JOIN cloud_accounts account ON account.account_id = member.account_id
         WHERE member.conversation_id = $1 AND member.membership_state = 'active'
         ORDER BY member.account_id ASC",
    )
    .bind(conversation.0)
    .fetch_all(&mut **tx)
    .await?;
    Ok(snapshot_from_rows(
        conversation,
        participants,
        group_id,
        group_space_id,
        group_title,
    ))
}

pub(super) async fn refresh_group_invitation_record(
    pool: &PgPool,
    mut record: GroupInvitationRecord,
) -> Result<Option<GroupInvitationRecord>, sqlx_core::Error> {
    let snapshot = authorized_group_invitation_snapshot(
        pool,
        &record.inviter_account_id,
        &record.snapshot.group_id,
        &record.snapshot.group_space_id,
        &record.snapshot.group_title,
    )
    .await?;
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    record.snapshot = snapshot;
    Ok(Some(record))
}

pub(super) async fn refresh_group_invitation_record_in_transaction(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    mut record: GroupInvitationRecord,
) -> Result<Option<GroupInvitationRecord>, sqlx_core::Error> {
    let snapshot = authorized_group_invitation_snapshot_in_transaction(
        tx,
        &record.inviter_account_id,
        &record.snapshot.group_id,
        &record.snapshot.group_space_id,
        &record.snapshot.group_title,
    )
    .await?;
    let Some(snapshot) = snapshot else {
        return Ok(None);
    };
    record.snapshot = snapshot;
    Ok(Some(record))
}

pub(super) async fn lookup_group_invitation(
    pool: &PgPool,
    token: &str,
) -> Result<GroupInvitationLookup, sqlx_core::Error> {
    if !token.starts_with(GROUP_INVITE_TOKEN_PREFIX) {
        return Ok(GroupInvitationLookup::Invalid);
    }
    let row: Option<GroupInvitationRow> = query_as(
        "SELECT invite.invitation_id, invite.inviter_account_id, account.display_name, \
                account.public_account_number, account.avatar_url, invite.group_snapshot, invite.expires_at \
         FROM cloud_group_invitations invite \
         JOIN cloud_accounts account ON account.account_id = invite.inviter_account_id \
         WHERE invite.token_hash = $1 AND invite.revoked_at IS NULL",
    )
    .bind(hash_group_invite_token(token))
    .fetch_optional(pool)
    .await?;

    let Some((
        invitation_id,
        inviter_account_id,
        inviter_display_name,
        inviter_public_account_number,
        inviter_avatar_url,
        snapshot,
        expires_at,
    )) = row
    else {
        return Ok(GroupInvitationLookup::Invalid);
    };
    let is_expired = DateTime::parse_from_rfc3339(&expires_at)
        .map(|value| value.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(true);
    if is_expired {
        return Ok(GroupInvitationLookup::Expired);
    }
    let Ok(snapshot) = serde_json::from_value::<GroupInvitationSnapshot>(snapshot) else {
        return Ok(GroupInvitationLookup::Invalid);
    };
    Ok(GroupInvitationLookup::Valid(Box::new(
        GroupInvitationRecord {
            invitation_id,
            inviter_account_id,
            inviter_display_name,
            inviter_public_account_number,
            inviter_avatar_url,
            snapshot,
            expires_at,
        },
    )))
}

pub(super) fn group_invitation_preview(
    record: &GroupInvitationRecord,
) -> GroupInvitationPreviewResponse {
    GroupInvitationPreviewResponse {
        inviter: AppInvitationInviterResponse {
            display_name: record.inviter_display_name.clone(),
            kordi_id: record.inviter_public_account_number.to_string(),
            avatar_url: record.inviter_avatar_url.clone(),
        },
        group: GroupInvitationGroupResponse {
            name: record.snapshot.group_title.clone(),
            member_count: record.snapshot.participants.len(),
        },
        expires_at: record.expires_at.clone(),
    }
}
