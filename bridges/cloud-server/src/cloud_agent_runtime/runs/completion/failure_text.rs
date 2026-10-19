//! Reply text for a failed Cloud run.

use super::super::envelopes::encode_cloud_agent_response_body_with_state;

pub(super) fn cloud_agent_failure_response_text(
    error_code: &str,
    is_support_agent: bool,
) -> &'static str {
    if is_support_agent {
        return "Kordi Support couldn’t complete this request. Please try again shortly.";
    }
    match error_code {
        "missing_provider_auth" => "No provider configured yet.",
        // Desktop clients match this text to offer "Open authentication".
        "provider_auth_rejected" => "Sign in again to use this account.",
        "model_provider_error" => {
            "Cloud fallback could not complete this request because the configured provider/model failed."
        }
        "sandbox_error" => {
            "Cloud fallback could not complete this request because the sandbox failed."
        }
        _ => "Cloud fallback could not complete this request.",
    }
}

pub(super) fn encode_failed_cloud_agent_response_body(
    request_message_id: &str,
    error_code: &str,
    is_support_agent: bool,
) -> String {
    encode_cloud_agent_response_body_with_state(
        request_message_id,
        cloud_agent_failure_response_text(error_code, is_support_agent),
        "failed",
    )
}
