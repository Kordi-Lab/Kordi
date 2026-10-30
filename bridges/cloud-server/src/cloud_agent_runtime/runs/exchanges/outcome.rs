//! Internal completion outcomes. These are never conversation speech.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

pub(crate) const WAITING: &str = r#"{"agentExchangeOutcome":"waiting"}"#;

pub(super) fn outcome(text: &str) -> Option<&'static str> {
    let value: Value = serde_json::from_str(text.trim()).ok()?;
    if value.as_object()?.len() != 1 {
        return None;
    }
    match value["agentExchangeOutcome"].as_str()? {
        "silent" => Some("silent"),
        "waiting" => Some("waiting"),
        _ => None,
    }
}

/// Notifications and unread accounting must not expose protocol completions.
pub(crate) fn is_control_response(value: &Value) -> bool {
    value["deliveryState"] == "complete"
        && (value["text"].as_str().and_then(outcome).is_some()
            || value["synchronizationOnly"] == true
            || value["structuredContent"]["synchronizationOnly"] == true)
}

fn control_prefix(text: &str) -> bool {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    !compact.is_empty()
        && [WAITING, r#"{"agentExchangeOutcome":"silent"}"#]
            .iter()
            .any(|value| value.starts_with(&compact))
}

pub(crate) fn is_control_progress(value: &Value) -> bool {
    value["deliveryState"] == "processing"
        && value["text"]
            .as_str()
            .is_some_and(|text| outcome(text).is_some() || control_prefix(text))
}

/// Persist completion as synchronization metadata, never as assistant speech.
/// The terminal event still retires progress and supports replay on every client.
pub(crate) fn separate_control_outcome(reply: &mut Value, group: bool) {
    let streaming = reply["deliveryState"] == "processing";
    if reply["deliveryState"] != "complete" && !streaming {
        return;
    }
    let text = reply["text"].as_str().unwrap_or_default();
    let control = outcome(text);
    let partial = streaming && control_prefix(text);
    if control.is_none() && !partial {
        return;
    }
    reply["text"] = json!("");
    if group {
        if !reply["structuredContent"].is_object() {
            reply["structuredContent"] = json!({});
        }
        reply["structuredContent"]["synchronizationOnly"] = json!(true);
        if let Some(control) = control {
            reply["structuredContent"]["agentExchangeOutcome"] = json!(control);
        }
    } else {
        reply["synchronizationOnly"] = json!(true);
        if let Some(control) = control {
            reply["agentExchangeOutcome"] = json!(control);
        }
    }
}

/// Once a request is public, the initial run yields to its durable continuation.
/// The continuation decides whether any further user-facing work is necessary.
pub(crate) async fn parent_completion(pool: &PgPool, run: &str, text: &str) -> RunResult<String> {
    let (delegated,): (bool,) =
        query_as("SELECT EXISTS(SELECT 1 FROM cloud_agent_exchanges WHERE parent_run_id=$1)")
            .bind(run)
            .fetch_one(pool)
            .await?;
    if delegated {
        return Ok(WAITING.into());
    }
    if outcome(text).is_some() {
        return Err(RunError::NotFound);
    }
    Ok(text.into())
}

/// Preserve the desktop envelope and its routing while normalizing the parent result.
pub(crate) async fn parent_completion_body(
    pool: &PgPool,
    run: &str,
    mut wire: Value,
    group: bool,
) -> RunResult<String> {
    let reply = if group {
        &mut wire["message"]
    } else {
        &mut wire
    };
    reply["text"] =
        json!(parent_completion(pool, run, reply["text"].as_str().unwrap_or_default()).await?);
    Ok(control_safe_body(wire, group))
}

pub(crate) fn control_safe_body(mut wire: Value, group: bool) -> String {
    separate_control_outcome(
        if group {
            &mut wire["message"]
        } else {
            &mut wire
        },
        group,
    );
    format!(
        "{}:{}",
        if group {
            "kordi-cloud-group"
        } else {
            "kordi-cloud-agent-response"
        },
        URL_SAFE_NO_PAD.encode(wire.to_string())
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn streamed_control_prefixes_never_become_message_text() {
        for group in [false, true] {
            for full in [WAITING, r#"{"agentExchangeOutcome":"silent"}"#] {
                for end in 1..=full.len() {
                    let mut reply = json!({"text":&full[..end],"deliveryState":"processing"});
                    separate_control_outcome(&mut reply, group);
                    assert_eq!(reply["text"], "");
                    let metadata = if group {
                        &reply["structuredContent"]
                    } else {
                        &reply
                    };
                    assert_eq!(metadata["synchronizationOnly"], true);
                }
            }
            for text in ["", r#"{"answer":19}"#, "A useful result"] {
                let mut reply = json!({"text":text,"deliveryState":"processing"});
                separate_control_outcome(&mut reply, group);
                assert_eq!(reply["text"], text);
            }
        }
    }
    #[test]
    fn synchronization_metadata_has_no_assistant_text() {
        for group in [false, true] {
            let mut reply =
                json!({"text":WAITING,"deliveryState":"complete","requestId":"request"});
            separate_control_outcome(&mut reply, group);
            assert_eq!(reply["text"], "");
            assert_eq!(reply["requestId"], "request");
            assert!(is_control_response(&reply));
            let metadata = if group {
                &reply["structuredContent"]
            } else {
                &reply
            };
            assert_eq!(metadata["agentExchangeOutcome"], "waiting");
            assert_eq!(metadata["synchronizationOnly"], true);
            let stored = reply.clone();
            separate_control_outcome(&mut reply, group);
            assert_eq!(reply, stored);
            let mut failure = json!({"text":"Provider failed","deliveryState":"failed"});
            separate_control_outcome(&mut failure, group);
            assert_eq!(failure["text"], "Provider failed");
            assert!(!is_control_response(&failure));
        }
    }
    #[test]
    fn only_an_exact_structured_outcome_is_control() {
        assert_eq!(outcome(WAITING), Some("waiting"));
        assert_eq!(
            outcome(r#"{ "agentExchangeOutcome": "silent" }"#),
            Some("silent")
        );
        for text in [
            "",
            "silent",
            "I am waiting",
            r#"{"agentExchangeOutcome":"silent","text":"Useful work"}"#,
            r#"Quoted {"agentExchangeOutcome":"silent"}"#,
        ] {
            assert_eq!(outcome(text), None);
        }
    }
}
