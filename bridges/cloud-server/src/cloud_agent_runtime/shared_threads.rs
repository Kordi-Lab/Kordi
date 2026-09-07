use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use futures_util::TryStreamExt;
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

pub(super) fn reply_thread_action_from_body(
    body: &str,
    session_id: &str,
    request_id: &str,
    owner: &str,
) -> Option<Value> {
    let (prefix, encoded) = body.split_once(':')?;
    if !matches!(prefix, "kordi-cloud-group" | "kordi-cloud-agent-response") {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let decoded: Value = serde_json::from_slice(&bytes).ok()?;
    let message = if prefix == "kordi-cloud-group" {
        let message = decoded.get("message")?;
        if decoded.get("kind")?.as_str()? != "group-message"
            || decoded.get("groupId")?.as_str()? != session_id
            || message.get("senderKind")?.as_str()? != "agent"
            || message.get("senderAccountId")?.as_str()? != owner
        {
            return None;
        }
        message
    } else {
        if decoded.get("kind")?.as_str()? != "agent-response" {
            return None;
        }
        &decoded
    };
    if message
        .get("requestId")
        .or_else(|| message.get("replyToMessageId"))?
        .as_str()?
        != request_id
    {
        return None;
    }
    let action = message.get("messageAction")?;
    if action.get("kind")?.as_str()? != "thread"
        || action.pointer("/source/sourceSessionId")?.as_str()? != session_id
        || action
            .pointer("/source/sourceMessageId")?
            .as_str()?
            .trim()
            .is_empty()
    {
        return None;
    }
    Some(action.clone())
}

pub(super) async fn reply_thread_action(
    pool: &PgPool,
    session_id: &str,
    request_id: &str,
    owner: &str,
) -> Result<Option<Value>, sqlx_core::Error> {
    // ponytail: stream the owner's response envelopes; add an indexed route
    // projection if scanning long conversation histories becomes measurable.
    let mut rows = query_as::<_, (String,)>(
        "SELECT message.content #>> '{blocks,0,text}' FROM cloud_chat_messages message \
         JOIN cloud_chat_conversations conversation ON conversation.conversation_id=message.conversation_id \
         WHERE conversation.legacy_session_id=$1 AND message.sender_account_id=$2 AND message.deleted_at IS NULL \
         AND (message.content #>> '{blocks,0,text}' LIKE 'kordi-cloud-agent-response:%' \
              OR message.content #>> '{blocks,0,text}' LIKE 'kordi-cloud-group:%') \
         ORDER BY message.conversation_sequence DESC",
    ).bind(session_id).bind(owner).fetch(pool);
    while let Some((body,)) = rows.try_next().await? {
        if let Some(action) = reply_thread_action_from_body(&body, session_id, request_id, owner) {
            return Ok(Some(action));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persisted_route_is_bound_to_conversation_request_and_owner() {
        let value = serde_json::json!({"kind":"group-message", "groupId":"group", "message":{
            "senderKind":"agent", "senderAccountId":"owner", "requestId":"request",
            "messageAction":{"kind":"thread","source":{"sourceSessionId":"group","sourceMessageId":"root"}}
        }});
        let body = format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
        );
        assert!(reply_thread_action_from_body(&body, "group", "request", "owner").is_some());
        assert!(reply_thread_action_from_body(&body, "other", "request", "owner").is_none());
        assert!(reply_thread_action_from_body(&body, "group", "other", "owner").is_none());
        assert!(reply_thread_action_from_body(&body, "group", "request", "other").is_none());
    }
}
