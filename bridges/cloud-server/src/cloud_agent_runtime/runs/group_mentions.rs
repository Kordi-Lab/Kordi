//! Exact, run-scoped group handle resolution for one-hop agent handoffs.

use std::collections::{HashMap, HashSet};

use unicode_normalization::UnicodeNormalization;

use super::envelopes::{CloudGroupEnvelope, CloudGroupMessage, CloudGroupParticipant};

pub(super) const CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MentionKind {
    Person,
    Agent,
}

#[derive(Clone, Debug)]
struct MentionEntry {
    participant: CloudGroupParticipant,
    display_name: String,
    handle: String,
    kind: MentionKind,
}

fn clean_display_name(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn safe_mention_characters(value: &str) -> String {
    value
        .nfkc()
        .filter(|character| character.is_alphanumeric())
        .take(64)
        .collect()
}

fn person_handle(display_name: &str) -> String {
    let handle = safe_mention_characters(display_name);
    if handle.is_empty() {
        "Participant".to_string()
    } else {
        handle
    }
}

fn agent_handle(display_name: &str) -> String {
    let scoped =
        if display_name.eq_ignore_ascii_case("me") || display_name.eq_ignore_ascii_case("you") {
            "My Kordi".to_string()
        } else {
            format!("{display_name}'s Kordi")
        };
    let handle = safe_mention_characters(&scoped);
    if handle.is_empty() {
        "Kordi".to_string()
    } else {
        handle
    }
}

fn normalized_handle(value: &str) -> String {
    value
        .nfkc()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn mention_catalog(participants: &[CloudGroupParticipant]) -> Vec<MentionEntry> {
    let mut seen_accounts = HashSet::new();
    let mut candidates = Vec::new();
    for participant in participants {
        let account_id = participant.account_id.trim();
        let display_name = clean_display_name(&participant.display_name);
        if account_id.is_empty()
            || display_name.is_empty()
            || !seen_accounts.insert(account_id.to_string())
        {
            continue;
        }
        candidates.push(MentionEntry {
            participant: participant.clone(),
            handle: person_handle(&display_name),
            display_name: display_name.clone(),
            kind: MentionKind::Person,
        });
        candidates.push(MentionEntry {
            participant: participant.clone(),
            handle: agent_handle(&display_name),
            display_name,
            kind: MentionKind::Agent,
        });
    }
    let mut counts = HashMap::new();
    for candidate in &candidates {
        let handle = normalized_handle(&candidate.handle);
        if !handle.is_empty() {
            *counts.entry(handle).or_insert(0usize) += 1;
        }
    }
    candidates
        .into_iter()
        .filter(|candidate| counts.get(&normalized_handle(&candidate.handle)) == Some(&1))
        .collect()
}

fn message_mention_depth(message: &CloudGroupMessage) -> u32 {
    message.agent_mention_depth.unwrap_or(0)
}

pub(super) fn mention_instruction(
    envelope: &CloudGroupEnvelope,
    responding_account_id: &str,
) -> Option<String> {
    let message = envelope.message.as_ref()?;
    let catalog = mention_catalog(&envelope.participants);
    let people = catalog
        .iter()
        .filter(|entry| entry.kind == MentionKind::Person)
        .map(|entry| format!("@{} ({})", entry.handle, entry.display_name))
        .collect::<Vec<_>>();
    let allow_agent_mentions = message_mention_depth(message) < CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH;
    let agents = if allow_agent_mentions {
        catalog
            .iter()
            .filter(|entry| {
                entry.kind == MentionKind::Agent
                    && entry.participant.account_id.trim() != responding_account_id.trim()
            })
            .map(|entry| format!("@{} ({}'s Kordi)", entry.handle, entry.display_name))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    if people.is_empty() && agents.is_empty() {
        return None;
    }
    let requester_account_id = message.sender_account_id.trim();
    let requester_person = catalog.iter().find(|entry| {
        entry.kind == MentionKind::Person
            && entry.participant.account_id.trim() == requester_account_id
    });
    let requester_agent = catalog.iter().find(|entry| {
        entry.kind == MentionKind::Agent
            && entry.participant.account_id.trim() == requester_account_id
    });
    let requester_description = if message.sender_kind.as_deref() == Some("agent") {
        requester_agent.map(|entry| {
            format!(
                "Current requester: @{} ({}'s Kordi).",
                entry.handle, entry.display_name
            )
        })
    } else {
        requester_person.map(|entry| {
            let mut description = format!(
                "Current requester: @{} ({}).",
                entry.handle, entry.display_name
            );
            if let Some(agent) = requester_agent {
                description.push_str(&format!(
                    " In this request, \"my Kordi\" means @{}.",
                    agent.handle
                ));
            }
            description
        })
    };
    let mut sections = vec![
        "Group @mention permissions: use only the exact handles listed below; never invent a handle."
            .to_string(),
    ];
    if let Some(description) = requester_description {
        sections.push(description);
    }
    if !people.is_empty() {
        sections.push(format!("People: {}", people.join(", ")));
    }
    if !agents.is_empty() {
        sections.push(format!("Agents: {}", agents.join(", ")));
        sections.push(
            "To ask another participant's Kordi to act, include exactly one permitted agent handle followed by the request in your final response."
                .to_string(),
        );
    } else if !allow_agent_mentions {
        sections.push(
            "This request already came from another agent. You may mention people, but do not ask another agent."
                .to_string(),
        );
    } else {
        sections.push(
            "No other unambiguous participant Kordi handle is available in this group.".to_string(),
        );
    }
    Some(sections.join("\n"))
}

fn mention_tokens(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split('@').skip(1).map(|tail| {
        tail.chars()
            .take_while(|character| {
                character.is_alphanumeric() || matches!(character, '.' | '_' | '\'' | '’' | '-')
            })
            .collect()
    })
}

pub(super) fn resolve_agent_mention(
    text: &str,
    participants: &[CloudGroupParticipant],
    responding_account_id: &str,
) -> Option<CloudGroupParticipant> {
    let agents_by_handle = mention_catalog(participants)
        .into_iter()
        .filter(|entry| {
            entry.kind == MentionKind::Agent
                && entry.participant.account_id.trim() != responding_account_id.trim()
        })
        .map(|entry| (normalized_handle(&entry.handle), entry.participant))
        .collect::<HashMap<_, _>>();
    mention_tokens(text)
        .find_map(|mention| agents_by_handle.get(&normalized_handle(&mention)).cloned())
}

pub(super) fn agent_handoff_target(envelope: &CloudGroupEnvelope) -> Option<CloudGroupParticipant> {
    let message = envelope.message.as_ref()?;
    if message.sender_kind.as_deref() != Some("agent")
        || message_mention_depth(message) != CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH
        || message
            .target_cloud_agent_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
    {
        return None;
    }
    let target_owner_account_id = message
        .target_cloud_agent_owner_account_id
        .as_deref()?
        .trim();
    let target = resolve_agent_mention(
        &message.text,
        &envelope.participants,
        &message.sender_account_id,
    )?;
    (target.account_id.trim() == target_owner_account_id).then_some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn participant(account_id: &str, display_name: &str) -> CloudGroupParticipant {
        CloudGroupParticipant {
            account_id: account_id.to_string(),
            display_name: display_name.to_string(),
            avatar_url: None,
            role: Some("person".to_string()),
        }
    }

    #[test]
    fn resolves_unicode_nfkc_handle_and_rejects_self_or_ambiguity() {
        let participants = vec![
            participant("acct_source", "Ｒｅｓｅａｒｃｈ Ａｇｅｎｔ"),
            participant("acct_target", "陈 美"),
        ];
        assert_eq!(
            resolve_agent_mention("@陈美sKordi 请确认", &participants, "acct_source")
                .map(|target| target.account_id),
            Some("acct_target".to_string())
        );
        assert!(
            resolve_agent_mention("@ResearchAgentsKordi self", &participants, "acct_source")
                .is_none()
        );

        let ambiguous = vec![
            participant("acct_one", "Same Name"),
            participant("acct_two", "Same-Name"),
        ];
        assert!(
            resolve_agent_mention("@SameNamesKordi hello", &ambiguous, "acct_source").is_none()
        );
    }

    #[test]
    fn instruction_maps_human_requester_my_kordi_and_disables_second_hop() {
        let participants = vec![
            participant("acct_requester", "Maya Chen"),
            participant("acct_owner", "Research Agent"),
        ];
        let mut envelope = CloudGroupEnvelope {
            kind: "group-message".to_string(),
            group_id: "session:group:test".to_string(),
            group_space_id: Some("session:group:test".to_string()),
            group_title: None,
            created_by_account_id: "acct_requester".to_string(),
            actor: participants[0].clone(),
            participants,
            message: Some(CloudGroupMessage {
                id: "msg_request".to_string(),
                sender_account_id: "acct_requester".to_string(),
                text: "@ResearchAgentsKordi ask my Kordi".to_string(),
                created_at_ms: 1,
                sender_kind: Some("human".to_string()),
                sender_display_name: None,
                delivery_state: None,
                reply_to_message_id: None,
                request_id: None,
                message_action: None,
                target_cloud_agent_id: None,
                target_cloud_agent_name: None,
                target_cloud_agent_owner_account_id: None,
                target_cloud_agent_owner_name: None,
                agent_mention_depth: None,
            }),
        };
        let first = mention_instruction(&envelope, "acct_owner").expect("instruction");
        assert!(first.contains("\"my Kordi\" means @MayaChensKordi"));
        assert!(first.contains("Agents:"));
        assert!(!first.contains("@ResearchAgentsKordi ("));

        let message = envelope.message.as_mut().expect("message");
        message.sender_kind = Some("agent".to_string());
        message.agent_mention_depth = Some(1);
        let second = mention_instruction(&envelope, "acct_owner").expect("instruction");
        assert!(second.contains("do not ask another agent"));
        assert!(!second.contains("Agents:"));
    }
}
