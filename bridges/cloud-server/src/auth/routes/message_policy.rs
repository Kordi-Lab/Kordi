use super::*;

pub(super) const MESSAGE_BODY_MAX_CHARS: usize = 4_000;
pub(super) const MESSAGE_LIST_DEFAULT_LIMIT: i64 = 200;
pub(super) const MESSAGE_LIST_MAX_LIMIT: i64 = 500;
pub(super) const CLOUD_GROUP_CONTROL_PREFIX: &str = "kordi-cloud-group:";
pub(super) const CLOUD_AGENT_RESPONSE_PREFIX: &str = "kordi-cloud-agent-response:";
pub(super) const CLOUD_AGENT_CANCEL_PREFIX: &str = "kordi-cloud-agent-cancel:";
pub(super) const CLOUD_MESSAGE_CLIENT_CREATED_AT_FUTURE_SKEW_SECONDS: i64 = 300;

pub(super) fn cloud_direct_person_session_id(
    left_account_id: &str,
    right_account_id: &str,
) -> String {
    let mut account_ids = [left_account_id.trim(), right_account_id.trim()];
    account_ids.sort_unstable();
    format!(
        "session:direct-person:{}:{}",
        account_ids[0], account_ids[1]
    )
}

pub(super) fn is_cloud_account_id(value: &str) -> bool {
    value.trim().starts_with("acct_")
}

pub(super) fn syncable_cloud_avatar_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.len() > 4096 {
        return None;
    }
    if value.starts_with("https://")
        || value.starts_with("http://")
        || value.starts_with("data:image/png;base64,")
        || value.starts_with("data:image/jpeg;base64,")
        || value.starts_with("data:image/webp;base64,")
    {
        return Some(value.to_string());
    }
    None
}

pub(super) fn sanitize_cloud_group_participant(value: &mut Value) -> bool {
    let Some(object) = value.as_object_mut() else {
        return false;
    };
    let account_id = object
        .get("accountId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    if !is_cloud_account_id(&account_id) {
        return false;
    }
    object.insert("accountId".to_string(), Value::String(account_id.clone()));
    let display_name = object
        .get("displayName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&account_id)
        .to_string();
    object.insert("displayName".to_string(), Value::String(display_name));
    let avatar_url = object
        .get("avatarUrl")
        .and_then(Value::as_str)
        .and_then(syncable_cloud_avatar_url);
    object.insert(
        "avatarUrl".to_string(),
        avatar_url.map(Value::String).unwrap_or(Value::Null),
    );
    if !object.get("role").is_some_and(Value::is_string) {
        object.insert("role".to_string(), Value::String("person".to_string()));
    }
    true
}

pub(super) fn is_cloud_agent_control_body(body: &str) -> bool {
    let body = body.trim_start();
    body.starts_with(CLOUD_AGENT_RESPONSE_PREFIX) || body.starts_with(CLOUD_AGENT_CANCEL_PREFIX)
}

pub(super) fn sanitized_cloud_group_control_body(body: &str) -> Option<String> {
    let encoded = body.trim().strip_prefix(CLOUD_GROUP_CONTROL_PREFIX)?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    let mut value: Value = serde_json::from_slice(&decoded).ok()?;
    let object = value.as_object_mut()?;
    sanitize_cloud_group_participant(object.get_mut("actor")?).then_some(())?;
    let participants = object.get_mut("participants")?.as_array_mut()?;
    participants.retain_mut(sanitize_cloud_group_participant);
    if participants.is_empty() {
        return None;
    }
    let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).ok()?);
    Some(format!("{CLOUD_GROUP_CONTROL_PREFIX}{encoded}"))
}

pub(super) fn normalize_cloud_message_body(body: &str) -> Result<String, &'static str> {
    let body = body.trim();
    if body.starts_with(CLOUD_GROUP_CONTROL_PREFIX) {
        let Some(sanitized) = sanitized_cloud_group_control_body(body) else {
            return Err("invalid_group_control");
        };
        if sanitized.chars().count() > MESSAGE_BODY_MAX_CHARS {
            return Err("message_too_large");
        }
        return Ok(sanitized);
    }
    if is_cloud_agent_control_body(body) {
        return Ok(body.to_string());
    }
    Ok(body
        .chars()
        .take(MESSAGE_BODY_MAX_CHARS)
        .collect::<String>())
}

pub(super) fn cloud_message_session_id(
    requested_session_id: Option<&str>,
    from_account_id: &str,
    to_account_id: &str,
    body: &str,
) -> Option<String> {
    if let Some(value) = requested_session_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(value.chars().take(256).collect::<String>());
    }
    if from_account_id != to_account_id && cloud_message_requires_accepted_contact(body) {
        return Some(cloud_direct_person_session_id(
            from_account_id,
            to_account_id,
        ));
    }
    None
}

pub(super) fn cloud_message_effective_created_at(
    client_created_at: Option<&str>,
    now: DateTime<Utc>,
) -> String {
    let Some(raw) = client_created_at
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return now.to_rfc3339();
    };
    let Ok(parsed) = DateTime::parse_from_rfc3339(raw) else {
        return now.to_rfc3339();
    };
    let parsed_utc = parsed.with_timezone(&Utc);
    if parsed_utc
        > now + ChronoDuration::seconds(CLOUD_MESSAGE_CLIENT_CREATED_AT_FUTURE_SKEW_SECONDS)
    {
        return now.to_rfc3339();
    }
    parsed_utc.to_rfc3339()
}

pub(super) fn cloud_message_requires_accepted_contact(body: &str) -> bool {
    !body.trim_start().starts_with(CLOUD_GROUP_CONTROL_PREFIX)
}

pub(super) fn message_sync_payload(message: &MessageSummary) -> serde_json::Value {
    serde_json::json!({ "message": message })
}

pub(super) fn contact_acceptance_hello_sync_summaries(
    message_id: &str,
    request_from_account_id: &str,
    request_to_account_id: &str,
    body: &str,
    created_at: &str,
) -> (MessageSummary, MessageSummary) {
    let session_id = Some(cloud_direct_person_session_id(
        request_from_account_id,
        request_to_account_id,
    ));
    let acceptor_summary = MessageSummary {
        message_id: message_id.to_string(),
        from_account_id: request_to_account_id.to_string(),
        to_account_id: request_from_account_id.to_string(),
        body: body.to_string(),
        session_id,
        created_at: created_at.to_string(),
        delivered_at: Some(created_at.to_string()),
        read_at: None,
        direction: "outgoing".into(),
        attachments: vec![],
    };
    let requester_summary = MessageSummary {
        direction: "incoming".into(),
        ..acceptor_summary.clone()
    };
    (acceptor_summary, requester_summary)
}

#[cfg(test)]
mod tests;
