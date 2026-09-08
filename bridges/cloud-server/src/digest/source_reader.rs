use super::models::Source;
use serde_json::Value;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use std::collections::HashMap;
type Result<T> = std::result::Result<T, sqlx_core::Error>;
type Row = (
    String,
    String,
    String,
    String,
    String,
    String,
    Value,
    chrono::DateTime<chrono::Utc>,
    i32,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
);
// Keep authorization identical for aggregation, cached reads, evidence and conversion.
const SOURCE_FROM: &str = " FROM cloud_chat_messages m
 JOIN cloud_chat_conversations c ON c.conversation_id=m.conversation_id
 JOIN cloud_chat_conversation_members member ON member.conversation_id=c.conversation_id AND member.account_id=$1 AND member.membership_state='active'
 JOIN cloud_accounts sender ON sender.account_id=m.sender_account_id
 LEFT JOIN cloud_default_agent_profiles profile ON profile.owner_account_id=m.sender_account_id
 LEFT JOIN cloud_agent_fallback_runs source_run ON source_run.response_message_id=m.message_id::text AND source_run.owner_account_id=m.sender_account_id
 WHERE m.deleted_at IS NULL
 AND NOT EXISTS (SELECT 1 FROM cloud_chat_message_visibility v WHERE v.account_id=$1 AND v.message_id=m.message_id)
 AND NOT EXISTS (SELECT 1 FROM cloud_account_session_visibility v WHERE v.account_id=$1 AND v.session_id=COALESCE(c.legacy_session_id,c.conversation_id::text) AND (v.hidden_at IS NOT NULL OR v.deleted_at IS NOT NULL))";

pub fn visible_text(content: &Value) -> Option<String> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let blocks = content.get("blocks")?.as_array()?;
    let mut texts = Vec::new();
    for block in blocks {
        if block.get("type")?.as_str()? != "text" {
            continue;
        }
        let raw = block.get("text")?.as_str()?.trim();
        if raw.starts_with("kordi-cloud-") {
            let (prefix, encoded) = raw.split_once(':')?;
            let value: Value =
                serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
            let kind = value.get("kind")?.as_str()?;
            let text = match (prefix, kind) {
                ("kordi-cloud-message", "message")
                | ("kordi-cloud-agent-response", "agent-response") => {
                    value.get("text")?.as_str()?
                }
                ("kordi-cloud-group", "group-message") => {
                    value.get("message")?.get("text")?.as_str()?
                }
                _ => return None,
            };
            texts.push(text.to_string());
        } else if !raw.is_empty() {
            texts.push(raw.to_string());
        }
    }
    (!texts.is_empty()).then(|| texts.join("\n"))
}

fn message_payload(content: &Value) -> Option<Value> {
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    for block in content.get("blocks")?.as_array()? {
        let Some((prefix, encoded)) = block
            .get("text")
            .and_then(Value::as_str)
            .and_then(|raw| raw.split_once(':'))
        else {
            continue;
        };
        if ![
            "kordi-cloud-group",
            "kordi-cloud-message",
            "kordi-cloud-agent-response",
        ]
        .contains(&prefix)
        {
            continue;
        }
        let value: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
        return if prefix == "kordi-cloud-group" {
            value.get("message").cloned()
        } else {
            Some(value)
        };
    }
    None
}

fn reply_reference(row: &Row) -> Option<(String, Option<String>)> {
    if let Some(id) = &row.13 {
        return Some((id.clone(), None));
    }
    let message = message_payload(&row.6)?;
    if let Some(id) = message.get("replyToMessageId").and_then(Value::as_str) {
        return Some((id.to_string(), Some(row.2.clone())));
    }
    let action = message.get("messageAction")?;
    if !matches!(action["kind"].as_str(), Some("quote" | "thread")) {
        return None;
    }
    let id = action.pointer("/source/sourceMessageId")?.as_str()?;
    let session = action.pointer("/source/sourceSessionId")?.as_str()?;
    (!id.is_empty() && id.len() <= 300 && !session.is_empty() && session.len() <= 300)
        .then(|| (id.to_string(), Some(session.to_string())))
}

fn legacy_message_ids(rows: &[Row]) -> HashMap<String, String> {
    rows.iter()
        .filter_map(|row| {
            let payload = message_payload(&row.6)?;
            Some((row.0.clone(), payload.get("id")?.as_str()?.to_string()))
        })
        .collect()
}

fn resolve_reply(
    reference: &(String, Option<String>),
    rows: &[&Row],
    legacy_ids: &HashMap<String, String>,
) -> Option<String> {
    let matches: std::collections::BTreeSet<_> = rows
        .iter()
        .filter(|row| {
            reference
                .1
                .as_ref()
                .is_none_or(|session| session == &row.1 || session == &row.2)
                && (reference.0 == row.0
                    || reference.0 == row.14
                    || reference.0 == format!("ios_{}", row.14)
                    || legacy_ids.get(&row.0) == Some(&reference.0))
        })
        .map(|row| row.0.clone())
        .collect();
    (matches.len() == 1)
        .then(|| matches.into_iter().next())
        .flatten()
}

async fn fetch_rows(
    pool: &PgPool,
    account: &str,
    suffix: &str,
    ids: Option<&[String]>,
) -> Result<Vec<Row>> {
    let sql = format!(
        "SELECT m.message_id::text,c.conversation_id::text,COALESCE(c.legacy_session_id,c.conversation_id::text),COALESCE(member.personal_title,c.shared_title,c.group_title,'Conversation'),m.sender_account_id,COALESCE(sender.display_name,'Contact'),m.content,m.created_at,m.version,m.message_kind,profile.display_name,profile.avatar_url,source_run.execution_agent_id,m.reply_to_message_id::text,m.client_message_id::text,sender.avatar_url{SOURCE_FROM}{suffix}"
    );
    let mut request = query_as::<_, Row>(&sql).bind(account);
    if let Some(ids) = ids {
        request = request.bind(ids);
    }
    request.fetch_all(pool).await
}

pub(super) async fn source_page(
    pool: &PgPool,
    account: &str,
    ids: Option<&[String]>,
) -> Result<(Vec<Source>, bool)> {
    let suffix = if ids.is_some() {
        " AND m.message_id::text=ANY($2) ORDER BY m.created_at DESC,m.message_id DESC LIMIT 700"
    } else {
        " AND (m.generation_status IS NULL OR m.generation_status IN ('complete','completed')) ORDER BY m.created_at DESC,m.message_id DESC LIMIT 501"
    };
    let rows = fetch_rows(pool, account, suffix, ids).await?;
    // Decode authorized envelopes once per page, not once per candidate for every reply.
    let mut legacy_ids = legacy_message_ids(&rows);
    let limited = ids.is_none() && rows.len() > 500;
    let references: HashMap<_, _> = rows
        .iter()
        .filter_map(|row| reply_reference(row).map(|reference| (row.0.clone(), reference)))
        .collect();
    let initial: Vec<_> = rows.iter().collect();
    let lookup_ids: Vec<_> = references
        .values()
        .filter(|reference| resolve_reply(reference, &initial, &legacy_ids).is_none())
        .flat_map(|reference| {
            [
                reference.0.clone(),
                reference
                    .0
                    .strip_prefix("ios_")
                    .unwrap_or(&reference.0)
                    .to_string(),
            ]
        })
        .collect();
    let mut extra = if lookup_ids.is_empty() {
        Vec::new()
    } else {
        fetch_rows(pool, account, " AND (m.message_id::text=ANY($2) OR m.client_message_id::text=ANY($2)) ORDER BY m.created_at DESC LIMIT 700", Some(&lookup_ids)).await?
    };
    legacy_ids.extend(legacy_message_ids(&extra));
    let available: Vec<_> = rows.iter().chain(&extra).collect();
    let sessions: Vec<_> = references
        .values()
        .filter(|reference| resolve_reply(reference, &available, &legacy_ids).is_none())
        .filter_map(|reference| reference.1.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .take(200)
        .collect();
    if !sessions.is_empty() {
        // Legacy UI message IDs live in envelopes. Search only the referenced authorized sessions.
        extra.extend(fetch_rows(pool,account," AND (COALESCE(c.legacy_session_id,c.conversation_id::text)=ANY($2) OR c.conversation_id::text=ANY($2)) ORDER BY m.created_at DESC LIMIT 700",Some(&sessions)).await?);
        legacy_ids.extend(legacy_message_ids(&extra));
    }
    let available: Vec<_> = rows.iter().chain(&extra).collect();
    // Only canonical, authorized source records are context. Never trust a client's copied quote text.
    let replies: HashMap<_, _> = references
        .into_iter()
        .filter_map(|(id, reference)| {
            resolve_reply(&reference, &available, &legacy_ids)
                .filter(|target| target != &id)
                .map(|target| (id, target))
        })
        .collect();
    let source_agent_id = |r: &Row| {
        r.12.clone()
            .filter(|id| !id.trim().is_empty())
            .or_else(|| super::source_identity::agent_id(&r.6, &r.9, &r.4))
    };
    let agent_ids: Vec<_> = rows
        .iter()
        .filter_map(source_agent_id)
        .filter(|id| !id.starts_with("cloud-agent:"))
        .collect();
    let definitions: Vec<(String, String, String)> = if agent_ids.is_empty() {
        Vec::new()
    } else {
        let owners: Vec<_> = rows.iter().map(|r| r.4.clone()).collect();
        query_as("SELECT agent_id,owner_account_id,name FROM cloud_agent_definitions WHERE agent_id=ANY($1) AND owner_account_id=ANY($2)")
            .bind(agent_ids).bind(owners).fetch_all(pool).await?
    };
    let names: HashMap<_, _> = definitions
        .into_iter()
        .map(|(id, owner, name)| ((id, owner), name))
        .collect();
    Ok((
        rows.into_iter()
            .filter_map(|r| {
                let agent_id = source_agent_id(&r);
                let is_agent = agent_id.is_some();
                let default_agent =
                    agent_id.as_deref() == Some(format!("cloud-agent:{}", r.4).as_str());
                let sender_name = match &agent_id {
                    Some(_) if default_agent => r.10.clone().unwrap_or_else(|| "Agent".into()),
                    Some(id) => names
                        .get(&(id.clone(), r.4.clone()))
                        .cloned()
                        .unwrap_or_else(|| "Agent".into()),
                    None => r.5.clone(),
                };
                let agent_owner_name = agent_id.as_ref().map(|_| r.5.clone());
                let agent_avatar_url = if default_agent { r.11 } else { None };
                let agent_id = agent_id
                    .filter(|id| default_agent || names.contains_key(&(id.clone(), r.4.clone())));
                visible_text(&r.6).map(|text| Source {
                    reply_to_source_id: replies.get(&r.0).cloned(),
                    id: r.0,
                    conversation_id: r.1,
                    session_id: r.2,
                    session_title: r.3,
                    sender_account_id: r.4,
                    sender_name,
                    sender_avatar_url: r.15,
                    text,
                    created_at: r.7.to_rfc3339(),
                    version: r.8,
                    is_agent,
                    agent_id,
                    agent_owner_name,
                    agent_avatar_url,
                })
            })
            .collect(),
        limited,
    ))
}

pub async fn sources(pool: &PgPool, account: &str, ids: Option<&[String]>) -> Result<Vec<Source>> {
    Ok(source_page(pool, account, ids).await?.0)
}

pub async fn authorized(pool: &PgPool, account: &str, ids: &[String]) -> Result<bool> {
    if ids.is_empty() {
        return Ok(true);
    }
    let found = sources(pool, account, Some(ids)).await?;
    Ok(ids.iter().all(|id| found.iter().any(|s| &s.id == id)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    use serde_json::json;

    fn row(index: usize, session: &str, legacy_id: &str) -> Row {
        let payload = json!({"kind":"message", "id":legacy_id, "text":"x".repeat(4096)});
        (
            format!("canonical-{index}"),
            format!("conversation-{session}"),
            session.into(),
            "Session".into(),
            "sender".into(),
            "Sender".into(),
            json!({"blocks":[{"type":"text", "text":format!("kordi-cloud-message:{}", URL_SAFE_NO_PAD.encode(payload.to_string()))}]}),
            chrono::Utc::now(),
            1,
            "text".into(),
            None,
            None,
            None,
            None,
            format!("client-{index}"),
            None,
        )
    }

    #[test]
    fn reply_alias_index_preserves_canonical_client_legacy_and_ambiguity_rules() {
        let mut rows = vec![
            row(0, "first", "shared-alias"),
            row(1, "second", "shared-alias"),
        ];
        let ids = legacy_message_ids(&rows);
        let available: Vec<_> = rows.iter().collect();
        for reference in ["canonical-0", "client-0", "ios_client-0"] {
            assert_eq!(
                resolve_reply(&(reference.into(), None), &available, &ids),
                Some("canonical-0".into())
            );
        }
        assert_eq!(
            resolve_reply(&("shared-alias".into(), None), &available, &ids),
            None
        );
        for session in ["first", "conversation-first"] {
            assert_eq!(
                resolve_reply(
                    &("shared-alias".into(), Some(session.into())),
                    &available,
                    &ids
                ),
                Some("canonical-0".into())
            );
        }
        assert_eq!(
            resolve_reply(
                &("canonical-0".into(), Some("second".into())),
                &available,
                &ids
            ),
            None
        );
        rows[1].6 = json!({"blocks":[{"type":"text","text":"kordi-cloud-message:malformed"}]});
        let ids = legacy_message_ids(&rows);
        assert_eq!(ids.len(), 1);
        assert_eq!(
            resolve_reply(
                &("shared-alias".into(), None),
                &rows.iter().collect::<Vec<_>>(),
                &ids
            ),
            Some("canonical-0".into())
        );
    }

    #[test]
    fn indexed_reply_resolution_matches_uncached_resolution_for_large_pages() {
        let rows: Vec<_> = (0..184)
            .map(|index| row(index, "session", &format!("legacy-{index}")))
            .collect();
        let available: Vec<_> = rows.iter().collect();
        let references: Vec<_> = (0..64)
            .map(|index| (format!("legacy-{index}"), Some("session".into())))
            .collect();
        let before = std::time::Instant::now();
        let expected: Vec<_> = references
            .iter()
            .map(|reference| {
                let matches: std::collections::BTreeSet<_> = available
                    .iter()
                    .filter(|row| {
                        reference
                            .1
                            .as_ref()
                            .is_none_or(|session| session == &row.1 || session == &row.2)
                            && (reference.0 == row.0
                                || reference.0 == row.14
                                || reference.0 == format!("ios_{}", row.14)
                                || message_payload(&row.6)
                                    .and_then(|value| value.get("id").cloned())
                                    .and_then(|value| value.as_str().map(str::to_string))
                                    .as_deref()
                                    == Some(reference.0.as_str()))
                    })
                    .map(|row| row.0.clone())
                    .collect();
                (matches.len() == 1)
                    .then(|| matches.into_iter().next())
                    .flatten()
            })
            .collect();
        let old_elapsed = before.elapsed();
        let after = std::time::Instant::now();
        let ids = legacy_message_ids(&rows);
        let actual: Vec<_> = references
            .iter()
            .map(|reference| resolve_reply(reference, &available, &ids))
            .collect();
        assert_eq!(actual, expected);
        eprintln!(
            "Synthetic reply resolution: uncached={}ms, indexed={}ms",
            old_elapsed.as_millis(),
            after.elapsed().as_millis()
        );
    }
}
