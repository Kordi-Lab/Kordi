use crate::bridge::DesktopBridgeOutreachMetadata;

fn set_string(target: &mut String, value: &str) -> bool {
    if target == value {
        false
    } else {
        *target = value.to_string();
        true
    }
}

fn set_option_string(target: &mut Option<String>, value: Option<String>) -> bool {
    if *target == value {
        false
    } else {
        *target = value;
        true
    }
}

fn set_option_i64(target: &mut Option<i64>, value: Option<i64>) -> bool {
    if *target == value {
        false
    } else {
        *target = value;
        true
    }
}

fn is_terminal_outreach_status(status: &str) -> bool {
    matches!(
        status.trim().to_lowercase().as_str(),
        "completed" | "complete" | "failed" | "cancelled" | "timeout"
    )
}

fn is_processing_placeholder_text(value: &str) -> bool {
    matches!(
        value.trim().to_lowercase().as_str(),
        "processing" | "processing." | "processing.." | "processing..." | "processing…"
    )
}

fn is_terminal_delivery_state(delivery_state: &str) -> bool {
    matches!(
        delivery_state.trim().to_lowercase().as_str(),
        "responded" | "processing_failed" | "cancelled"
    )
}

fn should_clear_placeholder_request_text(
    current_request_text: &str,
    delivery_state: &str,
    previous_text: Option<&str>,
) -> bool {
    if !is_terminal_delivery_state(delivery_state) {
        return false;
    }
    let current_request_text = current_request_text.trim();
    if current_request_text.is_empty() {
        return false;
    }
    if is_processing_placeholder_text(current_request_text) {
        return true;
    }
    previous_text
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some_and(|previous_text| {
            previous_text == current_request_text && is_processing_placeholder_text(previous_text)
        })
}

pub(in crate::bridge::storage) fn reconcile_message_outreach_metadata(
    outreach: &mut DesktopBridgeOutreachMetadata,
    delivery_state: Option<&str>,
    message_text: Option<&str>,
    previous_text: Option<&str>,
    timestamp_ms: i64,
) -> bool {
    let Some(delivery_state) = delivery_state
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let mut changed = false;

    changed |= set_option_string(
        &mut outreach.delivery_state,
        Some(delivery_state.to_string()),
    );

    if should_clear_placeholder_request_text(&outreach.request_text, delivery_state, previous_text)
    {
        changed |= set_string(&mut outreach.request_text, "");
    }

    match delivery_state.to_lowercase().as_str() {
        "responded" => {
            changed |= set_string(&mut outreach.status, "completed");
            changed |= set_option_i64(&mut outreach.completed_at_ms, Some(timestamp_ms));
            changed |= set_option_string(&mut outreach.error, None);
        }
        "processing_failed" => {
            changed |= set_string(&mut outreach.status, "failed");
            changed |= set_option_i64(&mut outreach.completed_at_ms, Some(timestamp_ms));
            if let Some(error_text) = message_text
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                changed |= set_option_string(&mut outreach.error, Some(error_text.to_string()));
            }
        }
        "cancelled" => {
            changed |= set_string(&mut outreach.status, "cancelled");
            changed |= set_option_i64(&mut outreach.completed_at_ms, Some(timestamp_ms));
            if outreach.error.is_none() {
                changed |=
                    set_option_string(&mut outreach.error, Some("Cancelled by user".to_string()));
            }
        }
        "processing" | "handed_off_direct" | "handed_off_mailbox" => {
            if !is_terminal_outreach_status(&outreach.status) {
                changed |= set_string(&mut outreach.status, "processing");
                changed |= set_option_i64(&mut outreach.completed_at_ms, None);
            }
        }
        _ => {}
    }

    if outreach.updated_at_ms != timestamp_ms {
        outreach.updated_at_ms = timestamp_ms;
        changed = true;
    }

    changed
}

pub(in crate::bridge::storage) fn reconcile_message_outreach_for_storage(
    outreach: &mut DesktopBridgeOutreachMetadata,
    conversation_id: &str,
    request_id: Option<&str>,
    delivery_state: Option<&str>,
    message_text: &str,
    previous_text: Option<&str>,
    timestamp_ms: i64,
) -> bool {
    let mut changed = false;
    if outreach.bridge_conversation_id.is_none() {
        outreach.bridge_conversation_id = Some(conversation_id.to_string());
        changed = true;
    }
    if outreach.bridge_request_id.is_none() {
        outreach.bridge_request_id = request_id.map(ToString::to_string);
        changed |= outreach.bridge_request_id.is_some();
    }
    let reconciled = reconcile_message_outreach_metadata(
        outreach,
        delivery_state,
        Some(message_text),
        previous_text,
        timestamp_ms,
    );
    changed || reconciled
}

pub(in crate::bridge::storage) fn reconcile_conversation_outreach_delivery_state(
    outreach: &mut DesktopBridgeOutreachMetadata,
    delivery_state: &str,
    message_text: Option<&str>,
    timestamp_ms: i64,
) -> bool {
    let delivery_state = delivery_state.trim();
    if delivery_state.is_empty() {
        return false;
    }

    let mut changed = set_option_string(
        &mut outreach.delivery_state,
        Some(delivery_state.to_string()),
    );
    let normalized = delivery_state.to_lowercase();

    match normalized.as_str() {
        "cancelled" => {
            changed |= set_string(&mut outreach.status, "cancelled");
            changed |= set_option_i64(&mut outreach.completed_at_ms, Some(timestamp_ms));
            changed |=
                set_option_string(&mut outreach.error, Some("Cancelled by user".to_string()));
        }
        "processing_failed" if outreach.status != "cancelled" => {
            changed |= set_string(&mut outreach.status, "failed");
            changed |= set_option_i64(&mut outreach.completed_at_ms, Some(timestamp_ms));
            if let Some(error_text) = message_text
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                changed |= set_option_string(&mut outreach.error, Some(error_text.to_string()));
            }
        }
        "responded" if outreach.status != "cancelled" => {
            changed |= set_string(&mut outreach.status, "completed");
            changed |= set_option_i64(&mut outreach.completed_at_ms, Some(timestamp_ms));
            changed |= set_option_string(&mut outreach.error, None);
        }
        "processing" if outreach.status != "cancelled" => {
            changed |= set_string(&mut outreach.status, "processing");
        }
        _ => {}
    }

    if outreach.updated_at_ms != timestamp_ms {
        outreach.updated_at_ms = timestamp_ms;
        changed = true;
    }

    changed
}
