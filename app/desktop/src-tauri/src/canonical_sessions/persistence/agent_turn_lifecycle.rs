use super::super::{AppendCanonicalMessageRequest, CanonicalSessionMessage};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CloudAgentTurnLifecycleState {
    Queued,
    Processing,
    Complete,
    Failed,
    Cancelled,
}

impl CloudAgentTurnLifecycleState {
    fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "queued" => Some(Self::Queued),
            "processing" => Some(Self::Processing),
            "complete" => Some(Self::Complete),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Complete | Self::Failed | Self::Cancelled)
    }
}

fn cloud_agent_turn_lifecycle_state(
    message_kind: &str,
    status: &str,
    content: &Option<serde_json::Value>,
) -> Option<CloudAgentTurnLifecycleState> {
    if !message_kind.trim().eq_ignore_ascii_case("agent-turn") {
        return None;
    }
    let status_state = CloudAgentTurnLifecycleState::parse(status);
    let content_state = content
        .as_ref()
        .and_then(|value| value.get("deliveryState"))
        .and_then(serde_json::Value::as_str)
        .and_then(CloudAgentTurnLifecycleState::parse);
    if status_state.is_some_and(CloudAgentTurnLifecycleState::is_terminal) {
        return status_state;
    }
    if content_state.is_some_and(CloudAgentTurnLifecycleState::is_terminal) {
        return content_state;
    }
    content_state.or(status_state)
}

pub(super) fn can_apply_cloud_agent_turn_transition(
    current: &CanonicalSessionMessage,
    incoming: &AppendCanonicalMessageRequest,
    incoming_status: &str,
) -> bool {
    let current_state =
        cloud_agent_turn_lifecycle_state(&current.message_kind, &current.status, &current.content);
    let incoming_state = cloud_agent_turn_lifecycle_state(
        &incoming.message_kind,
        incoming_status,
        &incoming.content,
    );
    let Some(current_state) = current_state else {
        return true;
    };
    let Some(incoming_state) = incoming_state else {
        return false;
    };
    if current_state.is_terminal() {
        if current_state == CloudAgentTurnLifecycleState::Failed
            && incoming_state == CloudAgentTurnLifecycleState::Complete
        {
            return true;
        }
        return incoming_state == current_state;
    }
    !(current_state == CloudAgentTurnLifecycleState::Processing
        && incoming_state == CloudAgentTurnLifecycleState::Queued)
}
