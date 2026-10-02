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

/// The route from `(sender, body)` rows the caller already loaded, oldest
/// first, that follow the request. A response always follows its request, so
/// the lookup reads only the caller's bounded window and adds no query. The
/// newest matching response wins, as in `reply_thread_action`.
pub(super) fn reply_thread_action_in_rows<'a>(
    rows_after_request: impl DoubleEndedIterator<Item = (&'a str, &'a str)>,
    session_id: &str,
    request_id: &str,
    owner: &str,
) -> Option<Value> {
    rows_after_request
        .rev()
        .filter(|(sender, _)| *sender == owner)
        .find_map(|(_, body)| reply_thread_action_from_body(body, session_id, request_id, owner))
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

    fn route_body(request: &str, root: &str) -> String {
        let value = serde_json::json!({"kind":"group-message", "groupId":"group", "message":{
            "senderKind":"agent", "senderAccountId":"owner", "requestId":request,
            "messageAction":{"kind":"thread","source":{"sourceSessionId":"group","sourceMessageId":root}}
        }});
        format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
        )
    }

    #[test]
    fn the_route_comes_from_the_loaded_rows_after_the_request() {
        let older = route_body("request", "older-root");
        let newer = route_body("request", "newer-root");
        let other_request = route_body("other", "other-root");
        let rows = [
            ("owner", older.as_str()),
            ("member", "plain text"),
            ("owner", other_request.as_str()),
            ("owner", newer.as_str()),
        ];
        let root = |action: Option<Value>| {
            action.and_then(|action| {
                action
                    .pointer("/source/sourceMessageId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        };
        let found = reply_thread_action_in_rows(rows.into_iter(), "group", "request", "owner");
        assert_eq!(root(found).as_deref(), Some("newer-root"));
        // A route outside the rows the caller passes is never found.
        assert!(reply_thread_action_in_rows(
            rows[1..3].iter().copied(),
            "group",
            "request",
            "owner"
        )
        .is_none());
        // A route posted by anyone but the owner is never followed.
        let forged = [("member", newer.as_str())];
        assert!(
            reply_thread_action_in_rows(forged.into_iter(), "group", "request", "owner").is_none()
        );
    }
}
