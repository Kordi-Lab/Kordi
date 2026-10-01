//! The visible notice every AI access change posts.
//!
//! A notice is an ordinary message from the member who made the change, with
//! the reserved message kind `ai-access-notice`. The kind is set only by the
//! server (clients cannot send it), so clients recognize a notice by its kind
//! and an ordinary message can never imitate one. Older clients show the text
//! as a normal message from that member, which is still truthful.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use super::super::support::*;
use super::super::*;

pub(crate) const AI_ACCESS_NOTICE_KIND: &str =
    crate::cloud_agent_runtime::runs::context_policy::AI_ACCESS_NOTICE_KIND;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NoticeChange {
    HistoryScope(&'static str),
    Pip(bool),
    OptOut(bool),
}

pub(super) fn notice_text(actor: &str, change: NoticeChange, provider: Option<&str>) -> String {
    match change {
        NoticeChange::HistoryScope("recent") => format!(
            "{actor} let agents read recent messages in this group when someone asks them."
        ),
        NoticeChange::HistoryScope(_) => {
            format!("{actor} limited agents in this group to messages sent to them.")
        }
        NoticeChange::Pip(true) => format!(
            "{actor} turned on PiP. PiP reads new messages here to help plan events and uses {} through Kordi's account.",
            provider.unwrap_or("a model provider")
        ),
        NoticeChange::Pip(false) => format!("{actor} turned off PiP in this group."),
        NoticeChange::OptOut(true) => format!(
            "{actor} turned on \u{201c}Don't let AI use my messages.\u{201d} Other people's agents, PiP, and digests will leave out their messages here."
        ),
        NoticeChange::OptOut(false) => {
            format!("{actor} turned off \u{201c}Don't let AI use my messages.\u{201d}")
        }
    }
}

/// The notice body in the conversation's own envelope format.
fn notice_body(
    kind: &str,
    session_id: &str,
    group_space_id: Option<&str>,
    created_by: &str,
    actor: &str,
    participants: &[String],
    text: &str,
) -> String {
    let created_at_ms = Utc::now().timestamp_millis();
    if kind != "group" {
        let message = json!({"schemaVersion": 1, "kind": "message", "text": text});
        return format!(
            "kordi-cloud-message:{}",
            URL_SAFE_NO_PAD.encode(message.to_string())
        );
    }
    // Participant and sender names are filled from server records when the
    // message is stored.
    let envelope = json!({
        "kind": "group-message",
        "groupId": session_id,
        "groupSpaceId": group_space_id.unwrap_or(session_id),
        "groupTitle": null,
        "createdByAccountId": created_by,
        "actor": {"accountId": actor, "displayName": actor},
        "participants": participants
            .iter()
            .map(|account_id| json!({"accountId": account_id, "displayName": account_id}))
            .collect::<Vec<_>>(),
        "message": {
            "id": format!("notice:{}", Uuid::new_v4()),
            "senderAccountId": actor,
            "senderKind": "human",
            "text": text,
            "createdAtMs": created_at_ms,
        },
    });
    format!(
        "kordi-cloud-group:{}",
        URL_SAFE_NO_PAD.encode(envelope.to_string())
    )
}

pub(super) async fn post_notice(
    transaction: &mut Transaction<'_, Postgres>,
    actor: &str,
    conversation_id: Uuid,
    operation_id: Uuid,
    change: NoticeChange,
) -> Result<(), StoreError> {
    let (kind, legacy_session_id, group_space_id, created_by, actor_name): (
        String,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
    ) = query_as(
        "SELECT conversation.kind, conversation.legacy_session_id, conversation.group_space_id,
                conversation.created_by_account_id, account.display_name
         FROM cloud_chat_conversations conversation
         JOIN cloud_accounts account ON account.account_id = $2
         WHERE conversation.conversation_id = $1",
    )
    .bind(conversation_id)
    .bind(actor)
    .fetch_one(&mut **transaction)
    .await?;
    let actor_name = actor_name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "A member".to_string());
    let text = notice_text(&actor_name, change, crate::pip::service_provider_label());
    let participants = super::super::service_members::without_service_members(
        active_member_ids(transaction, conversation_id).await?,
    );
    let session_id = legacy_session_id.unwrap_or_else(|| conversation_id.to_string());
    let body = notice_body(
        &kind,
        &session_id,
        group_space_id.as_deref(),
        &created_by,
        actor,
        &participants,
        &text,
    );
    let request = SendMessageRequest {
        client_message_id: Uuid::new_v5(
            &Uuid::NAMESPACE_OID,
            format!("ai-access-notice:{actor}:{operation_id}").as_bytes(),
        ),
        kind: AI_ACCESS_NOTICE_KIND.to_string(),
        content: json!({"schema": 1, "blocks": [{"type": "text", "text": body}]}),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    super::super::message::send_message_in_transaction(
        transaction,
        actor,
        conversation_id,
        request,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_describe_each_change_in_plain_words() {
        assert_eq!(
            notice_text("Ada", NoticeChange::HistoryScope("recent"), None),
            "Ada let agents read recent messages in this group when someone asks them."
        );
        assert_eq!(
            notice_text("Ada", NoticeChange::HistoryScope("mentions"), None),
            "Ada limited agents in this group to messages sent to them."
        );
        assert!(notice_text("Ada", NoticeChange::Pip(true), Some("OpenAI"))
            .contains("uses OpenAI through Kordi's account"));
        assert_eq!(
            notice_text("Ada", NoticeChange::Pip(false), None),
            "Ada turned off PiP in this group."
        );
        assert!(notice_text("Ada", NoticeChange::OptOut(true), None)
            .starts_with("Ada turned on \u{201c}Don't let AI use my messages.\u{201d}"));
    }

    #[test]
    fn group_notices_carry_no_marker_and_name_the_actor_as_a_human_sender() {
        let body = notice_body(
            "group",
            "session:group:g",
            None,
            "acct_owner",
            "acct_actor",
            &["acct_owner".to_string(), "acct_actor".to_string()],
            "text",
        );
        let encoded = body.strip_prefix("kordi-cloud-group:").unwrap();
        let envelope: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap();
        assert_eq!(envelope["groupSpaceId"], "session:group:g");
        assert_eq!(envelope["message"]["senderKind"], "human");
        assert_eq!(envelope["message"]["senderAccountId"], "acct_actor");
        assert!(envelope["message"]["id"]
            .as_str()
            .unwrap()
            .starts_with("notice:"));
        assert!(envelope.get("notice").is_none());
        assert!(envelope["message"].get("notice").is_none());
        let direct = notice_body("direct", "s", None, "a", "a", &[], "hello");
        assert!(direct.starts_with("kordi-cloud-message:"));
    }
}
