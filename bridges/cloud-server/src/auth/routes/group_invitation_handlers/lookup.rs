use super::*;

type GroupControlRow = (String, String);

pub(super) fn authoritative_snapshot_from_rows(
    rows: Vec<GroupControlRow>,
    group_id: &str,
    group_space_id: &str,
    group_title: &str,
) -> Option<GroupInvitationSnapshot> {
    let mut current: Option<GroupInvitationSnapshot> = None;
    for (message_sender_account_id, body) in rows {
        let Some(control) = parse_group_control_for_invitation(&body) else {
            continue;
        };
        let Some(next) = invitation_snapshot_from_control(
            &body,
            &message_sender_account_id,
            group_id,
            group_space_id,
            group_title,
        ) else {
            continue;
        };

        let Some(previous) = current.as_mut() else {
            let creator_is_admin = next.participants.iter().any(|participant| {
                participant.account_id == message_sender_account_id && participant.role == "admin"
            });
            if control.kind == "group-invite"
                && next.created_by_account_id == message_sender_account_id
                && creator_is_admin
            {
                current = Some(next);
            }
            continue;
        };

        if next.created_by_account_id != previous.created_by_account_id {
            continue;
        }
        let sender_is_admin = message_sender_account_id == previous.created_by_account_id
            || previous.participants.iter().any(|participant| {
                participant.account_id == message_sender_account_id && participant.role == "admin"
            });
        if !sender_is_admin {
            continue;
        }
        let creator_remains = next
            .participants
            .iter()
            .any(|participant| participant.account_id == previous.created_by_account_id);
        if !creator_remains {
            continue;
        }
        if message_sender_account_id != previous.created_by_account_id {
            let non_creator_changed_roles = next.participants.iter().any(|participant| {
                previous
                    .participants
                    .iter()
                    .find(|current| current.account_id == participant.account_id)
                    .map(|current| current.role != participant.role)
                    .unwrap_or(participant.role == "admin")
            });
            if non_creator_changed_roles {
                continue;
            }
        }

        match control.kind.as_str() {
            "group-invite" => {
                let next_accounts = next
                    .participants
                    .iter()
                    .map(|participant| participant.account_id.as_str())
                    .collect::<HashSet<_>>();
                if previous
                    .participants
                    .iter()
                    .all(|participant| next_accounts.contains(participant.account_id.as_str()))
                {
                    *previous = next;
                }
            }
            "group-update" => *previous = next,
            "group-title-update" => previous.group_title = next.group_title,
            _ => {}
        }
    }
    current
}

async fn group_control_rows(
    pool: &PgPool,
    group_id: &str,
) -> Result<Vec<GroupControlRow>, sqlx_core::Error> {
    query_as(
        "SELECT from_account_id, body FROM cloud_messages \
         WHERE session_id = $1 AND body LIKE $2 \
         ORDER BY server_received_at ASC, message_id ASC",
    )
    .bind(group_id)
    .bind(format!("{}%", CLOUD_GROUP_CONTROL_PREFIX))
    .fetch_all(pool)
    .await
}

async fn group_control_rows_in_transaction(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    group_id: &str,
) -> Result<Vec<GroupControlRow>, sqlx_core::Error> {
    query_as(
        "SELECT from_account_id, body FROM cloud_messages \
         WHERE session_id = $1 AND body LIKE $2 \
         ORDER BY server_received_at ASC, message_id ASC",
    )
    .bind(group_id)
    .bind(format!("{}%", CLOUD_GROUP_CONTROL_PREFIX))
    .fetch_all(&mut **tx)
    .await
}

fn invitation_snapshot_for_inviter(
    rows: Vec<GroupControlRow>,
    inviter_account_id: &str,
    group_id: &str,
    group_space_id: &str,
    group_title: &str,
) -> Option<GroupInvitationSnapshot> {
    let snapshot = authoritative_snapshot_from_rows(rows, group_id, group_space_id, group_title)?;
    snapshot_allows_group_invitation(&snapshot, inviter_account_id).then_some(snapshot)
}

pub(super) async fn authorized_group_invitation_snapshot(
    pool: &PgPool,
    inviter_account_id: &str,
    group_id: &str,
    group_space_id: &str,
    group_title: &str,
) -> Result<Option<GroupInvitationSnapshot>, sqlx_core::Error> {
    let rows = group_control_rows(pool, group_id).await?;
    Ok(invitation_snapshot_for_inviter(
        rows,
        inviter_account_id,
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
    let rows = group_control_rows_in_transaction(tx, group_id).await?;
    Ok(invitation_snapshot_for_inviter(
        rows,
        inviter_account_id,
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
