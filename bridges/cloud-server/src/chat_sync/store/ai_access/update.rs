//! Applying one AI access change.

use super::super::support::*;
use super::super::*;
use super::notice::{post_notice, NoticeChange};
use super::{resolve_conversation, AiAccessError};
use crate::chat_sync::models::UpdateAiAccessRequest;

const OPERATION_KIND: &str = "conversation.ai_access";

/// The single change a request carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Change {
    HistoryScope(&'static str),
    PipEnabled(bool),
    ExcludeMyMessages(bool),
}

#[derive(Serialize)]
struct ChangeIntent {
    conversation_id: Uuid,
    field: &'static str,
    value: serde_json::Value,
}

impl Change {
    fn from_request(request: &UpdateAiAccessRequest) -> Result<Self, AiAccessError> {
        let change = match (
            request.history_scope.as_deref().map(str::trim),
            request.pip_enabled,
            request.exclude_my_messages,
        ) {
            (Some("mentions"), None, None) => Self::HistoryScope("mentions"),
            (Some("recent"), None, None) => Self::HistoryScope("recent"),
            (Some(_), None, None) => {
                return Err(AiAccessError::Invalid(
                    "history_scope must be mentions or recent.",
                ))
            }
            (None, Some(enabled), None) => Self::PipEnabled(enabled),
            (None, None, Some(excluded)) => Self::ExcludeMyMessages(excluded),
            _ => {
                return Err(AiAccessError::Invalid(
                    "Send exactly one of history_scope, pip_enabled, or exclude_my_messages.",
                ))
            }
        };
        Ok(change)
    }

    fn intent(self, conversation_id: Uuid) -> ChangeIntent {
        let (field, value) = match self {
            Self::HistoryScope(scope) => ("history_scope", json!(scope)),
            Self::PipEnabled(enabled) => ("pip_enabled", json!(enabled)),
            Self::ExcludeMyMessages(excluded) => ("exclude_my_messages", json!(excluded)),
        };
        ChangeIntent {
            conversation_id,
            field,
            value,
        }
    }
}

/// The result of an AI access change: the actor's projection, and whether
/// PiP should now join the conversation (done after the transaction commits).
pub struct UpdatedAiAccess {
    pub conversation: ConversationSnapshot,
    pub join_pip: Option<(Uuid, String)>,
}

/// Applies one change in one transaction: the setting, the notice, the
/// membership and digest side effects, and every member's projection.
pub async fn update_ai_access(
    pool: &PgPool,
    account_id: &str,
    conversation_ref: &str,
    request: UpdateAiAccessRequest,
) -> Result<UpdatedAiAccess, AiAccessError> {
    let change = Change::from_request(&request)?;
    let pip_account = crate::pip::service_account_id();
    let mut transaction = pool.begin().await?;
    let conversation_id =
        resolve_conversation(&mut transaction, account_id, conversation_ref).await?;
    let request_fingerprint = fingerprint(&change.intent(conversation_id))?;
    // Turning PiP on repairs a missing membership even when the stored
    // setting already said "on". The join after commit rechecks the setting,
    // so it never brings PiP back to a group that turned it off since.
    let join_pip = (change == Change::PipEnabled(true))
        .then(|| pip_account.map(|pip| (conversation_id, pip.to_string())))
        .flatten();
    advisory_operation_lock(&mut transaction, account_id, request.client_operation_id).await?;
    if existing_operation::<ConversationSnapshot>(
        &mut transaction,
        account_id,
        request.client_operation_id,
        OPERATION_KIND,
        &request_fingerprint,
    )
    .await?
    .is_some()
    {
        // A retry changes nothing. It answers with the conversation as it is
        // now, and may repair PiP's membership only for someone who still
        // manages the group.
        let join_pip = match join_pip {
            Some(join) if manages_group(&mut transaction, conversation_id, account_id).await? => {
                Some(join)
            }
            _ => None,
        };
        let conversation = load_conversation(&mut transaction, conversation_id, account_id).await?;
        transaction.commit().await?;
        return Ok(UpdatedAiAccess {
            conversation,
            join_pip,
        });
    }
    if pip_account == Some(account_id) {
        return Err(StoreError::Forbidden.into());
    }
    // Serialize changes to one conversation's settings.
    let (kind, role): (String, String) = query_as(
        "SELECT conversation.kind, member.role
         FROM cloud_chat_conversations conversation
         JOIN cloud_chat_conversation_members member
           ON member.conversation_id = conversation.conversation_id
         WHERE conversation.conversation_id = $1 AND member.account_id = $2
           AND member.membership_state = 'active'
         FOR UPDATE OF conversation",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_optional(&mut *transaction)
    .await?
    .ok_or(StoreError::Forbidden)?;
    let group_setting = matches!(change, Change::HistoryScope(_) | Change::PipEnabled(_));
    if group_setting && kind != "group" {
        return Err(AiAccessError::Invalid(
            "Only group conversations have this setting.",
        ));
    }
    if kind == "ai" {
        return Err(AiAccessError::Invalid(
            "Agent conversations have no AI access settings.",
        ));
    }
    if group_setting && !matches!(role.as_str(), "owner" | "admin") {
        return Err(StoreError::Forbidden.into());
    }
    if change == Change::PipEnabled(true) && pip_account.is_none() {
        return Err(AiAccessError::PipUnavailable);
    }

    let changed = apply(&mut transaction, account_id, conversation_id, change).await?;
    if changed {
        side_effects(&mut transaction, conversation_id, change, pip_account).await?;
        query(
            "UPDATE cloud_chat_conversations SET version = version + 1, updated_at = now()
             WHERE conversation_id = $1",
        )
        .bind(conversation_id)
        .execute(&mut *transaction)
        .await?;
        let notice = match change {
            Change::HistoryScope(scope) => NoticeChange::HistoryScope(scope),
            Change::PipEnabled(enabled) => NoticeChange::Pip(enabled),
            Change::ExcludeMyMessages(excluded) => NoticeChange::OptOut(excluded),
        };
        post_notice(
            &mut transaction,
            account_id,
            conversation_id,
            request.client_operation_id,
            notice,
        )
        .await?;
        for (recipient, projection) in
            load_active_conversation_projections(&mut transaction, conversation_id).await?
        {
            if Some(recipient.as_str()) == pip_account {
                continue;
            }
            insert_sync_event(
                &mut transaction,
                &recipient,
                "conversation.updated",
                Some(conversation_id),
                Some(conversation_id),
                Some(projection.version),
                &json!({ "conversation": projection }),
            )
            .await?;
        }
    }
    let conversation = load_conversation(&mut transaction, conversation_id, account_id).await?;
    record_operation(
        &mut transaction,
        account_id,
        request.client_operation_id,
        OPERATION_KIND,
        &request_fingerprint,
        &conversation,
    )
    .await?;
    transaction.commit().await?;
    Ok(UpdatedAiAccess {
        conversation,
        join_pip,
    })
}

/// Whether the account is an active owner or admin of this group now.
async fn manages_group(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<bool, StoreError> {
    let (manages,): (bool,) = query_as(
        "SELECT EXISTS (
             SELECT 1 FROM cloud_chat_conversations conversation
             JOIN cloud_chat_conversation_members member
               ON member.conversation_id = conversation.conversation_id
             WHERE conversation.conversation_id = $1 AND conversation.kind = 'group'
               AND member.account_id = $2 AND member.membership_state = 'active'
               AND member.role IN ('owner', 'admin'))",
    )
    .bind(conversation_id)
    .bind(account_id)
    .fetch_one(&mut **transaction)
    .await?;
    Ok(manages)
}

/// Stores the change. Returns whether the stored value changed.
async fn apply(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    conversation_id: Uuid,
    change: Change,
) -> Result<bool, StoreError> {
    let stored: Option<(String, bool)> = query_as(
        "SELECT history_scope, pip_enabled FROM cloud_chat_ai_policies WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    let (scope, pip_enabled) = stored.unwrap_or_else(|| ("mentions".to_string(), false));
    let changed = match change {
        Change::HistoryScope(next) if next != scope => query(
            "INSERT INTO cloud_chat_ai_policies (conversation_id, history_scope, updated_by_account_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (conversation_id) DO UPDATE SET
                 history_scope = EXCLUDED.history_scope,
                 updated_by_account_id = EXCLUDED.updated_by_account_id,
                 updated_at = now()",
        )
        .bind(conversation_id)
        .bind(next)
        .bind(account_id),
        Change::PipEnabled(next) if next != pip_enabled => query(
            "INSERT INTO cloud_chat_ai_policies (conversation_id, pip_enabled, updated_by_account_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (conversation_id) DO UPDATE SET
                 pip_enabled = EXCLUDED.pip_enabled,
                 updated_by_account_id = EXCLUDED.updated_by_account_id,
                 updated_at = now()",
        )
        .bind(conversation_id)
        .bind(next)
        .bind(account_id),
        Change::ExcludeMyMessages(true) => query(
            "INSERT INTO cloud_chat_ai_opt_outs (conversation_id, account_id) VALUES ($1, $2)
             ON CONFLICT (conversation_id, account_id) DO NOTHING",
        )
        .bind(conversation_id)
        .bind(account_id),
        Change::ExcludeMyMessages(false) => query(
            "DELETE FROM cloud_chat_ai_opt_outs WHERE conversation_id = $1 AND account_id = $2",
        )
        .bind(conversation_id)
        .bind(account_id),
        Change::HistoryScope(_) | Change::PipEnabled(_) => return Ok(false),
    }
    .execute(&mut **transaction)
    .await?
    .rows_affected()
        > 0;
    Ok(changed)
}

async fn side_effects(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    change: Change,
    pip_account: Option<&str>,
) -> Result<(), StoreError> {
    match change {
        // Members' digests rebuild without the newly excluded messages.
        Change::ExcludeMyMessages(true) => {
            crate::digest::changes::mark_conversation(&mut **transaction, conversation_id).await?;
        }
        Change::PipEnabled(false) => {
            if let Some(pip) = pip_account {
                super::super::service_members::leave_service_member(
                    transaction,
                    conversation_id,
                    pip,
                )
                .await?;
            }
            // PiP's open suggestions are withdrawn with it.
            query(
                "UPDATE cloud_agent_pending_actions SET status = 'superseded'
                 WHERE conversation_id = $1 AND status = 'pending'
                   AND kind IN ('plan_rsvp', 'plan_vote', 'plan_confirm', 'plan_cancel', 'plan_reopen')",
            )
            .bind(conversation_id)
            .execute(&mut **transaction)
            .await?;
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        history_scope: Option<&str>,
        pip_enabled: Option<bool>,
        exclude_my_messages: Option<bool>,
    ) -> UpdateAiAccessRequest {
        UpdateAiAccessRequest {
            client_operation_id: Uuid::new_v4(),
            history_scope: history_scope.map(str::to_string),
            pip_enabled,
            exclude_my_messages,
        }
    }

    #[test]
    fn a_request_carries_exactly_one_valid_change() {
        assert_eq!(
            Change::from_request(&request(Some("recent"), None, None)).unwrap(),
            Change::HistoryScope("recent")
        );
        assert_eq!(
            Change::from_request(&request(None, Some(false), None)).unwrap(),
            Change::PipEnabled(false)
        );
        assert_eq!(
            Change::from_request(&request(None, None, Some(true))).unwrap(),
            Change::ExcludeMyMessages(true)
        );
        for invalid in [
            request(None, None, None),
            request(Some("everything"), None, None),
            request(Some("recent"), Some(true), None),
            request(None, Some(true), Some(true)),
        ] {
            assert!(matches!(
                Change::from_request(&invalid),
                Err(AiAccessError::Invalid(_))
            ));
        }
    }

    #[test]
    fn the_fingerprint_names_the_field_and_value() {
        let id = Uuid::new_v4();
        let on = fingerprint(&Change::PipEnabled(true).intent(id)).unwrap();
        let off = fingerprint(&Change::PipEnabled(false).intent(id)).unwrap();
        let opt_out = fingerprint(&Change::ExcludeMyMessages(true).intent(id)).unwrap();
        assert_ne!(on, off);
        assert_ne!(on, opt_out);
    }
}
