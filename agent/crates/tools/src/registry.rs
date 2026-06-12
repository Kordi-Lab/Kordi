use crate::types::Tool;

/// Get all built-in tools.
pub fn builtin_tools() -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(crate::read::ReadTool),
        Box::new(crate::bash::BashTool),
        Box::new(crate::edit::EditTool),
        Box::new(crate::write::WriteTool),
        Box::new(crate::plan_tool::UpdatePlanTool),
        Box::new(crate::task_operator::TaskOperatorTool),
        Box::new(crate::schedule_task::ScheduleTaskTool),
        Box::new(crate::find::FindTool),
        Box::new(crate::grep::GrepTool),
        Box::new(crate::ls::LsTool),
        Box::new(crate::session_observation::SearchSessionsTool),
        Box::new(crate::session_observation::ReadSessionTool),
        Box::new(crate::web_search::WebSearchTool),
        Box::new(crate::web_fetch::WebFetchTool),
        Box::new(crate::browser_fetch::BrowserFetchTool),
        Box::new(crate::reach_out::ReachOutTool),
        Box::new(crate::reflection_tool::ReflectionTool),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ToolLayer, ToolRiskLevel};

    fn metadata_for(name: &str) -> crate::ToolMetadata {
        builtin_tools()
            .into_iter()
            .find(|tool| tool.name() == name)
            .unwrap_or_else(|| panic!("missing builtin tool {name}"))
            .metadata()
    }

    #[test]
    fn builtin_metadata_categorizes_observation_tools_as_read_only_parallel() {
        for name in [
            "read",
            "find",
            "grep",
            "ls",
            "web_search",
            "web_fetch",
            "browser_fetch",
            "search_sessions",
            "read_session",
        ] {
            let metadata = metadata_for(name);
            assert_eq!(metadata.layer, ToolLayer::Observation, "{name}");
            assert_eq!(metadata.risk, ToolRiskLevel::ReadOnly, "{name}");
            assert!(metadata.supports_parallel, "{name}");
        }
    }

    #[test]
    fn builtin_tools_include_update_plan_as_planning_tool() {
        let metadata = metadata_for("update_plan");
        assert_eq!(metadata.layer, ToolLayer::Planning);
        assert_eq!(metadata.risk, ToolRiskLevel::Low);
        assert!(!metadata.supports_parallel);
    }

    #[test]
    fn builtin_tools_include_task_operator_as_operator_tool() {
        let metadata = metadata_for("task_operator");
        assert_eq!(metadata.layer, ToolLayer::Operator);
        assert_eq!(metadata.risk, ToolRiskLevel::Medium);
        assert!(!metadata.supports_parallel);
    }

    #[test]
    fn builtin_tools_include_schedule_task_as_operator_tool() {
        let metadata = metadata_for("schedule_task");
        assert_eq!(metadata.layer, ToolLayer::Operator);
        assert_eq!(metadata.risk, ToolRiskLevel::Medium);
        assert!(!metadata.supports_parallel);
    }

    #[test]
    fn schedule_task_description_guides_runtime_choice() {
        let tool = builtin_tools()
            .into_iter()
            .find(|tool| tool.name() == "schedule_task")
            .expect("missing schedule_task tool");
        let description = tool.description();
        assert!(description.contains("Cloud-backed scheduled task"));
        assert!(description.contains("localRequired"));
        assert!(description.contains("Interpret unqualified times"));
        assert!(description.contains("user's local Desktop timezone"));
        assert!(description.contains("local files, disk usage, Downloads, screenshots"));
        assert!(description.contains("cloud"));
        assert!(description.contains("web search, communication, reminders"));
        assert!(description.contains("Do not use bash, at, cron"));
    }

    #[test]
    fn builtin_metadata_categorizes_mutating_and_operator_tools() {
        let bash = metadata_for("bash");
        assert_eq!(bash.layer, ToolLayer::Execution);
        assert_eq!(bash.risk, ToolRiskLevel::High);
        assert!(!bash.supports_parallel);

        for name in ["edit", "write"] {
            let metadata = metadata_for(name);
            assert_eq!(metadata.layer, ToolLayer::Execution, "{name}");
            assert_eq!(metadata.risk, ToolRiskLevel::Medium, "{name}");
            assert!(!metadata.supports_parallel, "{name}");
        }

        let reach_out = metadata_for("reach_out");
        assert_eq!(reach_out.layer, ToolLayer::Operator);
        assert_eq!(reach_out.risk, ToolRiskLevel::Medium);
        assert!(!reach_out.supports_parallel);

        let reflection = metadata_for("reflection");
        assert_eq!(reflection.layer, ToolLayer::Reflection);
        assert_eq!(reflection.risk, ToolRiskLevel::Low);
        assert!(!reflection.supports_parallel);
    }
}
