//! Per-conversation AI access: what agents asked in a group may read, whether
//! PiP is a member, and which members keep their messages away from other
//! people's AI. Every change is visible to everyone in the conversation
//! through a notice and a `conversation.updated` projection.

use std::collections::{BTreeSet, HashMap};

use super::support::*;
use super::*;
use crate::chat_sync::models::{AiAccessSnapshot, PipAccessSnapshot};

mod notice;
mod update;
pub use update::{update_ai_access, UpdatedAiAccess};

/// What a conversation's stored settings say, before the viewer is applied.
#[derive(Default)]
struct StoredSettings {
    history_scope: Option<String>,
    pip_enabled: Option<bool>,
    opted_out: BTreeSet<String>,
}

/// Why an AI access request was refused, beyond the shared store errors.
#[derive(Debug)]
pub enum AiAccessError {
    Store(StoreError),
    /// The request does not carry exactly one change valid for this
    /// conversation.
    Invalid(&'static str),
    /// PiP cannot be turned on because this server does not run PiP.
    PipUnavailable,
}

impl From<StoreError> for AiAccessError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<sqlx_core::Error> for AiAccessError {
    fn from(error: sqlx_core::Error) -> Self {
        Self::Store(StoreError::Database(error))
    }
}

#[derive(Debug, Serialize)]
pub struct AiAccessView {
    pub conversation_id: Uuid,
    pub ai_access: Option<AiAccessSnapshot>,
}

async fn load_settings(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_ids: &[Uuid],
) -> Result<HashMap<Uuid, StoredSettings>, StoreError> {
    let mut settings = HashMap::<Uuid, StoredSettings>::new();
    if conversation_ids.is_empty() {
        return Ok(settings);
    }
    let policies: Vec<(Uuid, String, bool)> = query_as(
        "SELECT conversation_id, history_scope, pip_enabled FROM cloud_chat_ai_policies
         WHERE conversation_id = ANY($1)",
    )
    .bind(conversation_ids)
    .fetch_all(&mut **transaction)
    .await?;
    for (conversation_id, scope, pip_enabled) in policies {
        let entry = settings.entry(conversation_id).or_default();
        entry.history_scope = Some(scope);
        entry.pip_enabled = Some(pip_enabled);
    }
    let opt_outs: Vec<(Uuid, String)> = query_as(
        "SELECT conversation_id, account_id FROM cloud_chat_ai_opt_outs
         WHERE conversation_id = ANY($1)",
    )
    .bind(conversation_ids)
    .fetch_all(&mut **transaction)
    .await?;
    for (conversation_id, account_id) in opt_outs {
        settings
            .entry(conversation_id)
            .or_default()
            .opted_out
            .insert(account_id);
    }
    Ok(settings)
}

/// The viewer's AI access projection of one conversation. Agent
/// conversations have none.
fn snapshot_for(
    settings: Option<&StoredSettings>,
    viewer: &str,
    conversation: &ConversationSnapshot,
) -> Option<AiAccessSnapshot> {
    let empty = StoredSettings::default();
    let settings = settings.unwrap_or(&empty);
    let group = match conversation.kind {
        ConversationKind::Ai => return None,
        ConversationKind::Group => true,
        ConversationKind::Direct => false,
    };
    let active = |account_id: &str| {
        conversation
            .members
            .iter()
            .any(|member| member.account_id == account_id && member.membership_state == "active")
    };
    let pip = group.then(|| {
        let pip_account = crate::pip::service_account_id();
        PipAccessSnapshot {
            available: pip_account.is_some(),
            // Truthful: the setting is on and PiP is actually a member.
            enabled: settings.pip_enabled.unwrap_or(false) && pip_account.is_some_and(active),
            provider_label: crate::pip::service_provider_label().map(str::to_string),
        }
    });
    let viewer_can_manage = group
        && conversation.members.iter().any(|member| {
            member.account_id == viewer
                && member.membership_state == "active"
                && matches!(member.role.as_str(), "owner" | "admin")
        });
    Some(AiAccessSnapshot {
        history_scope: if group {
            settings
                .history_scope
                .clone()
                .unwrap_or_else(|| "mentions".to_string())
        } else {
            "recent".to_string()
        },
        pip,
        excluded_member_ids: settings
            .opted_out
            .iter()
            .filter(|account_id| active(account_id))
            .cloned()
            .collect(),
        excluded_account_ids: settings.opted_out.iter().cloned().collect(),
        viewer_excluded: settings.opted_out.contains(viewer),
        viewer_can_manage,
    })
}

/// Fills `ai_access` on snapshots one viewer sees.
pub(super) async fn attach_for_viewer(
    transaction: &mut Transaction<'_, Postgres>,
    viewer: &str,
    conversations: &mut [ConversationSnapshot],
) -> Result<(), StoreError> {
    let ids = conversations.iter().map(|c| c.id).collect::<Vec<_>>();
    let settings = load_settings(transaction, &ids).await?;
    for conversation in conversations {
        conversation.ai_access = snapshot_for(settings.get(&conversation.id), viewer, conversation);
    }
    Ok(())
}

/// Fills `ai_access` on per-member projections of conversations.
pub(super) async fn attach_projections(
    transaction: &mut Transaction<'_, Postgres>,
    projections: &mut [(String, ConversationSnapshot)],
) -> Result<(), StoreError> {
    let ids = projections
        .iter()
        .map(|(_, conversation)| conversation.id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let settings = load_settings(transaction, &ids).await?;
    for (viewer, conversation) in projections {
        conversation.ai_access = snapshot_for(settings.get(&conversation.id), viewer, conversation);
    }
    Ok(())
}

/// Resolves a conversation UUID or a legacy session id. Unknown references are
/// `NotFound`; known conversations the account is not an active member of are
/// `Forbidden`.
async fn resolve_conversation(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_ref: &str,
) -> Result<Uuid, StoreError> {
    let reference = conversation_ref.trim();
    let row: Option<(Uuid,)> = query_as(
        "SELECT conversation_id FROM cloud_chat_conversations
         WHERE conversation_id = $1 OR legacy_session_id = $2
         ORDER BY (conversation_id = $1) DESC NULLS LAST LIMIT 1",
    )
    .bind(Uuid::parse_str(reference).ok())
    .bind(reference)
    .fetch_optional(&mut **transaction)
    .await?;
    let (conversation_id,) = row.ok_or(StoreError::NotFound)?;
    require_active_member(transaction, conversation_id, account_id).await?;
    Ok(conversation_id)
}

/// The viewer's current AI access for one conversation.
pub async fn ai_access_for(
    pool: &PgPool,
    account_id: &str,
    conversation_ref: &str,
) -> Result<AiAccessView, StoreError> {
    let mut transaction = pool.begin().await?;
    let conversation_id =
        resolve_conversation(&mut transaction, account_id, conversation_ref).await?;
    let conversation = load_conversation(&mut transaction, conversation_id, account_id).await?;
    transaction.commit().await?;
    Ok(AiAccessView {
        conversation_id,
        ai_access: conversation.ai_access,
    })
}

/// The account's projection of one conversation.
pub async fn conversation_snapshot(
    pool: &PgPool,
    account_id: &str,
    conversation_id: Uuid,
) -> Result<ConversationSnapshot, StoreError> {
    let mut transaction = pool.begin().await?;
    let conversation = load_conversation(&mut transaction, conversation_id, account_id).await?;
    transaction.commit().await?;
    Ok(conversation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn member(account_id: &str, role: &str, state: &str) -> MemberSnapshot {
        MemberSnapshot {
            account_id: account_id.to_string(),
            display_name: None,
            avatar_url: None,
            default_agent_id: format!("cloud-agent:{account_id}"),
            default_agent_display_name: "Kordi".to_string(),
            default_agent_avatar_url: None,
            role: role.to_string(),
            membership_state: state.to_string(),
            version: 1,
            last_delivered_sequence: 0,
            last_read_sequence: 0,
            joined_at: Utc::now(),
            left_at: None,
        }
    }

    fn conversation(kind: ConversationKind, members: Vec<MemberSnapshot>) -> ConversationSnapshot {
        let id = Uuid::new_v4();
        ConversationSnapshot {
            id,
            kind,
            shared_title: None,
            version: 1,
            created_by_account_id: "acct_owner".to_string(),
            legacy_session_id: None,
            group_space_id: None,
            group_title: None,
            forked_from_session_id: None,
            forked_from_message_id: None,
            latest_message_sequence: 0,
            created_at: Utc::now(),
            updated_at: Utc::now(),
            members,
            preferences: ConversationPreferencesSnapshot {
                conversation_id: id,
                account_id: "acct_owner".to_string(),
                personal_title: None,
                version: 1,
            },
            ai_access: None,
        }
    }

    #[test]
    fn groups_default_to_mentions_and_list_active_opted_out_members_for_settings() {
        let group = conversation(
            ConversationKind::Group,
            vec![
                member("acct_owner", "owner", "active"),
                member("acct_member", "member", "active"),
                member("acct_left", "member", "removed"),
            ],
        );
        let settings = StoredSettings {
            opted_out: BTreeSet::from(["acct_member".to_string(), "acct_left".to_string()]),
            ..StoredSettings::default()
        };
        let owner = snapshot_for(Some(&settings), "acct_owner", &group).unwrap();
        assert_eq!(owner.history_scope, "mentions");
        assert_eq!(owner.excluded_member_ids, ["acct_member"]);
        // Device filters still leave out the messages of a member who left.
        assert_eq!(owner.excluded_account_ids, ["acct_left", "acct_member"]);
        assert!(owner.viewer_can_manage);
        assert!(!owner.viewer_excluded);
        let pip = owner.pip.expect("groups report PiP");
        assert!(!pip.enabled, "a missing row means PiP is off");
        let member_view = snapshot_for(Some(&settings), "acct_member", &group).unwrap();
        assert!(member_view.viewer_excluded);
        assert!(!member_view.viewer_can_manage);
        // A member who left keeps the opt-out row, so past messages stay out.
        let left = snapshot_for(Some(&settings), "acct_left", &group).unwrap();
        assert!(left.viewer_excluded);
    }

    #[test]
    fn direct_conversations_are_recent_and_agent_conversations_have_no_settings() {
        let direct = conversation(
            ConversationKind::Direct,
            vec![
                member("acct_owner", "owner", "active"),
                member("acct_peer", "member", "active"),
            ],
        );
        let view = snapshot_for(None, "acct_owner", &direct).unwrap();
        assert_eq!(view.history_scope, "recent");
        assert!(view.pip.is_none());
        assert!(!view.viewer_can_manage);
        let ai = conversation(
            ConversationKind::Ai,
            vec![member("acct_owner", "owner", "active")],
        );
        assert!(snapshot_for(None, "acct_owner", &ai).is_none());
    }

    #[test]
    fn pip_is_enabled_only_while_it_is_an_active_member() {
        let pip = crate::pip::test_service_account();
        let settings = StoredSettings {
            pip_enabled: Some(true),
            history_scope: Some("recent".to_string()),
            ..StoredSettings::default()
        };
        let without = conversation(
            ConversationKind::Group,
            vec![member("acct_owner", "owner", "active")],
        );
        let view = snapshot_for(Some(&settings), "acct_owner", &without).unwrap();
        assert_eq!(view.history_scope, "recent");
        assert!(!view.pip.unwrap().enabled);
        let with = conversation(
            ConversationKind::Group,
            vec![
                member("acct_owner", "owner", "active"),
                member(pip, "member", "active"),
            ],
        );
        assert!(
            snapshot_for(Some(&settings), "acct_owner", &with)
                .unwrap()
                .pip
                .unwrap()
                .enabled
        );
    }
}
