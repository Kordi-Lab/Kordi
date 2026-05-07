//! Builtin tool implementations and tool integration types for Kordi.

mod artifacts;
pub mod bash;
pub mod bash_policy;
pub mod browser_fetch;
mod diff;
pub mod edit;
pub mod find;
pub mod grep;
pub mod ls;
pub mod metadata;
pub(crate) mod path;
pub mod plan_tool;
pub mod reach_out;
pub mod read;
pub mod reflection_tool;
mod registry;
pub mod registry_plan;
pub(crate) mod sandbox;
pub mod scheduler;
pub(crate) mod support;
pub mod task_operator;
pub(crate) mod text;
mod types;
pub(crate) mod web;
pub mod web_fetch;
pub mod web_search;
pub mod write;

pub use metadata::{ToolDefinition, ToolLayer, ToolMetadata, ToolRiskLevel};
pub use registry::builtin_tools;
pub use registry_plan::{ToolRegistryPlan, ToolRegistryPlanEntry};
pub use scheduler::{
    FileQueue, FileQueueReservation, execute_reserved_tool_call, execute_tool_call,
    execute_tool_calls,
};
pub use types::{
    ExecutionPolicy, ReachOutFn, ReachOutFuture, ReachOutRequest, ReachOutResponse,
    ReachOutRuntime, ReflectionLessonFuture, ReflectionLessonRequest, ReflectionLessonResponse,
    ReflectionRuntime, RequestToolApprovalFn, SaveReflectionLessonFn, TaskOperatorFn,
    TaskOperatorFuture, TaskOperatorRuntime, Tool, ToolApprovalDecision, ToolApprovalOutcome,
    ToolApprovalRequest, ToolContext, ToolExecutionMode, ToolResult, ToolScheduling,
    WebSearchRuntime,
};
