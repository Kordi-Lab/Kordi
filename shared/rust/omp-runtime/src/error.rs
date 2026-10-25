use std::fmt;

/// Public wording comes from a fixed classification, and `Display` is only
/// that wording: servers classify it and other people may see it. A provider
/// failure also carries the provider's own reason, already cleaned by
/// `provider_reason`, which `with_provider_reason` adds for the account owner.
/// Logs use only `diagnostic_code`.
#[derive(Debug, PartialEq, Eq)]
pub enum RuntimeError {
    InvalidRequest,
    Spawn,
    Protocol(ProtocolViolation),
    OutputLimit,
    Timeout,
    Cancelled,
    UnexpectedExit,
    Callback,
    Worker(String),
    /// A provider failure with its cleaned reason.
    Provider {
        code: String,
        reason: String,
    },
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidRequest => {
                "The agent request is invalid. Try again or choose another model."
            }
            Self::Spawn => "The agent could not start. Restart Kordi and try again.",
            Self::Protocol(_) => "The agent returned an invalid response. Try again.",
            Self::OutputLimit => "The agent response exceeded its size limit.",
            Self::Timeout => "The agent timed out. Try again.",
            Self::Cancelled => "The agent request was cancelled.",
            Self::UnexpectedExit => "The agent stopped before completing this request. Try again.",
            Self::Callback => "A tool or extension could not complete this request. Try again.",
            Self::Worker(code) | Self::Provider { code, .. } => worker_message(code),
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for RuntimeError {}

impl RuntimeError {
    /// The fixed wording plus the provider's cleaned reason, for the person
    /// whose account ran the request.
    pub fn with_provider_reason(&self) -> String {
        match self {
            Self::Provider { reason, .. } => format!("{self} Provider response: {reason}"),
            _ => self.to_string(),
        }
    }

    /// A worker error frame: an unexpected code becomes `worker_error`, and
    /// only a provider failure keeps the provider's cleaned reason.
    pub(crate) fn from_worker_frame(code: String, raw_reason: Option<&str>) -> Self {
        let code = if code.len() <= 64
            && code
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            code
        } else {
            "worker_error".to_string()
        };
        let reason = code
            .starts_with("provider_")
            .then(|| raw_reason.and_then(crate::provider_reason))
            .flatten();
        match reason {
            Some(reason) => Self::Provider { code, reason },
            None => Self::Worker(code),
        }
    }

    /// A fixed, non-sensitive classification for logs. It never contains
    /// message content, tool data, or provider response text.
    pub fn diagnostic_code(&self) -> &str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::Spawn => "spawn",
            Self::Protocol(violation) => violation.code(),
            Self::OutputLimit => "output_limit",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
            Self::UnexpectedExit => "unexpected_exit",
            Self::Callback => "callback",
            // Worker codes are already restricted to `[A-Za-z0-9_]{1,64}`.
            Self::Worker(code) | Self::Provider { code, .. } => code,
        }
    }
}

/// Which supervisor check rejected a worker frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolViolation {
    /// A worker line is not a well-formed protocol frame.
    MalformedFrame,
    /// The worker closed stdout in the middle of a line.
    TruncatedFrame,
    /// A frame arrived before `ready`, or `ready` arrived twice.
    Handshake,
    SchemaVersion,
    /// A frame names a different run or attempt.
    RunMismatch,
    /// Frame sequence numbers are not contiguous from 1.
    Sequence,
    /// A tool or hook call ID is empty or reused.
    CallId,
    UnknownTool,
    UnknownHook,
    /// The result arrived while host tools or hooks were still pending.
    PendingCallbacks,
    /// A host message could not be encoded.
    Encoding,
}

impl ProtocolViolation {
    pub fn code(self) -> &'static str {
        match self {
            Self::MalformedFrame => "protocol_malformed_frame",
            Self::TruncatedFrame => "protocol_truncated_frame",
            Self::Handshake => "protocol_handshake",
            Self::SchemaVersion => "protocol_schema_version",
            Self::RunMismatch => "protocol_run_mismatch",
            Self::Sequence => "protocol_sequence",
            Self::CallId => "protocol_call_id",
            Self::UnknownTool => "protocol_unknown_tool",
            Self::UnknownHook => "protocol_unknown_hook",
            Self::PendingCallbacks => "protocol_pending_callbacks",
            Self::Encoding => "protocol_encoding",
        }
    }
}

fn worker_message(code: &str) -> &'static str {
    if code
        .strip_prefix("provider_http_")
        .and_then(|status| status.parse::<u16>().ok())
        .is_some_and(|status| (500..=599).contains(&status))
    {
        return "The provider is temporarily unavailable. Try again shortly.";
    }
    match code {
        "provider_http_401" | "provider_account_identity" => {
            "The provider sign-in needs attention. Reconnect this account in Authentication and try again."
        }
        "provider_http_403" => {
            "This account cannot use the selected model. Check its access or choose another model."
        }
        "provider_http_400" => {
            "The provider rejected this request. Check the selected model and settings, then try again."
        }
        "provider_http_429" => "The provider is busy or rate-limited. Try again shortly.",
        "provider_http_5xx" => "The provider is temporarily unavailable. Try again shortly.",
        "provider_model_unavailable" => {
            "The selected model is unavailable for this account. Choose another model."
        }
        "provider_tool_schema" => {
            "The provider rejected a tool definition. Update Kordi or try another model."
        }
        "provider_unsupported_parameter" => {
            "The selected model does not support a request setting. Adjust the model settings and try again."
        }
        "provider_tls" => {
            "A secure connection to the provider could not be established. Check your network and try again."
        }
        "provider_connection" => {
            "Could not connect to the provider. Check your network and try again."
        }
        "step_limit" | "tool_limit" => {
            "The agent reached its run limit before finishing. Try again."
        }
        "timeout" => "The agent timed out. Try again.",
        "cancelled" => "The agent request was cancelled.",
        "invalid_request" => "The agent request is invalid. Try again or choose another model.",
        "model_unavailable" => {
            "The selected model is unavailable for this account. Choose another model."
        }
        "output_limit" => "The agent response exceeded its size limit.",
        "input_limit" => {
            "This conversation is too large for the agent. Start a new chat and try again."
        }
        "hook_error" => "An extension could not complete this request. Try again.",
        code if code.starts_with("provider_") => {
            "The provider could not complete this request. Try again."
        }
        // Worker failures that are not the provider's must not blame it.
        _ => "The agent could not complete this request. Try again.",
    }
}

#[cfg(test)]
mod tests {
    use super::RuntimeError;

    #[test]
    fn known_codes_have_safe_actionable_messages() {
        assert!(
            RuntimeError::Worker("provider_http_401".into())
                .to_string()
                .contains("Reconnect")
        );
        assert!(
            RuntimeError::Worker("provider_http_429".into())
                .to_string()
                .contains("Try again shortly")
        );
        assert!(
            RuntimeError::Worker("provider_http_503".into())
                .to_string()
                .contains("temporarily unavailable")
        );
        assert!(
            RuntimeError::Worker("provider_model_unavailable".into())
                .to_string()
                .contains("Choose another model")
        );
    }

    #[test]
    fn unknown_worker_code_is_not_shown_to_the_user() {
        let message = RuntimeError::Worker("unexpected_secret_like_code".into()).to_string();
        assert_eq!(
            message,
            "The agent could not complete this request. Try again."
        );
        assert!(!message.contains("OMP"));
        assert_eq!(
            RuntimeError::Worker("provider_error".into()).to_string(),
            "The provider could not complete this request. Try again."
        );
    }

    #[test]
    fn non_provider_worker_codes_do_not_blame_the_provider() {
        for code in [
            "step_limit",
            "tool_limit",
            "runtime_error",
            "route_mismatch",
            "checkpoint_error",
            "hook_error",
            "input_limit",
            "duplicate_run",
            "worker_error",
        ] {
            let message = RuntimeError::Worker(code.into()).to_string();
            assert!(!message.contains("provider"), "{code}: {message}");
        }
    }
}
