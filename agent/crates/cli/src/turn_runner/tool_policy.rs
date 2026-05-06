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

pub(super) fn evaluate_reflection_advisory(
    metadata: Option<&ToolMetadata>,
    tool_name: &str,
    is_error: bool,
    details: &serde_json::Value,
) -> Option<String> {
    let metadata = metadata?;
    if matches!(metadata.layer, ToolLayer::Reflection) || tool_name == "reflection" {
        return None;
    }

    if is_error {
        return Some(
            "Consider using reflection to save a concise scoped lesson if this failure revealed a reusable correction."
                .to_string(),
        );
    }

    if matches!(metadata.layer, ToolLayer::Operator)
        && details
            .get("status")
            .and_then(|value| value.as_str())
            .is_some_and(|status| matches!(status, "accepted" | "completed"))
    {
        return Some(
            "Consider using reflection to save a scoped lesson if this task outcome should influence future work."
                .to_string(),
        );
    }

    None
}

#[cfg(test)]
mod tests {
    use kordi_tools::{ToolLayer, ToolMetadata, ToolRiskLevel};

    use super::{
        ToolPolicyDecision, ToolPolicyState, evaluate_reflection_advisory, evaluate_tool_policy,
    };

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

    #[test]
    fn failed_non_reflection_tool_advises_scoped_reflection() {
        let metadata = ToolMetadata::execution(ToolRiskLevel::Medium);
        let advisory = evaluate_reflection_advisory(
            Some(&metadata),
            "bash",
            true,
            &serde_json::json!({"exitCode": 1}),
        )
        .expect("advisory");

        assert!(advisory.contains("reflection"));
        assert!(advisory.contains("scoped"));
    }

    #[test]
    fn completed_operator_tool_advises_scoped_reflection() {
        let metadata = ToolMetadata::new(ToolLayer::Operator, ToolRiskLevel::Medium, false);
        let advisory = evaluate_reflection_advisory(
            Some(&metadata),
            "task_operator",
            false,
            &serde_json::json!({"status": "completed"}),
        )
        .expect("advisory");

        assert!(advisory.contains("task outcome"));
    }

    #[test]
    fn reflection_tool_does_not_advise_reflecting_on_reflection() {
        let metadata = ToolMetadata::reflection();
        let advisory = evaluate_reflection_advisory(
            Some(&metadata),
            "reflection",
            false,
            &serde_json::json!({"status": "saved"}),
        );

        assert_eq!(advisory, None);
    }
}
