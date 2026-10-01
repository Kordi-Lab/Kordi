use std::fmt;

/// Public wording is deliberately independent of provider response bodies.
/// The fixed worker code remains available for diagnostics through the variant.
#[derive(Debug, PartialEq, Eq)]
pub enum RuntimeError {
    InvalidRequest,
    Spawn,
    Protocol,
    OutputLimit,
    Timeout,
    Cancelled,
    UnexpectedExit,
    Callback,
    Worker(String),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::InvalidRequest => {
                "The agent request is invalid. Try again or choose another model."
            }
            Self::Spawn => "The agent could not start. Restart Kordi and try again.",
            Self::Protocol => "The agent returned an invalid response. Try again.",
            Self::OutputLimit => "The agent response exceeded its size limit.",
            Self::Timeout => "The agent timed out. Try again.",
            Self::Cancelled => "The agent request was cancelled.",
            Self::UnexpectedExit => "The agent stopped before completing this request. Try again.",
            Self::Callback => "A tool or extension could not complete this request. Try again.",
            Self::Worker(code) => worker_message(code),
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for RuntimeError {}

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
        _ => "The provider could not complete this request. Try again.",
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
            "The provider could not complete this request. Try again."
        );
        assert!(!message.contains("OMP"));
    }
}
