use super::*;

#[test]
fn lifecycle_supports_full_success_path() {
    let mut lifecycle = ToolExecutionStateMachine::new();
    lifecycle.transition(
        ToolExecutionPhase::Created,
        ToolExecutionPhase::ExecutionStarted,
    );
    lifecycle.transition(
        ToolExecutionPhase::ExecutionStarted,
        ToolExecutionPhase::PreflightComplete,
    );
    lifecycle.transition(
        ToolExecutionPhase::PreflightComplete,
        ToolExecutionPhase::Running,
    );
    lifecycle.transition(
        ToolExecutionPhase::Running,
        ToolExecutionPhase::ResultAvailable,
    );
    lifecycle.transition(
        ToolExecutionPhase::ResultAvailable,
        ToolExecutionPhase::ResultHooksApplied,
    );
    lifecycle.transition(
        ToolExecutionPhase::ResultHooksApplied,
        ToolExecutionPhase::ExecutionEnded,
    );
    lifecycle.transition(
        ToolExecutionPhase::ExecutionEnded,
        ToolExecutionPhase::Persisted,
    );

    assert_eq!(lifecycle.phase, ToolExecutionPhase::Persisted);
}

#[test]
fn lifecycle_supports_blocked_preflight_path() {
    let mut lifecycle = ToolExecutionStateMachine::new();
    lifecycle.transition(
        ToolExecutionPhase::Created,
        ToolExecutionPhase::ExecutionStarted,
    );
    lifecycle.transition(
        ToolExecutionPhase::ExecutionStarted,
        ToolExecutionPhase::PreflightComplete,
    );
    lifecycle.transition(
        ToolExecutionPhase::PreflightComplete,
        ToolExecutionPhase::ResultAvailable,
    );
    lifecycle.transition(
        ToolExecutionPhase::ResultAvailable,
        ToolExecutionPhase::ResultHooksApplied,
    );
    lifecycle.transition(
        ToolExecutionPhase::ResultHooksApplied,
        ToolExecutionPhase::ExecutionEnded,
    );
    lifecycle.transition(
        ToolExecutionPhase::ExecutionEnded,
        ToolExecutionPhase::Persisted,
    );

    assert_eq!(lifecycle.phase, ToolExecutionPhase::Persisted);
}
