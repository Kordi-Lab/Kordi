//! Which agent a comment mentions.
//!
//! The rules follow group mentions (`runs/group_mentions.rs`,
//! `runs/group_target.rs`): a handle is the agent's name, optionally followed
//! by its owner's name, compared after NFKC folding with everything but
//! letters and digits removed. A signed-in commenter reaches their own
//! default and named agents and other members' agents shared into the
//! document's session; a public reader reaches only the document owner's
//! default agent. A name that matches two agents, or two different agents in
//! one comment, is not a mention.

use std::collections::BTreeSet;

use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use unicode_normalization::UnicodeNormalization;

/// An agent the commenter may ask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentCandidate {
    pub agent_id: String,
    pub owner_account_id: String,
    pub owner_name: String,
    pub name: String,
    /// The owner's default agent (`cloud-agent:<owner>`).
    pub default_agent: bool,
    /// The commenter owns it, or is a public reader asking the document
    /// owner's agent; such a default agent also answers to `@agent`,
    /// `@Kordi`, and `@my Kordi`.
    pub own: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedAgent {
    pub agent_id: String,
    pub owner_account_id: String,
    pub name: String,
}

fn normalized(value: &str) -> String {
    value
        .nfkc()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The handles a candidate answers to, normalized.
fn handles(candidate: &AgentCandidate) -> BTreeSet<String> {
    let name = normalized(&candidate.name);
    let person = normalized(&candidate.owner_name);
    let mut handles = BTreeSet::new();
    if !name.is_empty() {
        handles.insert(name.clone());
        if !person.is_empty() {
            handles.insert(format!("{name}{person}"));
        }
    }
    if candidate.default_agent {
        if !person.is_empty() {
            handles.insert(format!("kordi{person}"));
            handles.insert(format!("{person}kordi"));
            handles.insert(format!("{person}skordi"));
        }
        if candidate.own {
            for handle in ["agent", "kordi", "mykordi"] {
                handles.insert(handle.to_string());
            }
        }
    }
    handles
}

fn is_separator(character: char) -> bool {
    matches!(character, ' ' | '\t' | '.' | '_' | '\'' | '\u{2019}' | '-')
}

/// How many bytes of `tail` (the text after an `@`) spell `handle`, when
/// they do and the handle ends at a word boundary. Names may contain spaces
/// and the separators group handles drop.
fn handle_length(tail: &str, handle: &str) -> Option<usize> {
    let mut built = String::new();
    for (index, character) in tail.char_indices() {
        if character.is_alphanumeric() {
            built.extend(
                character
                    .nfkc()
                    .filter(|folded| folded.is_alphanumeric())
                    .flat_map(char::to_lowercase),
            );
            if !handle.starts_with(&built) {
                return None;
            }
            if built == handle {
                let end = index + character.len_utf8();
                let boundary = tail[end..]
                    .chars()
                    .next()
                    .is_none_or(|next| !next.is_alphanumeric());
                return boundary.then_some(end);
            }
        } else if built.is_empty() || !is_separator(character) {
            return None;
        }
    }
    None
}

/// The one agent `body` mentions, or `None` when it mentions none, an
/// unknown name, an ambiguous name, or more than one agent.
pub(crate) fn resolve_mention(body: &str, candidates: &[AgentCandidate]) -> Option<ResolvedAgent> {
    let catalog: Vec<(&AgentCandidate, BTreeSet<String>)> = candidates
        .iter()
        .map(|candidate| (candidate, handles(candidate)))
        .collect();
    let mut found: Vec<&AgentCandidate> = Vec::new();
    for (index, _) in body.match_indices('@') {
        if index > 0 && !body[..index].ends_with(char::is_whitespace) {
            continue;
        }
        let tail = &body[index + 1..];
        let mut best = 0usize;
        let mut matched: Vec<&AgentCandidate> = Vec::new();
        for (candidate, handles) in &catalog {
            let Some(length) = handles
                .iter()
                .filter_map(|handle| handle_length(tail, handle))
                .max()
            else {
                continue;
            };
            if length > best {
                best = length;
                matched.clear();
            }
            if length == best && !matched.iter().any(|m| m.agent_id == candidate.agent_id) {
                matched.push(candidate);
            }
        }
        match matched.as_slice() {
            [] => {}
            [one] => {
                if !found.iter().any(|agent| agent.agent_id == one.agent_id) {
                    found.push(one);
                }
            }
            // The same handle names two agents.
            _ => return None,
        }
    }
    match found.as_slice() {
        [agent] => Some(ResolvedAgent {
            agent_id: agent.agent_id.clone(),
            owner_account_id: agent.owner_account_id.clone(),
            name: agent.name.clone(),
        }),
        _ => None,
    }
}

async fn default_agent(
    pool: &PgPool,
    owner_account_id: &str,
) -> Result<Option<AgentCandidate>, sqlx_core::Error> {
    let row: Option<(Option<String>, Option<String>)> = query_as(
        "SELECT account.display_name, profile.display_name \
         FROM cloud_accounts account \
         LEFT JOIN cloud_default_agent_profiles profile \
           ON profile.owner_account_id = account.account_id \
         WHERE account.account_id = $1",
    )
    .bind(owner_account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(owner_name, agent_name)| AgentCandidate {
        agent_id: format!("cloud-agent:{owner_account_id}"),
        owner_account_id: owner_account_id.to_string(),
        owner_name: owner_name.unwrap_or_default(),
        name: agent_name
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Kordi".to_string()),
        default_agent: true,
        own: true,
    }))
}

/// The agents a signed-in commenter may ask: their own default and named
/// agents, and the named agents other active members of `session_id` share
/// with the conversations they take part in.
pub(crate) async fn candidates_for_account(
    pool: &PgPool,
    account_id: &str,
    session_id: &str,
) -> Result<Vec<AgentCandidate>, sqlx_core::Error> {
    let mut candidates: Vec<AgentCandidate> =
        default_agent(pool, account_id).await?.into_iter().collect();
    let rows: Vec<(String, String, Option<String>, String)> = query_as(
        "SELECT definition.agent_id, definition.owner_account_id, owner.display_name, \
                definition.name \
         FROM cloud_agent_definitions definition \
         JOIN cloud_accounts owner ON owner.account_id = definition.owner_account_id \
         WHERE definition.status = 'active' AND NOT definition.is_system_managed \
           AND (definition.owner_account_id = $1 \
             OR (definition.access_scope = 'participant_conversations' AND EXISTS ( \
                  SELECT 1 FROM cloud_chat_conversations conversation \
                  JOIN cloud_chat_conversation_members member \
                    ON member.conversation_id = conversation.conversation_id \
                  WHERE COALESCE(conversation.legacy_session_id, \
                                 conversation.conversation_id::text) = $2 \
                    AND member.account_id = definition.owner_account_id \
                    AND member.membership_state = 'active'))) \
         ORDER BY definition.agent_id",
    )
    .bind(account_id)
    .bind(session_id)
    .fetch_all(pool)
    .await?;
    let pip = crate::pip::service_account_id();
    candidates.extend(
        rows.into_iter()
            .filter(|(_, owner, _, _)| pip != Some(owner.as_str()))
            .map(|(agent_id, owner, owner_name, name)| AgentCandidate {
                agent_id,
                own: owner == account_id,
                owner_account_id: owner,
                owner_name: owner_name.unwrap_or_default(),
                name,
                default_agent: false,
            }),
    );
    Ok(candidates)
}

/// A public reader only reaches the document owner's default agent.
pub(crate) async fn candidates_for_reader(
    pool: &PgPool,
    owner_account_id: &str,
) -> Result<Vec<AgentCandidate>, sqlx_core::Error> {
    Ok(default_agent(pool, owner_account_id)
        .await?
        .into_iter()
        .collect())
}
