//! Internal completion outcomes. These are never conversation speech.
use super::*;

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
    value["deliveryState"] == "complete" && value["text"].as_str().and_then(outcome).is_some()
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
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
    let reply = if group {
        &mut wire["message"]
    } else {
        &mut wire
    };
    reply["text"] =
        json!(parent_completion(pool, run, reply["text"].as_str().unwrap_or_default()).await?);
    Ok(format!(
        "{}:{}",
        if group {
            "kordi-cloud-group"
        } else {
            "kordi-cloud-agent-response"
        },
        URL_SAFE_NO_PAD.encode(wire.to_string())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
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
