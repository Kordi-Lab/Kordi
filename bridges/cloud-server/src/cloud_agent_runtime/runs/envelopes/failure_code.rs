//! The failure category a failed agent reply carries.
//!
//! Every member of a chat receives the same reply, so its text is a neutral
//! line. The stable `failureCode` lets the agent owner's devices show the
//! reason; other members' clients show only that the agent could not reply.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

use super::{CLOUD_AGENT_RESPONSE_PREFIX, CLOUD_GROUP_PREFIX};

/// The stable code a client renders for a run error code.
pub(in crate::cloud_agent_runtime::runs) fn cloud_agent_failure_code(
    error_code: &str,
) -> &'static str {
    match error_code {
        "missing_provider_auth" => "missing_provider_auth",
        "provider_auth_rejected" => "provider_auth_rejected",
        "model_provider_error" => "model_provider_error",
        "sandbox_error" => "sandbox_error",
        _ => "failed",
    }
}

/// The neutral line every member reads when the agent could not reply.
pub(in crate::cloud_agent_runtime::runs) fn cloud_agent_shared_failure_text(
    agent_name: Option<&str>,
) -> String {
    match agent_name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => format!("{name} couldn't reply."),
        None => "The agent couldn't reply.".to_string(),
    }
}

/// Adds `failureCode` to an agent reply or to the message of a group reply.
/// A body of any other shape is returned unchanged.
pub(in crate::cloud_agent_runtime::runs) fn with_failure_code(
    body: &str,
    failure_code: &str,
) -> String {
    let trimmed = body.trim();
    let (prefix, in_message) = if trimmed.starts_with(CLOUD_AGENT_RESPONSE_PREFIX) {
        (CLOUD_AGENT_RESPONSE_PREFIX, false)
    } else if trimmed.starts_with(CLOUD_GROUP_PREFIX) {
        (CLOUD_GROUP_PREFIX, true)
    } else {
        return body.to_string();
    };
    let Some(mut value) = URL_SAFE_NO_PAD
        .decode(&trimmed[prefix.len()..])
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    else {
        return body.to_string();
    };
    let target = if in_message {
        &mut value["message"]
    } else {
        &mut value
    };
    let Some(object) = target.as_object_mut() else {
        return body.to_string();
    };
    object.insert(
        "failureCode".to_string(),
        serde_json::Value::String(failure_code.to_string()),
    );
    format!("{prefix}{}", URL_SAFE_NO_PAD.encode(value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded(body: &str, prefix: &str) -> serde_json::Value {
        let bytes = URL_SAFE_NO_PAD.decode(&body[prefix.len()..]).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn unknown_run_errors_share_only_a_generic_code() {
        assert_eq!(
            cloud_agent_failure_code("provider_auth_rejected"),
            "provider_auth_rejected"
        );
        assert_eq!(
            cloud_agent_failure_code("missing_provider_auth"),
            "missing_provider_auth"
        );
        assert_eq!(cloud_agent_failure_code("runner_crashed"), "failed");
        assert_eq!(cloud_agent_failure_code(""), "failed");
    }

    #[test]
    fn the_shared_line_names_only_the_agent() {
        assert_eq!(
            cloud_agent_shared_failure_text(Some(" Pebble ")),
            "Pebble couldn't reply."
        );
        assert_eq!(
            cloud_agent_shared_failure_text(Some("  ")),
            "The agent couldn't reply."
        );
        assert_eq!(
            cloud_agent_shared_failure_text(None),
            "The agent couldn't reply."
        );
    }

    #[test]
    fn the_code_rides_an_agent_reply_and_a_group_message() {
        let reply = format!(
            "{CLOUD_AGENT_RESPONSE_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(r#"{"kind":"agent-response","requestId":"r1","text":"x"}"#)
        );
        let reply = with_failure_code(&reply, "provider_auth_rejected");
        assert_eq!(
            decoded(&reply, CLOUD_AGENT_RESPONSE_PREFIX)["failureCode"],
            "provider_auth_rejected"
        );

        let group = format!(
            "{CLOUD_GROUP_PREFIX}{}",
            URL_SAFE_NO_PAD.encode(r#"{"kind":"group-message","message":{"id":"m1","text":"x"}}"#)
        );
        let group = with_failure_code(&group, "failed");
        let value = decoded(&group, CLOUD_GROUP_PREFIX);
        assert_eq!(value["message"]["failureCode"], "failed");
        assert!(value.get("failureCode").is_none());

        assert_eq!(with_failure_code("plain text", "failed"), "plain text");
    }
}
