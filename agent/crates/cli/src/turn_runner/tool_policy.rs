use kordi_tools::{ToolLayer, ToolMetadata};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct ToolPolicyState {
    planning_seen: bool,
}

impl ToolPolicyState {
    pub(super) fn record_tool_metadata(&mut self, metadata: &ToolMetadata) {
        if matches!(metadata.layer, ToolLayer::Planning | ToolLayer::Operator) {
            self.planning_seen = true;
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ToolPolicyDecision {
    Allow,
    AllowWithWarning(String),
    #[allow(dead_code)]
    Deny(String),
}

pub(super) fn evaluate_tool_policy(
    state: &ToolPolicyState,
    metadata: &ToolMetadata,
) -> ToolPolicyDecision {
    match metadata.layer {
        ToolLayer::Observation | ToolLayer::Planning | ToolLayer::Reflection => {
            ToolPolicyDecision::Allow
        }
        ToolLayer::Operator if state.planning_seen => ToolPolicyDecision::Allow,
        ToolLayer::Operator => ToolPolicyDecision::AllowWithWarning(
            "operator tool used before a planning step".to_string(),
        ),
        ToolLayer::Execution if state.planning_seen => ToolPolicyDecision::Allow,
        ToolLayer::Execution => ToolPolicyDecision::AllowWithWarning(
            "execution tool used before a planning or operator step".to_string(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use kordi_tools::{ToolLayer, ToolMetadata, ToolRiskLevel};

    use super::{ToolPolicyDecision, ToolPolicyState, evaluate_tool_policy};

    #[test]
    fn observation_tools_are_allowed_without_planning() {
        let state = ToolPolicyState::default();
        let decision = evaluate_tool_policy(&state, &ToolMetadata::observation());
        assert_eq!(decision, ToolPolicyDecision::Allow);
    }

    #[test]
    fn execution_tools_before_planning_are_allowed_with_warning() {
        let state = ToolPolicyState::default();
        let metadata = ToolMetadata::execution(ToolRiskLevel::Medium);
        let decision = evaluate_tool_policy(&state, &metadata);
        assert!(
            matches!(decision, ToolPolicyDecision::AllowWithWarning(message) if message.contains("planning"))
        );
    }

    #[test]
    fn operator_tools_after_planning_are_allowed() {
        let mut state = ToolPolicyState::default();
        state.record_tool_metadata(&ToolMetadata::planning());

        let metadata = ToolMetadata::new(ToolLayer::Operator, ToolRiskLevel::Medium, false);
        let decision = evaluate_tool_policy(&state, &metadata);
        assert_eq!(decision, ToolPolicyDecision::Allow);
    }
}
