use serde_json::Value;

pub(super) fn status(message: &kordi_cli::desktop_runtime::DesktopChatMessage) -> &'static str {
    if message.cancelled {
        "cancelled"
    } else if message.failed {
        "failed"
    } else {
        "complete"
    }
}

pub(super) fn apply_terminal_content(
    content: &mut Value,
    message: &kordi_cli::desktop_runtime::DesktopChatMessage,
) {
    if message.cancelled {
        content["deliveryState"] = Value::String("cancelled".to_string());
    } else if message.failed {
        content["deliveryState"] = Value::String("failed".to_string());
        let error = if message.text.trim().is_empty() {
            message.detail.as_deref().unwrap_or_default().trim()
        } else {
            message.text.trim()
        };
        if !error.is_empty() {
            content["error"] = Value::String(error.to_string());
        }
    }
}
