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
    agent_id: Option<String>,
    display_name: String,
    owner_display_name: String,
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

fn default_agent_id(owner_account_id: &str) -> String {
    format!("cloud-agent:{}", owner_account_id.trim())
}

fn agent_handle(agent_name: &str, owner_name: &str) -> String {
    let scoped = format!("{agent_name} {owner_name}");
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
            agent_id: None,
            handle: person_handle(&display_name),
            display_name: display_name.clone(),
            owner_display_name: display_name.clone(),
            kind: MentionKind::Person,
        });
        candidates.push(MentionEntry {
            participant: participant.clone(),
            agent_id: Some(
                participant
                    .agent_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string)
                    .unwrap_or_else(|| default_agent_id(account_id)),
            ),
            handle: agent_handle(
                participant.agent_display_name.as_deref().unwrap_or("Kordi"),
                &display_name,
            ),
            display_name: participant
                .agent_display_name
                .as_deref()
                .map(clean_display_name)
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "Kordi".to_string()),
            owner_display_name: display_name,
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
    _responding_account_id: &str,
    responding_agent_id: &str,
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
                    && entry.agent_id.as_deref() != Some(responding_agent_id.trim())
            })
            .map(|entry| {
                format!(
                    "@{} ({}; owner: {})",
                    entry.handle, entry.display_name, entry.owner_display_name
                )
            })
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
                "Current requester: @{} ({}; owner: {}).",
                entry.handle, entry.display_name, entry.owner_display_name
            )
        })
    } else {
        requester_person.map(|entry| {
            let mut description = format!(
                "Current requester: @{} ({}).",
                entry.handle, entry.display_name
            );
            if let Some(agent) = requester_agent
                .filter(|agent| agent.agent_id.as_deref() != Some(responding_agent_id.trim()))
            {
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
            "To ask another participant's agent to act, include exactly one permitted agent handle followed by the request in your final response."
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

pub(super) fn persona_instruction(
    envelope: &CloudGroupEnvelope,
    responding_account_id: &str,
    responding_agent_id: &str,
) -> Option<String> {
    let message = envelope.message.as_ref()?;
    let allow_agent_mentions = message_mention_depth(message) < CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH;
    let requester_agent_id = default_agent_id(&message.sender_account_id);
    let requester_owns_agent = message.sender_account_id.trim() == responding_account_id.trim();
    let relationship = if message.sender_kind.as_deref() == Some("agent") {
        "This request came from another agent. Do not delegate to another agent.".to_string()
    } else if requester_agent_id == responding_agent_id.trim() {
        "The human requester owns you. In this request, \"my Kordi\" means you. Perform the request directly and never mention or delegate to your own public handle.".to_string()
    } else if requester_owns_agent {
        "The human requester owns you. In this request, \"my Kordi\" means the requester's default Kordi, not you.".to_string()
    } else {
        "The current human requester does not own you. In this request, \"my Kordi\" means the requester's default Kordi, not you.".to_string()
    };
    let delegation = if allow_agent_mentions {
        "You may delegate once only to a different agent through an exact handle supplied in the group mention directory."
    } else {
        "Do not delegate to another agent in this response."
    };
    let responding_name = message
        .target_cloud_agent_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Kordi");
    Some(format!(
        "You are {responding_name}, the currently responding agent in this Kordi group conversation.\n{relationship}\n{delegation}"
    ))
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

#[derive(Clone, Debug)]
pub(super) struct ResolvedAgentMention {
    pub(super) participant: CloudGroupParticipant,
    pub(super) agent_id: String,
    pub(super) display_name: String,
}

pub(super) fn resolve_agent_mention(
    text: &str,
    participants: &[CloudGroupParticipant],
    _responding_account_id: &str,
    responding_agent_id: &str,
) -> Option<ResolvedAgentMention> {
    let agents_by_handle = mention_catalog(participants)
        .into_iter()
        .filter(|entry| {
            entry.kind == MentionKind::Agent
                && entry.agent_id.as_deref() != Some(responding_agent_id.trim())
        })
        .filter_map(|entry| {
            Some((
                normalized_handle(&entry.handle),
                ResolvedAgentMention {
                    participant: entry.participant,
                    agent_id: entry.agent_id?,
                    display_name: entry.display_name,
                },
            ))
        })
        .collect::<HashMap<_, _>>();
    mention_tokens(text)
        .find_map(|mention| agents_by_handle.get(&normalized_handle(&mention)).cloned())
}

pub(super) fn agent_handoff_target(envelope: &CloudGroupEnvelope) -> Option<ResolvedAgentMention> {
    let message = envelope.message.as_ref()?;
    if message.sender_kind.as_deref() != Some("agent")
        || message_mention_depth(message) != CLOUD_GROUP_AGENT_MENTION_MAX_DEPTH
    {
        return None;
    }
    let target_owner_account_id = message
        .target_cloud_agent_owner_account_id
        .as_deref()?
        .trim();
    let responding_agent_id = message
        .sender_agent_id
        .clone()
        .unwrap_or_else(|| default_agent_id(&message.sender_account_id));
    let target = resolve_agent_mention(
        &message.text,
        &envelope.participants,
        &message.sender_account_id,
        &responding_agent_id,
    )?;
    let target_agent_id = message.target_cloud_agent_id.as_deref().map(str::trim);
    (target.participant.account_id.trim() == target_owner_account_id
        && target_agent_id.is_none_or(|value| value == target.agent_id))
    .then_some(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn participant(account_id: &str, display_name: &str) -> CloudGroupParticipant {
        CloudGroupParticipant {
            account_id: account_id.to_string(),
            display_name: display_name.to_string(),
            avatar_url: None,
            agent_id: None,
            agent_display_name: None,
            agent_avatar_url: None,
            role: Some("person".to_string()),
        }
    }

    #[test]
    fn resolves_unicode_nfkc_handle_and_rejects_self_or_ambiguity() {
        let participants = vec![
            participant("acct_source", "Ｒｅｓｅａｒｃｈ Ａｇｅｎｔ"),
            participant("acct_target", "Márta Ruiz"),
        ];
        assert_eq!(
            resolve_agent_mention(
                "@KordiMártaRuiz confirm",
                &participants,
                "acct_source",
                "cloud-agent:acct_source",
            )
            .map(|target| target.participant.account_id),
            Some("acct_target".to_string())
        );
        assert!(resolve_agent_mention(
            "@KordiResearchAgent self",
            &participants,
            "acct_source",
            "cloud-agent:acct_source",
        )
        .is_none());

        let ambiguous = vec![
            participant("acct_one", "Same Name"),
            participant("acct_two", "Same-Name"),
        ];
        assert!(resolve_agent_mention(
            "@KordiSameName hello",
            &ambiguous,
            "acct_source",
            "cloud-agent:acct_source",
        )
        .is_none());
    }

    #[test]
    fn resolves_owner_synced_default_agent_name() {
        let mut target = participant("acct_target", "Márta Ruiz");
        target.agent_id = Some("cloud-agent:acct_target".to_string());
        target.agent_display_name = Some("BabyTREE".to_string());
        let participants = vec![participant("acct_source", "Alex Morgan"), target];

        let resolved = resolve_agent_mention(
            "@BabyTREEMártaRuiz confirm",
            &participants,
            "acct_source",
            "cloud-agent:acct_source",
        )
        .expect("renamed default agent mention");
        assert_eq!(resolved.agent_id, "cloud-agent:acct_target");
        assert_eq!(resolved.display_name, "BabyTREE");
        assert_eq!(resolved.participant.display_name, "Márta Ruiz");
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
                sender_agent_id: None,
                sender_owner_account_id: None,
                sender_owner_name: None,
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
        let first = mention_instruction(&envelope, "acct_owner", "cloud-agent:acct_owner")
            .expect("instruction");
        assert!(first.contains("\"my Kordi\" means @KordiMayaChen"));
        assert!(first.contains("Agents:"));
        assert!(!first.contains("@KordiResearchAgent ("));

        let message = envelope.message.as_mut().expect("message");
        message.sender_account_id = "acct_owner".to_string();
        let self_directory = mention_instruction(&envelope, "acct_owner", "cloud-agent:acct_owner")
            .expect("self directory");
        assert!(!self_directory.contains("\"my Kordi\" means @"));
        assert!(!self_directory.contains("@KordiResearchAgent"));
        let self_persona = persona_instruction(&envelope, "acct_owner", "cloud-agent:acct_owner")
            .expect("self persona");
        assert!(self_persona.starts_with("You are Kordi, the currently responding agent"));
        assert!(self_persona.contains("\"my Kordi\" means you"));
        let custom_persona = persona_instruction(&envelope, "acct_owner", "cloud_agent_scout")
            .expect("custom persona");
        assert!(custom_persona.contains("requester owns you"));
        assert!(custom_persona.contains("requester's default Kordi, not you"));
        assert!(!custom_persona.contains("\"my Kordi\" means you"));

        let message = envelope.message.as_mut().expect("message");
        message.sender_account_id = "acct_requester".to_string();
        message.sender_kind = Some("agent".to_string());
        message.agent_mention_depth = Some(1);
        let second = mention_instruction(&envelope, "acct_owner", "cloud-agent:acct_owner")
            .expect("instruction");
        assert!(second.contains("do not ask another agent"));
        assert!(!second.contains("Agents:"));
    }
}
