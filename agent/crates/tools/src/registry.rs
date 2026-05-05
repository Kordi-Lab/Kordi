use crate::types::Tool;

/// Get all built-in tools.
pub fn builtin_tools() -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(crate::read::ReadTool),
        Box::new(crate::bash::BashTool),
        Box::new(crate::edit::EditTool),
        Box::new(crate::write::WriteTool),
        Box::new(crate::find::FindTool),
        Box::new(crate::grep::GrepTool),
        Box::new(crate::ls::LsTool),
        Box::new(crate::web_search::WebSearchTool),
        Box::new(crate::web_fetch::WebFetchTool),
        Box::new(crate::browser_fetch::BrowserFetchTool),
        Box::new(crate::reach_out::ReachOutTool),
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
        ] {
            let metadata = metadata_for(name);
            assert_eq!(metadata.layer, ToolLayer::Observation, "{name}");
            assert_eq!(metadata.risk, ToolRiskLevel::ReadOnly, "{name}");
            assert!(metadata.supports_parallel, "{name}");
        }
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
    }
}
