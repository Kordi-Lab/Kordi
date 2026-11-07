//! Reply text for a failed Cloud run.

use super::super::envelopes::{
    cloud_agent_failure_code, cloud_agent_shared_failure_text,
    encode_cloud_agent_response_body_with_state, with_failure_code,
};

const SUPPORT_FAILURE_TEXT: &str =
    "Kordi Support couldn’t complete this request. Please try again shortly.";

/// The line the agent's owner reads. It never says "sign in": that means
/// signing in to Kordi, not reconnecting an AI provider.
pub(super) fn cloud_agent_failure_response_text(
    error_code: &str,
    is_support_agent: bool,
) -> &'static str {
    if is_support_agent {
        return SUPPORT_FAILURE_TEXT;
    }
    match error_code {
        "missing_provider_auth" => "No provider configured yet.",
        // Clients match the code to offer Reconnect to the agent's owner.
        "provider_auth_rejected" => "Your AI provider connection expired.",
        "model_provider_error" => {
            "Cloud fallback could not complete this request because the configured provider/model failed."
        }
        "sandbox_error" => {
            "Cloud fallback could not complete this request because the sandbox failed."
        }
        _ => "Cloud fallback could not complete this request.",
    }
}

/// A failed reply. A reply someone other than the owner receives (`shared`)
/// carries only the neutral line; the code lets the owner's devices show why.
pub(super) fn encode_failed_cloud_agent_response_body(
    request_message_id: &str,
    error_code: &str,
    is_support_agent: bool,
    shared: bool,
) -> String {
    let text = if shared && !is_support_agent {
        cloud_agent_shared_failure_text(None)
    } else {
        cloud_agent_failure_response_text(error_code, is_support_agent).to_string()
    };
    with_failure_code(
        &encode_cloud_agent_response_body_with_state(request_message_id, &text, "failed"),
        cloud_agent_failure_code(error_code),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    fn reply(body: &str) -> serde_json::Value {
        let encoded = body.strip_prefix("kordi-cloud-agent-response:").unwrap();
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).unwrap()).unwrap()
    }

    #[test]
    fn support_failures_never_describe_local_fallback_or_user_provider_setup() {
        for code in [
            "model_provider_error",
            "sandbox_error",
            "provider_auth_rejected",
            "missing_provider_auth",
            "unknown",
        ] {
            assert_eq!(
                cloud_agent_failure_response_text(code, true),
                SUPPORT_FAILURE_TEXT
            );
        }
        assert_eq!(
            cloud_agent_failure_response_text("missing_provider_auth", false),
            "No provider configured yet."
        );
    }

    #[test]
    fn no_owner_line_asks_to_sign_in() {
        for code in [
            "missing_provider_auth",
            "provider_auth_rejected",
            "model_provider_error",
            "sandbox_error",
            "unknown",
        ] {
            let text = cloud_agent_failure_response_text(code, false).to_lowercase();
            assert!(!text.contains("sign in"), "{code}: {text}");
        }
    }

    #[test]
    fn a_shared_failed_reply_carries_the_code_and_no_provider_detail() {
        let shared = reply(&encode_failed_cloud_agent_response_body(
            "msg_request",
            "provider_auth_rejected",
            false,
            true,
        ));
        assert_eq!(shared["text"], "The agent couldn't reply.");
        assert_eq!(shared["failureCode"], "provider_auth_rejected");
        assert_eq!(shared["deliveryState"], "failed");
        assert_eq!(shared["requestId"], "msg_request");
        let text = shared["text"].as_str().unwrap().to_lowercase();
        assert!(!text.contains("provider") && !text.contains("sign in"));

        let own = reply(&encode_failed_cloud_agent_response_body(
            "msg_request",
            "provider_auth_rejected",
            false,
            false,
        ));
        assert_eq!(own["text"], "Your AI provider connection expired.");
        assert_eq!(own["failureCode"], "provider_auth_rejected");

        let unknown = reply(&encode_failed_cloud_agent_response_body(
            "msg_request",
            "runner_crashed",
            false,
            true,
        ));
        assert_eq!(unknown["failureCode"], "failed");
    }
}
