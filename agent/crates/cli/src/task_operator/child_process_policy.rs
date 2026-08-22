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
        "You are a scoped child task agent. Task path: {task_path}. Task name: {task_name}. Write scope: {write_scope}. Stay within this scope and return a concise final report. If a required tool is unavailable, stop and report that limitation; never replace a missing session-observation tool with a broad filesystem search."
    )
}

#[cfg(test)]
mod tests {
    use super::child_agent_tool_names;

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
}
