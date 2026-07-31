//! Prompt assembly for Cloud fallback runs, including bounded conversation history.

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::authorization::shared_cloud_agent_target_for_claim;
use super::envelopes::{
    cloud_agent_response_text, direct_message_envelope, parse_cloud_group_envelope,
};
use super::{ClaimRunRequest, RunResult};

const MAX_CLOUD_FALLBACK_HISTORY_MESSAGES: i64 = 12;

#[derive(Debug, Clone)]
pub(super) struct CloudFallbackHistoryMessage {
    pub(super) from_account_id: String,
    pub(super) body: String,
}

fn strip_leading_agent_mention(text: &str) -> String {
    let trimmed = text.trim();
    if !trimmed.starts_with('@') {
        return trimmed.to_string();
    }
    let Some((_, rest)) = trimmed.split_once(char::is_whitespace) else {
        return trimmed.to_string();
    };
    rest.trim().to_string()
}

fn action_context_suffix(action: Option<&serde_json::Value>) -> String {
    let Some(action) = action else {
        return String::new();
    };
    let kind = action
        .get("kind")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim();
    let source = action.get("source").and_then(serde_json::Value::as_object);
    let sender = source
        .and_then(|source| source.get("senderLabel"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown sender");
    let source_message_id = source
        .and_then(|source| source.get("sourceMessageId"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
    let preview = source
        .and_then(|source| source.get("textPreview"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!(": {}", value.chars().take(180).collect::<String>()))
        .unwrap_or_default();
    match kind {
        "quote" => format!(" [quotes message {source_message_id} from {sender}{preview}]"),
        "forward" => format!(" [forwarded from message {source_message_id} by {sender}{preview}]"),
        _ => String::new(),
    }
}

fn fallback_prompt_history_line(
    requester_account_id: &str,
    owner_account_id: &str,
    message: &CloudFallbackHistoryMessage,
) -> Option<String> {
    let (label, text, suffix) = if let Some(text) = cloud_agent_response_text(&message.body) {
        ("Owner's Kordi", text, String::new())
    } else if let Some(envelope) = parse_cloud_group_envelope(&message.body) {
        let group_message = envelope.message?;
        let label = if group_message.sender_account_id == requester_account_id {
            "Requester"
        } else if group_message.sender_account_id == owner_account_id {
            if group_message.sender_kind.as_deref() == Some("agent") {
                "Owner's Kordi"
            } else {
                "Owner"
            }
        } else {
            "Participant"
        };
        (
            label,
            strip_leading_agent_mention(&group_message.text),
            action_context_suffix(group_message.message_action.as_ref()),
        )
    } else if let Some(envelope) = direct_message_envelope(&message.body) {
        let text = envelope
            .get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let suffix = action_context_suffix(envelope.get("messageAction"));
        if message.from_account_id == requester_account_id {
            ("Requester", strip_leading_agent_mention(&text), suffix)
        } else if message.from_account_id == owner_account_id {
            ("Owner", text.trim().to_string(), suffix)
        } else {
            return None;
        }
    } else if message.from_account_id == requester_account_id {
        (
            "Requester",
            strip_leading_agent_mention(&message.body),
            String::new(),
        )
    } else if message.from_account_id == owner_account_id {
        ("Owner", message.body.trim().to_string(), String::new())
    } else {
        return None;
    };
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    Some(format!("{label}: {text}{suffix}"))
}

pub(super) fn fallback_prompt_with_history(
    requester_account_id: &str,
    owner_account_id: &str,
    current_prompt: &str,
    history: &[CloudFallbackHistoryMessage],
) -> String {
    let current_prompt = current_prompt.trim();
    let lines = history
        .iter()
        .filter_map(|message| {
            fallback_prompt_history_line(requester_account_id, owner_account_id, message)
        })
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return current_prompt.to_string();
    }
    format!(
        "Conversation history:\n{}\n\nCurrent request:\n{}",
        lines.join("\n"),
        current_prompt
    )
}

async fn shared_cloud_agent_prompt_prefix(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> Result<Option<String>, sqlx_core::Error> {
    let Some(target) = shared_cloud_agent_target_for_claim(pool, input).await? else {
        return Ok(None);
    };
    let row: Option<(String, String, Option<String>, serde_json::Value, serde_json::Value)> = query_as(
        "SELECT name, system_prompt, source_summary, boundaries_json, skills_json
         FROM cloud_agent_definitions
         WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active' AND access_scope = 'participant_conversations'",
    )
    .bind(&target.agent_id)
    .bind(&target.owner_account_id)
    .fetch_optional(pool)
    .await?;
    let Some((name, system_prompt, source_summary, boundaries_json, skills_json)) = row else {
        return Ok(None);
    };
    let boundaries: Vec<String> = serde_json::from_value(boundaries_json).unwrap_or_default();
    let skills: Vec<serde_json::Value> = serde_json::from_value(skills_json).unwrap_or_default();
    let owner = target.owner_name.unwrap_or(target.owner_account_id);
    let mut sections = vec![
        format!("You are {name}, {owner}'s shared Cloud Agent."),
        "Answer as this shared Cloud Agent, not as the default Kordi agent.".to_string(),
        format!("Cloud Agent system prompt:\n{system_prompt}"),
    ];
    if let Some(summary) = source_summary
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        sections.push(format!("Source summary:\n{summary}"));
    }
    if !boundaries.is_empty() {
        sections.push(format!(
            "Boundaries:\n{}",
            boundaries
                .into_iter()
                .map(|value| format!("- {value}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let skill_sections = skills
        .into_iter()
        .filter_map(|skill| {
            let name = skill.get("name")?.as_str()?.trim();
            let description = skill.get("description")?.as_str()?.trim();
            if name.is_empty() || description.is_empty() {
                return None;
            }
            let content = skill
                .get("content")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            Some(match content {
                Some(content) => format!("Skill {name} ({description}):\n{content}"),
                None => format!("Skill {name}: {description}"),
            })
        })
        .collect::<Vec<_>>();
    if !skill_sections.is_empty() {
        sections.push(format!("Agent skills:\n{}", skill_sections.join("\n\n")));
    }
    Ok(Some(sections.join("\n\n")))
}

pub(super) async fn fallback_prompt_for_claim(
    pool: &PgPool,
    input: &ClaimRunRequest,
) -> RunResult<String> {
    let Some((request_created_at,)) = query_as::<_, (String,)>(
        "SELECT created_at FROM cloud_messages WHERE message_id = $1 AND session_id = $2",
    )
    .bind(&input.request_message_id)
    .bind(&input.session_id)
    .fetch_optional(pool)
    .await?
    else {
        return Ok(input.prompt.trim().to_string());
    };

    let mut history = query_as::<_, (String, String)>(
        "SELECT from_account_id, body FROM cloud_messages \
         WHERE session_id = $1 AND created_at < $2 \
         ORDER BY created_at DESC LIMIT $3",
    )
    .bind(&input.session_id)
    .bind(&request_created_at)
    .bind(MAX_CLOUD_FALLBACK_HISTORY_MESSAGES)
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(from_account_id, body)| CloudFallbackHistoryMessage {
        from_account_id,
        body,
    })
    .collect::<Vec<_>>();
    history.reverse();

    let prompt = fallback_prompt_with_history(
        &input.requester_account_id,
        &input.owner_account_id,
        &input.prompt,
        &history,
    );
    if let Some(prefix) = shared_cloud_agent_prompt_prefix(pool, input).await? {
        return Ok(format!("{prefix}\n\nConversation request:\n{prompt}"));
    }
    Ok(prompt)
}
