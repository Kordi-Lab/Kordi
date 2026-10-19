use std::time::Duration;

pub(super) const CHILD_AGENT_PROCESS_TIMEOUT: Duration = Duration::from_secs(300);

pub(super) fn child_agent_tool_names(has_write_scope: bool) -> &'static str {
    if has_write_scope {
        "read,grep,find,ls,web_search,web_fetch,search_sessions,read_session,bash,edit,write"
    } else {
        "read,grep,find,ls,web_search,web_fetch,search_sessions,read_session"
    }
}

pub(super) fn prompt_context(task_path: &str, task_name: &str, write_scope: &[String]) -> String {
    let write_scope = if write_scope.is_empty() {
        "read-only".to_string()
    } else {
        write_scope.join(", ")
    };
    format!(
        "You are a scoped child task agent. Task path: {task_path}. Task name: {task_name}. Write scope: {write_scope}. Stay within this scope and return a concise final report. Keep orchestration policy out of the visible response. When the request references a source session, use read_session or search_sessions to retrieve only the participants and messages needed for the task. {UNABLE_TO_COMPLETE_POLICY} Never replace a missing session-observation tool with a broad filesystem search."
    )
}

const UNABLE_TO_COMPLETE_POLICY: &str = "If a required tool is unavailable or the work cannot be done, stop and state plainly that the task was not completed and why; never present a partial or substituted result as the finished task.";

/// Tools a background session started by the owner's own request on the
/// owner's Mac receives: the parent turn's tools, minus `task_operator` so a
/// background session never starts another one.
pub(super) fn owner_local_child_tool_names(parent_tools: &[String]) -> Vec<String> {
    let mut tools = Vec::new();
    for name in parent_tools.iter().map(|name| name.trim()) {
        if !name.is_empty() && name != "task_operator" && !tools.iter().any(|tool| tool == name) {
            tools.push(name.to_string());
        }
    }
    tools
}

pub(super) fn owner_local_prompt_context(
    task_path: &str,
    task_name: &str,
    write_scope: &[String],
) -> String {
    let scope = if write_scope.is_empty() {
        String::new()
    } else {
        format!(" Keep file changes within: {}.", write_scope.join(", "))
    };
    format!(
        "You are a background task of the owner's own agent, running on the owner's Mac with the same local tools and approval rules as the parent turn. Task path: {task_path}. Task name: {task_name}.{scope} Do the task with those tools and return a concise final report. Keep orchestration policy out of the visible response. When the request references a source session, use read_session or search_sessions for its messages instead of scanning local files for chat history. {UNABLE_TO_COMPLETE_POLICY}"
    )
}

#[cfg(test)]
mod tests {
    use super::{
        child_agent_tool_names, owner_local_child_tool_names, owner_local_prompt_context,
        prompt_context,
    };

    #[test]
    fn read_only_child_agents_can_observe_sessions_without_mutation_tools() {
        let tools = child_agent_tool_names(false);

        assert!(tools.split(',').any(|tool| tool == "search_sessions"));
        assert!(tools.split(',').any(|tool| tool == "read_session"));
        assert!(tools.split(',').any(|tool| tool == "web_search"));
        assert!(!tools.split(',').any(|tool| tool == "bash"));
        assert!(!tools.split(',').any(|tool| tool == "edit"));
        assert!(!tools.split(',').any(|tool| tool == "write"));
    }

    #[test]
    fn scoped_writer_child_agents_keep_mutation_tools() {
        let tools = child_agent_tool_names(true);

        assert!(tools.split(',').any(|tool| tool == "search_sessions"));
        assert!(tools.split(',').any(|tool| tool == "read_session"));
        assert!(tools.split(',').any(|tool| tool == "bash"));
        assert!(tools.split(',').any(|tool| tool == "edit"));
        assert!(tools.split(',').any(|tool| tool == "write"));
    }

    #[test]
    fn owner_local_child_agents_keep_the_parent_tools_without_task_operator() {
        let parent = [
            "read",
            "bash",
            "edit",
            "write",
            "task_operator",
            "search_sessions",
            "bash",
        ]
        .map(String::from);
        let tools = owner_local_child_tool_names(&parent);

        assert_eq!(
            tools,
            ["read", "bash", "edit", "write", "search_sessions"].map(String::from)
        );
    }

    #[test]
    fn owner_local_prompt_does_not_claim_read_only_and_requires_honest_failure() {
        let prompt = owner_local_prompt_context("/root/disk", "disk", &[]);

        assert!(!prompt.contains("read-only"));
        assert!(prompt.contains("same local tools and approval rules"));
        assert!(prompt.contains("the task was not completed"));
        assert!(prompt_context("/root/disk", "disk", &[]).contains("the task was not completed"));
    }
}
