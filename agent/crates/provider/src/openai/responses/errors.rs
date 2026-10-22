use serde_json::Value;

pub(super) fn responses_error_message(event: &Value) -> String {
    event
        .get("message")
        .and_then(|value| value.as_str())
        .or_else(|| {
            event
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(|value| value.as_str())
        })
        .or_else(|| {
            event
                .get("response")
                .and_then(|response| response.get("error"))
                .and_then(|error| error.get("message"))
                .and_then(|value| value.as_str())
        })
        .or_else(|| {
            event
                .get("response")
                .and_then(|response| response.get("incomplete_details"))
                .and_then(|details| details.get("reason"))
                .and_then(|value| value.as_str())
        })
        .map(ToString::to_string)
        .unwrap_or_else(|| "OpenAI response failed".to_string())
}

pub(super) fn responses_error_code(event: &Value) -> Option<&str> {
    event
        .get("error")
        .and_then(|error| error.get("code").or_else(|| error.get("type")))
        .and_then(|value| value.as_str())
        .or_else(|| {
            event
                .get("response")
                .and_then(|response| response.get("error"))
                .and_then(|error| error.get("code").or_else(|| error.get("type")))
                .and_then(|value| value.as_str())
        })
}
