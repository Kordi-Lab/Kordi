//! Dissolving a group or one of its channels. Only a group owner or admin
//! may do it. Every message, plan card and call in the dissolved
//! conversations is deleted and every member is removed, so their devices
//! drop it through the usual `membership.removed` event. The empty
//! conversation rows stay only so that removal can reach those devices
//! through the sync stream, as when an account is deleted.
//!
//! Dissolving a group also revokes its invitation links and forgets its
//! pins. Queued agent runs in it are cancelled and running agent
//! subsessions stop.

use super::service_members::is_service_member;
use super::*;

/// What a dissolve removed.
#[derive(Debug, Default, PartialEq, Eq, Serialize)]
pub struct DissolveOutcome {
    /// Conversations dissolved: every channel of a group, or one channel.
    pub conversation_ids: Vec<Uuid>,
    /// People who lost access, the caller included.
    pub removed_account_ids: Vec<String>,
}

/// The SQL expression for a group conversation's space, as channels use it.
const GROUP_SPACE_SQL: &str = "COALESCE(group_space_id, \
     regexp_replace(COALESCE(legacy_session_id, conversation_id::text), '^(group:)+', ''))";

fn normalized_space(group_space_id: &str) -> Option<&str> {
    let space = group_space_id.trim().trim_start_matches("group:");
    (!space.is_empty()).then_some(space)
}

/// The group's channels in creation order, locked. The first one is the
/// group's authority, as for channel creation.
async fn group_channels(
    transaction: &mut Transaction<'_, Postgres>,
    space: &str,
) -> Result<Vec<(Uuid, Option<String>)>, StoreError> {
    Ok(query_as(&format!(
        "SELECT conversation_id, legacy_session_id FROM cloud_chat_conversations \
         WHERE kind = 'group' AND {GROUP_SPACE_SQL} = $1 \
         ORDER BY created_at, conversation_id FOR UPDATE"
    ))
    .bind(space)
    .fetch_all(&mut **transaction)
    .await?)
}

async fn require_group_admin(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<(), StoreError> {
    let role: Option<(String,)> = query_as(
        "SELECT role FROM cloud_chat_conversation_members \
         WHERE conversation_id = $1 AND account_id = $2 AND membership_state = 'active'",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut **transaction)
    .await?;
    match role {
        Some((role,)) if role == "owner" || role == "admin" => Ok(()),
        _ => Err(StoreError::Forbidden),
    }
}

/// Dissolves the whole group `group_space_id`: every channel in it.
pub async fn dissolve_group(
    pool: &PgPool,
    account_id: &str,
    group_space_id: &str,
) -> Result<DissolveOutcome, StoreError> {
    let space = normalized_space(group_space_id).ok_or(StoreError::NotFound)?;
    let mut transaction = pool.begin().await?;
    let channels = group_channels(&mut transaction, space).await?;
    let Some((authority, _)) = channels.first() else {
        return Err(StoreError::NotFound);
    };
    require_group_admin(&mut transaction, *authority, account_id).await?;
    let outcome = dissolve_conversations(&mut transaction, &channels).await?;
    // Links and pins name the space with or without its "group:" prefix.
    let spaces = vec![space.to_string(), format!("group:{space}")];
    query(
        "UPDATE cloud_group_invitations SET revoked_at = $2 \
         WHERE group_space_id = ANY($1) AND revoked_at IS NULL",
    )
    .bind(&spaces)
    .bind(Utc::now().to_rfc3339())
    .execute(&mut *transaction)
    .await?;
    query("DELETE FROM cloud_account_group_space_preferences WHERE group_space_id = ANY($1)")
        .bind(&spaces)
        .execute(&mut *transaction)
        .await?;
    transaction.commit().await?;
    Ok(outcome)
}

/// Dissolves one channel of a group. The group's first channel is the group
/// itself: dissolving it means dissolving the group.
pub async fn dissolve_group_channel(
    pool: &PgPool,
    account_id: &str,
    group_space_id: &str,
    conversation_id: Uuid,
) -> Result<DissolveOutcome, StoreError> {
    let space = normalized_space(group_space_id).ok_or(StoreError::NotFound)?;
    let mut transaction = pool.begin().await?;
    let channels = group_channels(&mut transaction, space).await?;
    let Some(position) = channels.iter().position(|(id, _)| *id == conversation_id) else {
        return Err(StoreError::NotFound);
    };
    if position == 0 {
        return Err(StoreError::InvalidInput(
            "the first channel is the group: dissolve the group instead",
        ));
    }
    require_group_admin(&mut transaction, conversation_id, account_id).await?;
    let outcome = dissolve_conversations(&mut transaction, &channels[position..=position]).await?;
    transaction.commit().await?;
    Ok(outcome)
}

async fn dissolve_conversations(
    transaction: &mut Transaction<'_, Postgres>,
    conversations: &[(Uuid, Option<String>)],
) -> Result<DissolveOutcome, StoreError> {
    let ids: Vec<Uuid> = conversations.iter().map(|(id, _)| *id).collect();
    let sessions: Vec<String> = conversations
        .iter()
        .flat_map(|(id, session)| [Some(id.to_string()), session.clone()])
        .flatten()
        .collect();
    // Synced copies of their content go too; only the removal below is sent.
    for table in [
        "cloud_chat_user_sync_events",
        "cloud_chat_messages",
        "cloud_plan_cards",
        "cloud_calls",
    ] {
        query(&format!(
            "DELETE FROM {table} WHERE conversation_id = ANY($1)"
        ))
        .bind(&ids)
        .execute(&mut **transaction)
        .await?;
    }
    let now = Utc::now().to_rfc3339();
    query(
        "UPDATE cloud_agent_fallback_runs SET status = 'cancelled', error_code = 'group_dissolved', \
           error_message = 'The group was dissolved.', completed_at = $2, updated_at = $2 \
         WHERE session_id = ANY($1) AND status = 'queued'",
    )
    .bind(&sessions)
    .bind(&now)
    .execute(&mut **transaction)
    .await?;
    query(
        "UPDATE cloud_agent_subsessions SET status = 'stopped', version = version + 1, \
           updated_at = now() \
         WHERE parent_conversation_id = ANY($1) AND status = 'running'",
    )
    .bind(&ids)
    .execute(&mut **transaction)
    .await?;
    let mut removed_account_ids = std::collections::BTreeSet::new();
    for conversation_id in &ids {
        let version: (i32,) = query_as(
            "UPDATE cloud_chat_conversations SET version = version + 1, updated_at = now() \
             WHERE conversation_id = $1 RETURNING version",
        )
        .bind(conversation_id)
        .fetch_one(&mut **transaction)
        .await?;
        let members: Vec<(String,)> = query_as(
            "UPDATE cloud_chat_conversation_members \
             SET membership_state = 'removed', left_at = now(), version = version + 1 \
             WHERE conversation_id = $1 AND membership_state = 'active' \
             RETURNING account_id",
        )
        .bind(conversation_id)
        .fetch_all(&mut **transaction)
        .await?;
        for (member,) in members {
            if is_service_member(&member) {
                continue;
            }
            insert_sync_event(
                transaction,
                &member,
                "membership.removed",
                Some(*conversation_id),
                Some(*conversation_id),
                Some(version.0),
                &json!({
                    "conversation_id": conversation_id,
                    "account_id": member,
                    "membership_state": "removed",
                    "reason": "dissolved",
                    "version": version.0,
                }),
            )
            .await?;
            removed_account_ids.insert(member);
        }
    }
    Ok(DissolveOutcome {
        conversation_ids: ids,
        removed_account_ids: removed_account_ids.into_iter().collect(),
    })
}
