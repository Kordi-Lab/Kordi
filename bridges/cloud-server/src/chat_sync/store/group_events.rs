//! Group events that everyone in a group reads in its transcript, such as
//! "Ava created the group". They are server notices posted in the actor's
//! name, as a plan card is, so System does not have to join every group.
//! Every member and everyone who joins later reads the same line. Clients
//! render a notice that carries `group_event` as a small centered line
//! instead of a bubble; older clients show it as a System notice.

use super::*;

/// Server-only message kind for notices; clients cannot post it.
const SYSTEM_NOTICE_KIND: &str = "system-notice";
/// `group_event.type` of the line posted when a group is created.
pub const GROUP_CREATED_EVENT: &str = "group.created";

/// `group_event.type` of the line posted when a member leaves a group.
pub const GROUP_MEMBER_LEFT_EVENT: &str = "group.member_left";

/// The line posted when `creator` creates a group.
pub fn group_created_text(creator_name: &str) -> String {
    format!("{creator_name} created the group")
}

/// The line posted when `member` leaves a group.
pub fn group_member_left_text(member_name: &str) -> String {
    format!("{member_name} left the group")
}

fn group_event_message(
    client_message_id: Uuid,
    event_type: &str,
    actor_account_id: &str,
    actor_display_name: &str,
    text: &str,
) -> SendMessageRequest {
    SendMessageRequest {
        client_message_id,
        kind: SYSTEM_NOTICE_KIND.to_string(),
        content: json!({
            "schema": 1,
            "blocks": [{ "type": "text", "text": text }],
            "legacy_attachments": [],
            "group_event": {
                "type": event_type,
                "actor_account_id": actor_account_id,
                "actor_display_name": actor_display_name,
            },
        }),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    }
}

/// Returns a new conversation after posting the created line when it is a
/// group, so everyone in it, and everyone who joins later, reads who started
/// it. A group still works without the line.
pub(super) async fn after_create(
    pool: &PgPool,
    account_id: &str,
    outcome: InsertOutcome<ConversationSnapshot>,
) -> Result<InsertOutcome<ConversationSnapshot>, StoreError> {
    if outcome.inserted && outcome.value.kind == ConversationKind::Group {
        if let Err(error) = post_group_created(pool, outcome.value.id, account_id).await {
            eprintln!("[chat] Could not post the group created line: {error}");
        }
    }
    Ok(outcome)
}

/// Posts "<Name> created the group" into a group that was just created.
/// Posting again for the same group returns the earlier message.
pub async fn post_group_created(
    pool: &PgPool,
    conversation_id: Uuid,
    creator_account_id: &str,
) -> Result<(), StoreError> {
    let name: Option<(Option<String>,)> =
        query_as("SELECT display_name FROM cloud_accounts WHERE account_id = $1")
            .bind(creator_account_id)
            .fetch_optional(pool)
            .await?;
    let Some((name,)) = name else {
        return Ok(());
    };
    let name = crate::document_shares::access::clean_display_name(name.as_deref());
    let client_message_id = Uuid::new_v5(
        &Uuid::NAMESPACE_OID,
        format!("group-created:{conversation_id}").as_bytes(),
    );
    super::send_message(
        pool,
        creator_account_id,
        conversation_id,
        group_event_message(
            client_message_id,
            GROUP_CREATED_EVENT,
            creator_account_id,
            &name,
            &group_created_text(&name),
        ),
    )
    .await
    .map(|_| ())
}

/// Posts "<Name> left the group" into the group's first conversation, in
/// the leaving member's name, inside the transaction that removes them. It
/// must run while they are still an active member.
pub(super) async fn post_member_left(
    transaction: &mut Transaction<'_, Postgres>,
    conversation_id: Uuid,
    account_id: &str,
) -> Result<(), StoreError> {
    let name: Option<(Option<String>,)> =
        query_as("SELECT display_name FROM cloud_accounts WHERE account_id = $1")
            .bind(account_id)
            .fetch_optional(&mut **transaction)
            .await?;
    let Some((name,)) = name else {
        return Ok(());
    };
    let name = crate::document_shares::access::clean_display_name(name.as_deref());
    super::send_message_in_transaction(
        transaction,
        account_id,
        conversation_id,
        group_event_message(
            // Someone may leave, rejoin and leave again: each leave is a new line.
            Uuid::now_v7(),
            GROUP_MEMBER_LEFT_EVENT,
            account_id,
            &name,
            &group_member_left_text(&name),
        ),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn created_line_names_the_creator() {
        assert_eq!(group_created_text("Ava"), "Ava created the group");
    }

    #[test]
    fn left_line_names_the_member() {
        assert_eq!(group_member_left_text("Ben"), "Ben left the group");
    }

    #[test]
    fn created_notice_is_a_system_notice_with_a_group_event() {
        let message = group_event_message(Uuid::nil(), GROUP_CREATED_EVENT, "acct_a", "Ava", "x");
        assert_eq!(message.kind, "system-notice");
        assert_eq!(message.content["group_event"]["type"], "group.created");
        assert_eq!(message.content["group_event"]["actor_account_id"], "acct_a");
        assert_eq!(message.content["blocks"][0]["text"], "x");
    }
}
