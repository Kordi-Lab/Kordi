use std::collections::BTreeMap;

use super::support::*;
use super::*;

pub(super) struct GroupCreation {
    pub title: Option<String>,
    pub space_id: Option<String>,
    pub roles: Option<BTreeMap<String, String>>,
}

/// Channels inherit the existing group's roster and authority, not the creator's contacts.
pub async fn create_group_channel(
    pool: &PgPool,
    account_id: &str,
    group_space_id: &str,
    mut request: CreateConversationRequest,
) -> Result<InsertOutcome<ConversationSnapshot>, StoreError> {
    if request.kind != ConversationKind::Group
        || normalize_title(request.shared_title.as_deref())?.is_none()
    {
        return Err(StoreError::InvalidInput(
            "a channel needs a group and a title",
        ));
    }
    let space = group_space_id.trim().trim_start_matches("group:");
    if space.is_empty() {
        return Err(StoreError::Forbidden);
    }
    let mut transaction = pool.begin().await?;
    // Use the first channel as the group authority. Lock its membership rows below so a
    // concurrent removal cannot race the inherited roster into a newly created channel.
    let source: Option<(Uuid, Option<String>)> = query_as(
        "SELECT conversation_id, group_title FROM cloud_chat_conversations
         WHERE kind = 'group' AND COALESCE(group_space_id,
           regexp_replace(COALESCE(legacy_session_id, conversation_id::text), '^(group:)+', '')) = $1
         ORDER BY created_at, conversation_id LIMIT 1 FOR UPDATE",
    ).bind(space).fetch_optional(&mut *transaction).await?;
    let (source_id, title) = source.ok_or(StoreError::Forbidden)?;
    let members: Vec<(String, String)> = query_as(
        "SELECT account_id, role FROM cloud_chat_conversation_members
         WHERE conversation_id = $1 AND membership_state = 'active' ORDER BY account_id FOR UPDATE",
    )
    .bind(source_id)
    .fetch_all(&mut *transaction)
    .await?;
    let roles: BTreeMap<String, String> = members
        .into_iter()
        .filter(|(id, _)| !super::service_members::is_service_member(id))
        .collect();
    if !roles.contains_key(account_id) {
        return Err(StoreError::Forbidden);
    }
    if request
        .member_account_ids
        .iter()
        .any(|id| !roles.contains_key(id.trim()))
    {
        return Err(StoreError::Forbidden);
    }
    request.member_account_ids = roles.keys().cloned().collect();
    let outcome = super::conversation::create_conversation_with_options(
        &mut transaction,
        account_id,
        request,
        None,
        1,
        Some(GroupCreation {
            title,
            space_id: Some(space.to_string()),
            roles: Some(roles),
        }),
        None,
    )
    .await?;
    transaction.commit().await?;
    Ok(outcome)
}
