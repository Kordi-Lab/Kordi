use super::super::context_policy::{Admission, PolicyRow};
use super::super::envelopes::cloud_group_request_envelope_for_run;
use super::super::speakers::{visible_message, SpeakerDirectory};
use super::*;
use serde_json::json;

/// Wire id, client id, sender, kind, and the first text block as agents read it.
type Row = (String, String, String, String, String);

pub(super) fn response(
    scope: &ContextScope,
    messages: Vec<Value>,
    has_more: bool,
    next: Option<i64>,
) -> Value {
    json!({"sessionId":scope.session_id,"session":{"sessionId":scope.session_id,"title":scope.title,"kind":scope.kind,"participants":[]},
        "window":{"aroundMessageId":null,"hasMoreBefore":has_more,"hasMoreAfter":false},
        "messages":messages,"hasMore":has_more,"nextBeforeSequence":next})
}

pub(super) async fn read(
    pool: &PgPool,
    scope: &ContextScope,
    args: &Value,
    search: bool,
) -> RunResult<Value> {
    let mode = args["mode"].as_str().unwrap_or("index");
    if !search && !matches!(mode, "index" | "messages" | "participants") {
        return Err(RunError::NotFound);
    }
    if !search && mode == "participants" {
        let mut envelope = cloud_group_request_envelope_for_run(
            pool,
            &scope.session_id,
            &scope.request_message_id,
        )
        .await?
        .ok_or(RunError::NotFound)?;
        let members:Vec<(String,)>=query_as("SELECT account_id FROM cloud_chat_conversation_members WHERE conversation_id=$1 AND membership_state='active'").bind(scope.conversation_id).fetch_all(pool).await?;
        envelope
            .participants
            .retain(|p| members.iter().any(|(id,)| id == &p.account_id));
        let agent = envelope
            .message
            .as_ref()
            .and_then(|m| m.target_cloud_agent_id.clone())
            .unwrap_or_else(|| format!("cloud-agent:{}", scope.owner));
        let mut value = response(scope, vec![], false, None);
        value["directory"] = json!(super::super::group_mentions::mention_instruction(
            &envelope,
            &scope.owner,
            &agent
        ));
        return Ok(value);
    }
    let query = args["query"]
        .as_str()
        .unwrap_or_default()
        .trim()
        .to_lowercase();
    if search && (query.is_empty() || query.chars().count() > 200) {
        return Err(RunError::NotFound);
    }
    let ids = args["messageIds"]
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .take(80)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let selected = !search && mode == "messages";
    if selected && ids.is_empty() {
        return Err(RunError::NotFound);
    }
    let limit = args["limit"]
        .as_u64()
        .unwrap_or(if search { 8 } else { 30 })
        .clamp(1, 80) as usize;
    let viewers = vec![scope.owner.clone(), scope.requester.clone()];
    let policy = scope.policy.as_ref().ok_or(RunError::NotFound)?;
    let admitted = |(id, client, sender, kind, body): &Row| {
        policy.admit(&PolicyRow {
            wire_id: id,
            client_id: Some(client),
            sender,
            kind,
            body,
        }) == Admission::Admit
    };
    let mut before = args["beforeSequence"].as_i64().unwrap_or(i64::MAX);
    if let Some(around) = args["aroundMessageId"].as_str() {
        let row:Option<(String,String,String,String,Value,i64)>=query_as("SELECT message_id::text,client_message_id::text,sender_account_id,message_kind,content,conversation_sequence FROM cloud_chat_messages m WHERE conversation_id=$1 AND message_id::text=$2 AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id=ANY($3))")
            .bind(scope.conversation_id).bind(around).bind(&viewers).fetch_optional(pool).await?;
        let (id, client, sender, kind, content, sequence) = row.ok_or(RunError::NotFound)?;
        // A message the run may not use cannot anchor a window either.
        let body = crate::chat_sync::voice::body_for_agent(&content);
        if !admitted(&(id, client, sender, kind, body)) {
            return Err(RunError::NotFound);
        }
        before = sequence.saturating_add((limit / 2) as i64 + 1);
    }
    // A filtering policy can leave most rows out, so scan a full page of
    // candidates and continue from the last scanned sequence.
    let scan_limit = if search || policy.filters() {
        256
    } else {
        limit as i64 + 1
    };
    let rows:Vec<(String,String,String,String,Value,i64,String)>=query_as(
        "SELECT message_id::text,client_message_id::text,sender_account_id,message_kind,content,conversation_sequence,created_at::text
         FROM cloud_chat_messages m WHERE conversation_id=$1 AND deleted_at IS NULL AND conversation_sequence<$2
         AND (NOT $3 OR message_id::text=ANY($4))
         AND NOT EXISTS(SELECT 1 FROM cloud_chat_message_visibility v WHERE v.message_id=m.message_id AND v.account_id=ANY($5))
         ORDER BY conversation_sequence DESC LIMIT $6"
    ).bind(scope.conversation_id).bind(before).bind(selected).bind(&ids).bind(&viewers).bind(scan_limit).fetch_all(pool).await?;
    let mut exhausted = rows.len() < scan_limit as usize;
    let rows = rows
        .into_iter()
        .map(
            |(id, client, sender, kind, content, sequence, created_at)| {
                let body = crate::chat_sync::voice::body_for_agent(&content);
                let admit = admitted(&(id.clone(), client, sender.clone(), kind, body.clone()));
                (id, sender, body, sequence, created_at, admit)
            },
        )
        .collect::<Vec<_>>();
    let candidate_ids = rows
        .iter()
        .filter(|row| row.5)
        .map(|row| row.0.clone())
        .collect::<Vec<_>>();
    let refs = super::media::references(
        pool,
        &scope.session_id,
        &candidate_ids,
        &scope.owner,
        &scope.requester,
    )
    .await?;
    let speakers = SpeakerDirectory::load(
        pool,
        rows.iter()
            .filter(|row| row.5)
            .map(|row| (row.1.as_str(), row.2.as_str())),
    )
    .await?;
    let mut messages = Vec::new();
    let mut next = None;
    for (id, sender, body, sequence, created_at, admit) in rows {
        if messages.len() >= limit {
            exhausted = false;
            break;
        }
        next = Some(sequence);
        if !admit {
            continue;
        }
        let Some((sender, kind, text)) = visible_message(&speakers, &sender, &body) else {
            continue;
        };
        if search && !text.to_lowercase().contains(&query) {
            continue;
        }
        let include = selected || (search && args["includeMessages"].as_bool().unwrap_or(false));
        let offset = if selected {
            args["offset"].as_u64().unwrap_or(0).min(usize::MAX as u64) as usize
        } else {
            0
        };
        let next_offset = (include && text.chars().count().saturating_sub(offset) > 1200)
            .then(|| offset.saturating_add(1200));
        let attachments = refs
            .iter()
            .filter(|r| r.message_id == id)
            .collect::<Vec<_>>();
        messages.push(json!({"messageId":id,"sender":sender,"kind":kind,"role":kind,"sequenceNum":sequence,"timeLabel":created_at,"text":include.then(||text.chars().skip(offset).take(1200).collect::<String>()),"nextOffset":next_offset,"attachments":attachments}));
    }
    messages.reverse();
    let has_more = !selected && !exhausted;
    let mut value = response(
        scope,
        messages,
        has_more,
        if has_more { next } else { None },
    );
    if search {
        let snippets=value["messages"].as_array().unwrap().iter().filter_map(|m|m["text"].as_str().map(|text|json!({"messageId":m["messageId"],"sender":m["sender"],"text":text,"timeLabel":null}))).collect::<Vec<_>>();
        value["sessions"] = if value["messages"].as_array().unwrap().is_empty() {
            json!([])
        } else {
            json!([{"sessionId":scope.session_id,"title":scope.title,"kind":scope.kind,"participants":[],"updatedAtLabel":null,"reason":"Matching authorized conversation messages","snippets":snippets}])
        };
    }
    Ok(value)
}
