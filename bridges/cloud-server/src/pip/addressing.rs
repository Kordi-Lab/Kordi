//! Whom a member's message is for. A member talking to an agent (their own
//! or anyone else's), or a message an agent already answered, is not PiP's
//! cue to speak: PiP still reads it as context, but only plain chat between
//! people can wake it.

use std::collections::{BTreeSet, HashSet};

use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::context;
use super::mentions::mention_handle;

fn normalized_handle(value: &str) -> String {
    mention_handle(value).to_lowercase()
}

fn non_empty(value: &Value) -> Option<&str> {
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// A field of a decoded cloud envelope: on the envelope itself for direct
/// messages, on its `message` for group messages.
fn envelope_field<'a>(envelope: &'a Value, name: &str) -> Option<&'a Value> {
    envelope
        .get(name)
        .filter(|value| !value.is_null())
        .or_else(|| {
            envelope
                .get("message")
                .and_then(|message| message.get(name))
        })
        .filter(|value| !value.is_null())
}

/// Whether a decoded envelope targets or mentions an agent other than PiP.
/// When a mention does not say what it points at, any handle that is not a
/// member's counts as an agent's.
pub(super) fn addresses_other_agent(
    envelope: &Value,
    pip_account_id: &str,
    member_handles: &BTreeSet<String>,
) -> bool {
    let is_pip = |value: &str| value.contains(pip_account_id);
    if envelope_field(envelope, "targetCloudAgentId")
        .and_then(non_empty)
        .is_some_and(|target| !is_pip(target))
    {
        return true;
    }
    envelope_field(envelope, "mentions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|mention| {
            let ids = ["targetIdentityId", "agentId", "humanId"]
                .map(|key| mention.get(key).and_then(non_empty));
            if ids.iter().flatten().any(|id| is_pip(id)) {
                return false;
            }
            match mention.get("targetKind").and_then(Value::as_str) {
                Some("agent") => true,
                Some(_) => false,
                None => {
                    ids[1].is_some()
                        || ids[0].is_some_and(|id| id.starts_with("agent:"))
                        || mention
                            .get("label")
                            .and_then(non_empty)
                            .map(normalized_handle)
                            .is_some_and(|handle| {
                                !handle.is_empty()
                                    && handle != "all"
                                    && !member_handles.contains(&handle)
                            })
                }
            }
        })
}

/// Member handles as `addresses_other_agent` compares them.
pub(super) fn member_handles<'a>(display_names: impl Iterator<Item = &'a str>) -> BTreeSet<String> {
    display_names.map(normalized_handle).collect()
}

/// Every id an agent run may name as the message it answers.
pub(super) fn request_ids(
    message_id: &str,
    client_message_id: Option<&str>,
    envelope: Option<&Value>,
) -> Vec<String> {
    let from_envelope = envelope
        .and_then(|envelope| envelope_field(envelope, "id"))
        .and_then(non_empty);
    [Some(message_id), client_message_id, from_envelope]
        .into_iter()
        .flatten()
        .map(str::to_string)
        .collect()
}

/// The ids among `ids` that an agent run (not PiP's own) answered or is
/// answering. Failed and cancelled runs did not answer.
pub(super) async fn answered_ids(
    pool: &PgPool,
    ids: &[String],
) -> Result<HashSet<String>, sqlx_core::Error> {
    if ids.is_empty() {
        return Ok(HashSet::new());
    }
    let rows: Vec<(String,)> = query_as(
        "SELECT DISTINCT request_message_id FROM cloud_agent_fallback_runs
         WHERE request_message_id = ANY($1) AND status NOT IN ('failed', 'cancelled')
           AND run_id NOT LIKE 'pip\\_%'",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Whether the new chat alone is worth a model call: members' new messages
/// that address no agent and that no agent answered, checked for plan words.
pub(super) fn new_chat_worth_a_look(input: &Value) -> bool {
    let new_texts: Vec<String> = input["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|message| message["isNew"] == json!(true) && message["fromPip"] != json!(true))
        .filter(|message| {
            message["addressesAgent"] != json!(true) && message["answeredByAgent"] != json!(true)
        })
        .filter_map(|message| message["text"].as_str().map(str::to_string))
        .collect();
    context::worth_a_look(&new_texts, !input["openCard"].is_null())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn handles() -> BTreeSet<String> {
        member_handles(["Riya Shah", "System", "Alex"].into_iter())
    }

    fn input(message: Value) -> Value {
        let mut message = message;
        message["isNew"] = json!(true);
        message["fromPip"] = json!(false);
        json!({"messages": [message], "openCard": null})
    }

    #[test]
    fn agent_targets_and_agent_mentions_address_an_agent() {
        let pip = "acct_kordi_pip";
        let group = |message: Value| json!({"kind": "group-message", "message": message});
        assert!(addresses_other_agent(
            &group(json!({"text": "check my memory", "targetCloudAgentId": "cloud-agent:acct_a"})),
            pip,
            &handles()
        ));
        assert!(addresses_other_agent(
            &json!({"kind": "message", "mentions": [{"label": "KordiAlex", "targetKind": "agent",
                "targetIdentityId": "agent:cloud-agent:acct_a"}]}),
            pip,
            &handles()
        ));
        // Old clients send only a label: a handle that is no member's is an agent's.
        assert!(addresses_other_agent(
            &group(json!({"mentions": [{"label": "@KordiMemTesterA"}]})),
            pip,
            &handles()
        ));
        assert!(!addresses_other_agent(
            &group(json!({"mentions": [{"label": "@RiyaShah"}]})),
            pip,
            &handles()
        ));
        assert!(!addresses_other_agent(
            &json!({"mentions": [{"label": "Riya", "targetKind": "person",
                "targetIdentityId": "human:acct_r"}]}),
            pip,
            &handles()
        ));
        // Talking to PiP itself is not talking to another agent.
        assert!(!addresses_other_agent(
            &json!({"targetCloudAgentId": "cloud-agent:acct_kordi_pip"}),
            pip,
            &handles()
        ));
        assert!(!addresses_other_agent(
            &group(json!({"text": "Dinner Friday at 7?"})),
            pip,
            &handles()
        ));
    }

    #[test]
    fn request_ids_cover_server_client_and_envelope_ids() {
        let envelope = json!({"message": {"id": "local-1"}});
        assert_eq!(
            request_ids("m1", Some("c1"), Some(&envelope)),
            vec!["m1", "c1", "local-1"]
        );
        assert_eq!(request_ids("m1", None, None), vec!["m1"]);
    }

    #[test]
    fn messages_for_an_agent_or_already_answered_do_not_wake_pip() {
        let plain = json!({"text": "Can we meet Friday at 7?"});
        assert!(new_chat_worth_a_look(&input(plain.clone())));
        let mut addressed = plain.clone();
        addressed["addressesAgent"] = json!(true);
        assert!(!new_chat_worth_a_look(&input(addressed)));
        let mut answered = plain;
        answered["answeredByAgent"] = json!(true);
        assert!(!new_chat_worth_a_look(&input(answered)));
    }

    #[test]
    fn the_prompt_keeps_pip_quiet_about_messages_for_other_agents() {
        assert!(super::super::prompt::PIP_SYSTEM_PROMPT
            .contains("stay quiet about it unless the card itself needs attention"));
    }
}
