//! Which conversation messages an agent run may use.
//!
//! Every server path that hands conversation history to an agent (the cloud
//! prompt, desktop server context, run-bound retrieval) asks the same policy.
//! In a group that shares messages only with the agents they are sent to, a
//! run sees its request, the one message that request replies to or quotes,
//! the requester's earlier requests to the same agent and that agent's replies.
//! Members who turned on "Don't let AI use my messages" are left out of other
//! people's agent context everywhere.

use std::collections::{HashMap, HashSet};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::Value;

mod load;
pub(crate) use load::needs_filtered_context;

/// The reserved message kind for AI access notices. A notice is never context.
pub(crate) const AI_ACCESS_NOTICE_KIND: &str = "ai-access-notice";
const WINDOW_ROWS: i64 = 512;
const REQUEST_ID_ROWS: i64 = 512;

const MENTIONS_GUIDANCE: &str = "Conversation access: this group shares messages with agents only when they are sent to them. You can see this request, the message it replies to or quotes, earlier requests this person sent you here, and your replies to them. search_sessions and read_session return only those. Do not guess what else was said. If you need more context, ask the person to reply to or quote the message they mean, or tell them a group owner or admin can let agents read recent messages in AI access settings.";
const HANDOFF_GUIDANCE: &str = "Conversation access: another agent handed this request to you. You can see only the handoff message and the message it replies to.";
const SCHEDULED_GUIDANCE: &str = "Conversation access: this is a scheduled task in a group that shares messages with agents only when they are sent to them. You can see only earlier requests this person sent you here and your replies.";
const EXCLUSION_GUIDANCE: &str = "Some members don't allow other people's AI to use their messages. Their messages are left out. Do not guess or reconstruct what they said.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HistoryScope {
    Mentions,
    Recent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Admission {
    Admit,
    Excluded,
    OutOfScope,
}

/// One stored message as a policy input. `body` is the first text block as
/// agents read it (`voice::body_for_agent`).
pub(crate) struct PolicyRow<'a> {
    pub(crate) wire_id: &'a str,
    pub(crate) client_id: Option<&'a str>,
    pub(crate) sender: &'a str,
    pub(crate) kind: &'a str,
    pub(crate) body: &'a str,
}

/// An owned window row: wire id, client id, sender, kind, body.
pub(super) type WindowRow = (String, String, String, String, String);

pub(crate) struct ContextPolicy {
    pub(crate) scope: HistoryScope,
    /// Opt-outs minus the requester and the owner.
    pub(crate) excluded: HashSet<String>,
    requester: String,
    owner: String,
    agent_aliases: HashSet<String>,
    /// The requester's earlier requests to this agent (logical and wire ids).
    request_ids: HashSet<String>,
    q_wire: Option<String>,
    q_logical: Option<String>,
    q_is_agent: bool,
    scheduled: bool,
    target_wire: Option<String>,
    /// Id form to its sender in the window, `None` when two senders share it.
    senders_by_id: HashMap<String, Option<String>>,
}

/// What `for_run` needs besides the database.
pub(super) struct RunPolicyInput<'a> {
    pub(super) scope: HistoryScope,
    pub(super) excluded: HashSet<String>,
    pub(super) owner: &'a str,
    pub(super) requester: &'a str,
    pub(super) agent_id: &'a str,
    pub(super) scheduled: bool,
    pub(super) request_ids: HashSet<String>,
    /// The current request: wire id, logical id, and first text block.
    pub(super) request: Option<(String, String, String)>,
}

fn payload(body: &str) -> Option<Value> {
    let (prefix, encoded) = body.trim().split_once(':')?;
    if !matches!(
        prefix,
        "kordi-cloud-group" | "kordi-cloud-message" | "kordi-cloud-agent-response"
    ) {
        return None;
    }
    let value: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).ok()?).ok()?;
    if prefix == "kordi-cloud-group" {
        value.get("message").cloned()
    } else {
        Some(value)
    }
}

fn text_field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a str> {
    value?
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Whether a stored row is an agent's message: a group envelope that marks
/// the stored sender itself as an agent, or an agent response body.
pub(crate) fn is_agent_authored(sender: &str, body: &str) -> bool {
    if body.trim_start().starts_with("kordi-cloud-agent-response:") {
        return true;
    }
    body.trim_start().starts_with("kordi-cloud-group:")
        && payload(body).is_some_and(|message| {
            text_field(Some(&message), "senderKind") == Some("agent")
                && text_field(Some(&message), "senderAccountId") == Some(sender)
        })
}

fn id_forms(wire: &str, client: Option<&str>, body: &str) -> Vec<String> {
    let mut forms = vec![wire.to_string()];
    if let Some(client) = client.filter(|client| !client.is_empty()) {
        forms.push(client.to_string());
        forms.push(format!("ios_{client}"));
    }
    if let Some(id) = text_field(payload(body).as_ref(), "id") {
        forms.push(id.to_string());
    }
    forms
}

fn default_agent_aliases(owner: &str) -> [String; 3] {
    [
        format!("cloud-agent:{owner}"),
        "cloud-local-agent".to_string(),
        format!("cloud-self:{owner}"),
    ]
}

/// Q's one reply, quote, or thread target. The target's own references are
/// never followed.
fn request_target(body: &str) -> Option<String> {
    let message = payload(body)?;
    if let Some(reply) = text_field(Some(&message), "replyToMessageId") {
        return Some(reply.to_string());
    }
    let action = message.get("messageAction")?;
    if !matches!(text_field(Some(action), "kind"), Some("quote" | "thread")) {
        return None;
    }
    text_field(action.get("source"), "sourceMessageId").map(str::to_string)
}

impl ContextPolicy {
    /// Builds a policy from loaded inputs and the window, oldest row first.
    pub(super) fn build(input: RunPolicyInput<'_>, window: &[WindowRow]) -> Self {
        let mut senders_by_id: HashMap<String, Option<String>> = HashMap::new();
        let mut oldest_wire: HashMap<String, String> = HashMap::new();
        for (wire, client, sender, _, body) in window {
            for form in id_forms(wire, Some(client), body) {
                oldest_wire
                    .entry(form.clone())
                    .or_insert_with(|| wire.clone());
                senders_by_id
                    .entry(form)
                    .and_modify(|known| {
                        if known.as_deref() != Some(sender.as_str()) {
                            *known = None;
                        }
                    })
                    .or_insert_with(|| Some(sender.clone()));
            }
        }
        let (q_wire, q_logical, q_body) = match input.request {
            Some((wire, logical, body)) => (Some(wire), Some(logical), Some(body)),
            None => (None, None, None),
        };
        let q_is_agent = q_body
            .as_deref()
            .is_some_and(|body| is_agent_authored(input.requester, body));
        let target_wire = q_body
            .as_deref()
            .and_then(request_target)
            .filter(|target| senders_by_id.get(target).is_some_and(Option::is_some))
            .and_then(|target| oldest_wire.get(&target).cloned());
        let mut agent_aliases = HashSet::from([input.agent_id.to_string()]);
        if default_agent_aliases(input.owner).contains(&input.agent_id.to_string()) {
            agent_aliases.extend(default_agent_aliases(input.owner));
        }
        Self {
            scope: input.scope,
            excluded: input.excluded,
            requester: input.requester.to_string(),
            owner: input.owner.to_string(),
            agent_aliases,
            request_ids: if q_is_agent {
                HashSet::new()
            } else {
                input.request_ids
            },
            q_wire,
            q_logical,
            q_is_agent,
            scheduled: input.scheduled,
            target_wire,
            senders_by_id,
        }
    }

    /// Whether this policy can leave rows out, so readers should scan more.
    pub(crate) fn filters(&self) -> bool {
        self.scope == HistoryScope::Mentions || !self.excluded.is_empty()
    }

    pub(crate) fn admit(&self, row: &PolicyRow<'_>) -> Admission {
        if row.kind == AI_ACCESS_NOTICE_KIND {
            return Admission::OutOfScope;
        }
        let agent_authored = is_agent_authored(row.sender, row.body);
        if self.excluded.contains(row.sender) && !agent_authored {
            return Admission::Excluded;
        }
        if self.scope == HistoryScope::Recent
            || self.q_wire.as_deref() == Some(row.wire_id)
            || self.target_wire.as_deref() == Some(row.wire_id)
        {
            return Admission::Admit;
        }
        if self.q_is_agent {
            return Admission::OutOfScope;
        }
        if row.sender == self.requester
            && id_forms(row.wire_id, row.client_id, row.body)
                .iter()
                .any(|form| self.request_ids.contains(form))
        {
            return Admission::Admit;
        }
        if row.sender == self.owner && agent_authored && self.is_reply_to_requester(row) {
            return Admission::Admit;
        }
        Admission::OutOfScope
    }

    /// An agent row stored by the owner, written by this run's agent, that
    /// answers one of the requester's requests.
    fn is_reply_to_requester(&self, row: &PolicyRow<'_>) -> bool {
        let Some(message) = payload(row.body) else {
            return false;
        };
        let agent = if row.body.trim_start().starts_with("kordi-cloud-group:") {
            text_field(Some(&message), "senderAgentId")
                .map(str::to_string)
                .unwrap_or_else(|| format!("cloud-agent:{}", row.sender))
        } else {
            format!("cloud-agent:{}", row.sender)
        };
        if !self.agent_aliases.contains(&agent) {
            return false;
        }
        ["requestId", "replyToMessageId"]
            .iter()
            .filter_map(|key| text_field(Some(&message), key))
            .any(|id| {
                self.request_ids.contains(id)
                    || self.q_logical.as_deref() == Some(id)
                    || self.q_wire.as_deref() == Some(id)
            })
    }

    /// Whether a quote preview of `source_message_id` may reach the agent.
    pub(crate) fn preview_allowed(&self, source_message_id: &str) -> bool {
        if self.excluded.is_empty() {
            return true;
        }
        match self.senders_by_id.get(source_message_id.trim()) {
            Some(Some(sender)) => !self.excluded.contains(sender),
            _ => false,
        }
    }

    /// Model-facing guidance for this run's conversation access, if any.
    pub(crate) fn guidance(&self) -> Option<String> {
        let mut parts = Vec::new();
        if self.scope == HistoryScope::Mentions {
            parts.push(if self.q_is_agent {
                HANDOFF_GUIDANCE
            } else if self.scheduled {
                SCHEDULED_GUIDANCE
            } else {
                MENTIONS_GUIDANCE
            });
        }
        if !self.excluded.is_empty() {
            parts.push(EXCLUSION_GUIDANCE);
        }
        (!parts.is_empty()).then(|| parts.join(" "))
    }
}

/// The requester and the owner may always use their own messages.
fn without_exempt(opt_outs: impl Iterator<Item = String>, exempt: &[&str]) -> HashSet<String> {
    opt_outs
        .filter(|account| !exempt.contains(&account.as_str()))
        .collect()
}

#[cfg(test)]
#[path = "context_policy_tests.rs"]
mod tests;
