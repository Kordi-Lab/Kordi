//! Message dispatcher — routes inbound messages to the configured runtime.

use super::runtimes::{
    ClaudeCodeRuntime, CodexRuntime, GenericRuntime, MessageMeta, OpenClawRuntime, Runtime,
};

/// Sandbox context for an inbound request.
pub struct SandboxContext {
    pub query: String,
    pub from_node_id: String,
    pub from_display_name: Option<String>,
    pub from_role: Option<String>,
    pub project_id: String,
    pub kind: String,
    pub session_id: Option<String>,
}

/// Create a sandbox context from an inbound message.
#[allow(clippy::too_many_arguments)]
pub fn create_sandbox(
    _project_dir: &str,
    from_node_id: &str,
    from_display_name: Option<&str>,
    from_role: Option<&str>,
    project_id: &str,
    kind: &str,
    session_id: Option<&str>,
    payload: &serde_json::Value,
) -> SandboxContext {
    let query = payload
        .get("question")
        .or_else(|| payload.get("message"))
        .or_else(|| payload.get("topic"))
        .or_else(|| payload.get("content"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| payload.to_string());

    SandboxContext {
        query,
        from_node_id: from_node_id.to_string(),
        from_display_name: from_display_name.map(|s| s.to_string()),
        from_role: from_role.map(|s| s.to_string()),
        project_id: project_id.to_string(),
        kind: kind.to_string(),
        session_id: session_id.map(|s| s.to_string()),
    }
}

/// Create the appropriate runtime adapter.
pub fn create_runtime(
    runtime_type: &str,
    endpoint: &str,
    project_dir: &str,
) -> Result<Box<dyn Runtime>, String> {
    match runtime_type {
        "claude-code" => Ok(Box::new(ClaudeCodeRuntime::new(endpoint, project_dir))),
        "openclaw" => Ok(Box::new(OpenClawRuntime::new(endpoint))),
        "codex" => Ok(Box::new(CodexRuntime::new(endpoint, project_dir)?)),
        "generic" => Ok(Box::new(GenericRuntime::new(endpoint))),
        other => Err(format!("unknown runtime: {}", other)),
    }
}

/// Dispatch an inbound message to the configured runtime.
pub async fn dispatch_message(
    runtime: &dyn Runtime,
    sandbox: &SandboxContext,
) -> Result<String, String> {
    let meta = MessageMeta {
        from_node_id: sandbox.from_node_id.clone(),
        from_display_name: sandbox.from_display_name.clone(),
        from_role: sandbox.from_role.clone(),
        project_id: sandbox.project_id.clone(),
        kind: sandbox.kind.clone(),
        session_id: sandbox.session_id.clone(),
    };
    runtime.dispatch(&sandbox.query, &meta).await
}
