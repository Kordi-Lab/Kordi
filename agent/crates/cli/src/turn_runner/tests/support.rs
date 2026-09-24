//! Shared model, metrics, and tool-context fixtures for turn-runner tests.

use kordi_monitor::RequestMetricsTracker;
use std::sync::Arc;

pub(super) fn test_model(context_window: u64) -> kordi_provider::registry::Model {
    kordi_provider::registry::Model {
        id: "dummy-model".to_string(),
        name: "dummy-model".to_string(),
        provider: "dummy".to_string(),
        api: kordi_provider::registry::ApiType::OpenaiCompletions,
        context_window,
        max_tokens: 4_096,
        reasoning: false,
        input: vec![kordi_provider::registry::ModelInput::Text],
        base_url: None,
        cost: Default::default(),
    }
}

pub(super) fn test_request_metrics_tracker() -> Arc<tokio::sync::Mutex<RequestMetricsTracker>> {
    Arc::new(tokio::sync::Mutex::new(RequestMetricsTracker::new()))
}

pub(super) fn test_tool_context() -> kordi_tools::ToolContext {
    kordi_tools::ToolContext {
        cwd: "/tmp".into(),
        artifacts_dir: "/tmp".into(),
        model: None,
        execution_policy: kordi_tools::ExecutionPolicy::Safety,
        on_output: None,
        web_search: None,
        reach_out: None,
        reflection: None,
        session_observation: None,
        task_operator: None,
        schedule_task: None,
        execution_mode: kordi_tools::ToolExecutionMode::Interactive,
        request_approval: None,
    }
}
