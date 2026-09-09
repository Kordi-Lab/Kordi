//! One human-request target, independent of the client asking to execute it.
use super::envelopes::{CloudGroupMessage, CloudGroupParticipant};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GroupAgentTarget {
    pub owner_account_id: String,
    pub agent_id: String,
}

fn normalized(text: &str) -> String {
    text.nfkc()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
}

fn tokens(text: &str) -> Vec<String> {
    text.char_indices()
        .filter_map(|(i, c)| {
            if c != '@' || (i > 0 && !text[..i].ends_with(char::is_whitespace)) {
                return None;
            }
            let tail = &text[i + 1..];
            let token: String = tail
                .chars()
                .take_while(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '\'' | '’' | '-'))
                .collect();
            if token.eq_ignore_ascii_case("my") {
                let rest = &tail[token.len()..];
                if rest.starts_with([' ', '\t']) {
                    let rest = rest.trim_start_matches([' ', '\t']);
                    if rest
                        .get(..5)
                        .is_some_and(|s| s.eq_ignore_ascii_case("kordi"))
                        && rest[5..]
                            .chars()
                            .next()
                            .is_none_or(|c| c.is_whitespace() || ":;,.!?—-".contains(c))
                    {
                        return Some("mykordi".into());
                    }
                }
            }
            Some(token)
        })
        .collect()
}

fn target_for_ids(
    agent: &str,
    owner: &str,
    sender: &str,
    participants: &[CloudGroupParticipant],
) -> Option<GroupAgentTarget> {
    if owner.is_empty() || !participants.iter().any(|p| p.account_id == owner) {
        return None;
    }
    let default = format!("cloud-agent:{owner}");
    let agent = if agent == format!("cloud-self:{owner}")
        || (agent == "cloud-local-agent" && owner == sender)
    {
        &default
    } else {
        agent
    };
    (agent == default || agent.starts_with("cloud_agent_")).then(|| GroupAgentTarget {
        owner_account_id: owner.into(),
        agent_id: agent.into(),
    })
}

fn mention_target(
    mention: &Value,
    message: &CloudGroupMessage,
    participants: &[CloudGroupParticipant],
) -> Option<GroupAgentTarget> {
    if !matches!(text(mention, "sourceHostId"), "" | "cloud") {
        return None;
    }
    let identity = text(mention, "targetIdentityId");
    let identity_agent = if identity.starts_with("agent:cloud-agent:cloud-agent:")
        || identity.starts_with("agent:cloud-agent:cloud_agent_")
    {
        identity
            .strip_prefix("agent:cloud-agent:")
            .unwrap_or_default()
    } else {
        identity.strip_prefix("agent:").unwrap_or_default()
    };
    let agent = if text(mention, "agentId").is_empty() {
        identity_agent
    } else {
        text(mention, "agentId")
    };
    let inferred_owner = agent
        .strip_prefix("cloud-agent:")
        .or_else(|| {
            participants
                .iter()
                .find(|p| {
                    p.agent_id.as_deref() == Some(agent)
                        || p.account_id == agent
                        || format!("cloud:{}", p.account_id) == agent
                })
                .map(|p| p.account_id.as_str())
        })
        .unwrap_or_default();
    let owner = [
        text(mention, "humanId"),
        text(mention, "nodeId"),
        inferred_owner,
    ]
    .into_iter()
    .find(|v| !v.is_empty())
    .unwrap_or_default();
    let canonical = |id: &str| {
        if !owner.is_empty() && (id == owner || id == format!("cloud:{owner}")) {
            format!("cloud-agent:{owner}")
        } else {
            id.to_string()
        }
    };
    let canonical_agent = canonical(agent);
    if !identity.is_empty()
        && (identity_agent.is_empty() || canonical(identity_agent) != canonical_agent)
    {
        return None;
    }
    let start = mention.get("startUtf16").filter(|v| !v.is_null());
    let length = mention.get("lengthUtf16").filter(|v| !v.is_null());
    if start.is_some() || length.is_some() {
        let start = usize::try_from(start?.as_u64()?).ok()?;
        let length = usize::try_from(length?.as_u64()?).ok()?;
        let display = mention.get("displayText")?.as_str()?;
        let source: Vec<_> = message.text.encode_utf16().collect();
        let display: Vec<_> = display.encode_utf16().collect();
        if length == 0
            || display.first() != Some(&('@' as u16))
            || display.len() != length
            || source.get(start..start.checked_add(length)?)? != display
        {
            return None;
        }
    } else if text(mention, "label").is_empty()
        || !tokens(&message.text)
            .iter()
            .any(|token| normalized(token) == normalized(text(mention, "label")))
    {
        return None;
    }
    target_for_ids(
        &canonical_agent,
        owner,
        &message.sender_account_id,
        participants,
    )
}

pub(super) fn human_group_target(
    message: &CloudGroupMessage,
    participants: &[CloudGroupParticipant],
) -> Option<GroupAgentTarget> {
    if message.sender_kind.as_deref() == Some("agent")
        || message.fork_snapshot == Some(true)
        || message
            .message_action
            .as_ref()
            .is_some_and(|a| text(a, "kind") == "forward")
    {
        return None;
    }
    let sender = message.sender_account_id.trim();
    if !participants.iter().any(|p| p.account_id == sender) {
        return None;
    }
    let agent = message
        .target_cloud_agent_id
        .as_deref()
        .unwrap_or_default()
        .trim();
    let owner = message
        .target_cloud_agent_owner_account_id
        .as_deref()
        .unwrap_or_default()
        .trim();
    let explicit = if !agent.is_empty() || !owner.is_empty() {
        Some(target_for_ids(agent, owner, sender, participants)?)
    } else {
        None
    };
    let mentions = message.mentions.as_deref().unwrap_or_default();
    let agent_mentions: Vec<_> = mentions
        .iter()
        .filter(|m| text(m, "targetKind") == "agent")
        .collect();
    if !agent_mentions.is_empty() {
        let mut targets = BTreeMap::new();
        for mention in agent_mentions {
            let target = mention_target(mention, message, participants)?;
            targets.insert(target.agent_id.clone(), target);
        }
        if targets.len() != 1 {
            return None;
        }
        let target = targets.into_values().next()?;
        return (explicit.as_ref().is_none_or(|e| e == &target)).then_some(target);
    }
    if explicit.is_some() {
        return explicit;
    }
    let source: Vec<_> = message.text.encode_utf16().collect();
    let mut legacy_text = source.clone();
    for mention in mentions {
        let start = usize::try_from(mention.get("startUtf16")?.as_u64()?).ok()?;
        let length = usize::try_from(mention.get("lengthUtf16")?.as_u64()?).ok()?;
        let display: Vec<_> = mention
            .get("displayText")?
            .as_str()?
            .encode_utf16()
            .collect();
        let end = start.checked_add(length)?;
        if length == 0 || source.get(start..end)? != display {
            return None;
        }
        legacy_text.get_mut(start..end)?.fill(' ' as u16);
    }
    let legacy_text = String::from_utf16(&legacy_text).ok()?;
    let mut candidates = BTreeMap::new();
    for token in tokens(&legacy_text) {
        let handle = normalized(&token);
        if matches!(handle.as_str(), "kordi" | "mykordi") {
            let target = GroupAgentTarget {
                owner_account_id: sender.into(),
                agent_id: format!("cloud-agent:{sender}"),
            };
            candidates.insert(target.agent_id.clone(), target);
            continue;
        }
        let matches: Vec<_> = participants
            .iter()
            .filter(|p| {
                let person = normalized(&p.display_name);
                let name = normalized(
                    p.agent_display_name
                        .as_deref()
                        .filter(|n| !n.is_empty())
                        .unwrap_or("Kordi"),
                );
                [
                    format!("{name}{person}"),
                    format!("kordi{person}"),
                    format!("{person}kordi"),
                    format!("{person}skordi"),
                ]
                .contains(&handle)
            })
            .collect();
        if matches.len() > 1 {
            return None;
        }
        if let Some(p) = matches.first() {
            let default = format!("cloud-agent:{}", p.account_id);
            let target = target_for_ids(
                p.agent_id
                    .as_deref()
                    .filter(|a| !a.is_empty())
                    .unwrap_or(&default),
                &p.account_id,
                sender,
                participants,
            )?;
            candidates.insert(target.agent_id.clone(), target);
        }
    }
    if candidates.len() == 1 {
        candidates.into_values().next()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_group_target_contract() {
        let cases: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../shared/agent-targeting/group-cases.json"
        )))
        .unwrap();
        for case in cases["cases"].as_array().unwrap() {
            let message = serde_json::from_value(case["message"].clone()).unwrap();
            let participants: Vec<CloudGroupParticipant> = serde_json::from_value(
                case.get("participants")
                    .unwrap_or(&cases["participants"])
                    .clone(),
            )
            .unwrap();
            assert_eq!(
                serde_json::to_value(human_group_target(&message, &participants)).unwrap(),
                case["expected"],
                "{}",
                case["name"]
            );
        }
    }
}
