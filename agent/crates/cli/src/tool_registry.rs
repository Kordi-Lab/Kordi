use kordi_tools::connector_tools::ConnectorToolsRuntime;
use kordi_tools::{Tool, ToolMetadata, builtin_tools};
use std::collections::{HashMap, HashSet};

mod mac_local;

#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub(crate) enum ToolSelectionPreference {
    #[default]
    UseSettings,
    None,
    Only(Vec<String>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ToolSelection {
    All,
    /// Every available tool except the named ones.
    AllExcept(Vec<String>),
    None,
    Only(Vec<String>),
}

impl ToolSelection {
    /// Return this selection with `name` removed, whatever its shape.
    pub(crate) fn without(self, name: &str) -> Self {
        match self {
            Self::All => Self::AllExcept(vec![name.to_string()]),
            Self::AllExcept(mut excluded) => {
                if !excluded.iter().any(|existing| existing == name) {
                    excluded.push(name.to_string());
                }
                Self::AllExcept(excluded)
            }
            Self::None => Self::None,
            Self::Only(names) => Self::Only(
                names
                    .into_iter()
                    .filter(|existing| existing != name)
                    .collect(),
            ),
        }
    }
}

impl ToolSelectionPreference {
    pub(crate) fn resolve(&self, settings_tools: Option<&[String]>) -> ToolSelection {
        match self {
            Self::UseSettings => match settings_tools {
                Some(names) => ToolSelection::Only(names.to_vec()),
                None => ToolSelection::All,
            },
            Self::None => ToolSelection::None,
            Self::Only(names) => ToolSelection::Only(names.clone()),
        }
    }
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ToolSourceKind {
    Builtin,
    Extension,
}

#[cfg(test)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ToolDescriptor {
    pub name: String,
    pub description: String,
    pub source: ToolSourceKind,
}

struct RegisteredTool {
    #[cfg(test)]
    source: ToolSourceKind,
    tool: Box<dyn Tool>,
}

#[derive(Default)]
pub(crate) struct ToolRegistry {
    active_tools: Vec<Box<dyn Tool>>,
    tool_defs: Vec<serde_json::Value>,
    #[allow(dead_code)]
    metadata_by_name: HashMap<String, ToolMetadata>,
    /// Names of the connector tools registered for the current turn.
    #[allow(dead_code)] // Used by the desktop runtime, not the `kordi` binary.
    connector_tool_names: HashSet<String>,
    #[cfg(test)]
    active_names: Vec<String>,
    #[cfg(test)]
    available_tools: Vec<ToolDescriptor>,
}

impl ToolRegistry {
    #[cfg(test)]
    pub(crate) fn from_tools(tools: Vec<Box<dyn Tool>>) -> Self {
        Self::from_sources(Vec::new(), tools, ToolSelection::All)
    }

    pub(crate) fn from_sources(
        builtin: Vec<Box<dyn Tool>>,
        extensions: Vec<Box<dyn Tool>>,
        selection: ToolSelection,
    ) -> Self {
        let mut registered = Vec::new();
        registered.extend(builtin.into_iter().map(|tool| RegisteredTool {
            #[cfg(test)]
            source: ToolSourceKind::Builtin,
            tool,
        }));
        registered.extend(extensions.into_iter().map(|tool| RegisteredTool {
            #[cfg(test)]
            source: ToolSourceKind::Extension,
            tool,
        }));

        let deduped = dedupe_last_wins(registered);
        #[cfg(test)]
        let available_tools = deduped
            .iter()
            .map(|registered| ToolDescriptor {
                name: registered.tool.name().to_string(),
                description: registered.tool.description().to_string(),
                source: registered.source,
            })
            .collect::<Vec<_>>();

        #[cfg(test)]
        let (active_tools, active_names) = activate_tools(deduped, &selection);
        #[cfg(not(test))]
        let active_tools = activate_tools(deduped, &selection);
        let tool_defs = build_tool_defs(&active_tools);
        let metadata_by_name = build_tool_metadata(&active_tools);

        Self {
            active_tools,
            tool_defs,
            metadata_by_name,
            connector_tool_names: HashSet::new(),
            #[cfg(test)]
            active_names,
            #[cfg(test)]
            available_tools,
        }
    }

    pub(crate) fn from_builtin_and_extensions(
        extensions: Vec<Box<dyn Tool>>,
        selection: ToolSelection,
    ) -> Self {
        Self::from_sources(builtin_tools(), extensions, selection)
    }

    /// Replaces the connector tools with one `ConnectorTool` per descriptor
    /// in `runtime`, or removes them when `runtime` is `None` or `enabled`
    /// is false. A connector tool never replaces a tool already registered.
    #[allow(dead_code)] // Used by the desktop runtime, not the `kordi` binary.
    pub(crate) fn set_connector_tools(
        &mut self,
        runtime: Option<&ConnectorToolsRuntime>,
        enabled: bool,
    ) {
        let previous = std::mem::take(&mut self.connector_tool_names);
        if !previous.is_empty() {
            self.active_tools
                .retain(|tool| !previous.contains(tool.name()));
            self.metadata_by_name
                .retain(|name, _| !previous.contains(name));
            #[cfg(test)]
            self.active_names.retain(|name| !previous.contains(name));
        }
        for tool in runtime
            .filter(|_| enabled)
            .map_or_else(Vec::new, |runtime| runtime.tools())
        {
            let name = tool.name().to_string();
            if self.metadata_by_name.contains_key(&name) {
                continue;
            }
            self.metadata_by_name.insert(name.clone(), tool.metadata());
            #[cfg(test)]
            self.active_names.push(name.clone());
            self.connector_tool_names.insert(name);
            self.active_tools.push(tool);
        }
        self.tool_defs = build_tool_defs(&self.active_tools);
    }

    pub(crate) fn active_tools(&self) -> &[Box<dyn Tool>] {
        &self.active_tools
    }

    pub(crate) fn tool_defs(&self) -> &[serde_json::Value] {
        &self.tool_defs
    }

    #[allow(dead_code)]
    pub(crate) fn metadata_for(&self, tool_name: &str) -> Option<&ToolMetadata> {
        self.metadata_by_name.get(tool_name)
    }

    #[cfg(test)]
    pub(crate) fn active_names(&self) -> &[String] {
        &self.active_names
    }

    #[cfg(test)]
    pub(crate) fn available_tools(&self) -> &[ToolDescriptor] {
        &self.available_tools
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.active_tools.len()
    }
}

fn dedupe_last_wins(tools: Vec<RegisteredTool>) -> Vec<RegisteredTool> {
    let mut last_index_by_name = HashMap::new();
    for (index, registered) in tools.iter().enumerate() {
        last_index_by_name.insert(registered.tool.name().to_string(), index);
    }

    tools
        .into_iter()
        .enumerate()
        .filter_map(|(index, registered)| {
            let is_last = last_index_by_name.get(registered.tool.name()).copied() == Some(index);
            is_last.then_some(registered)
        })
        .collect()
}

#[cfg(test)]
fn activate_tools(
    deduped: Vec<RegisteredTool>,
    selection: &ToolSelection,
) -> (Vec<Box<dyn Tool>>, Vec<String>) {
    match selection {
        ToolSelection::All => {
            let active_names = deduped
                .iter()
                .map(|registered| registered.tool.name().to_string())
                .collect();
            let active_tools = deduped
                .into_iter()
                .map(|registered| registered.tool)
                .collect();
            (active_tools, active_names)
        }
        ToolSelection::AllExcept(excluded) => {
            let kept = deduped
                .into_iter()
                .filter(|registered| !excluded.iter().any(|name| name == registered.tool.name()))
                .collect::<Vec<_>>();
            let active_names = kept
                .iter()
                .map(|registered| registered.tool.name().to_string())
                .collect();
            let active_tools = kept.into_iter().map(|registered| registered.tool).collect();
            (active_tools, active_names)
        }
        ToolSelection::None => (Vec::new(), Vec::new()),
        ToolSelection::Only(requested_names) => {
            let mut requested = Vec::new();
            let mut seen = HashSet::new();
            for name in requested_names {
                if seen.insert(name.clone()) {
                    requested.push(name.clone());
                }
            }

            let mut by_name = HashMap::new();
            for registered in deduped {
                by_name.insert(registered.tool.name().to_string(), registered.tool);
            }

            let mut active_tools = Vec::new();
            let mut active_names = Vec::new();
            for name in requested {
                if let Some(tool) = by_name.remove(&name) {
                    active_names.push(name);
                    active_tools.push(tool);
                }
            }
            (active_tools, active_names)
        }
    }
}

#[cfg(not(test))]
fn activate_tools(deduped: Vec<RegisteredTool>, selection: &ToolSelection) -> Vec<Box<dyn Tool>> {
    match selection {
        ToolSelection::All => deduped
            .into_iter()
            .map(|registered| registered.tool)
            .collect(),
        ToolSelection::AllExcept(excluded) => deduped
            .into_iter()
            .filter(|registered| !excluded.iter().any(|name| name == registered.tool.name()))
            .map(|registered| registered.tool)
            .collect(),
        ToolSelection::None => Vec::new(),
        ToolSelection::Only(requested_names) => {
            let mut requested = Vec::new();
            let mut seen = HashSet::new();
            for name in requested_names {
                if seen.insert(name.clone()) {
                    requested.push(name.clone());
                }
            }

            let mut by_name = HashMap::new();
            for registered in deduped {
                by_name.insert(registered.tool.name().to_string(), registered.tool);
            }

            let mut active_tools = Vec::new();
            for name in requested {
                if let Some(tool) = by_name.remove(&name) {
                    active_tools.push(tool);
                }
            }
            active_tools
        }
    }
}

fn build_tool_metadata(tools: &[Box<dyn Tool>]) -> HashMap<String, ToolMetadata> {
    tools
        .iter()
        .map(|tool| (tool.name().to_string(), tool.metadata()))
        .collect()
}

pub(crate) fn build_tool_defs(tools: &[Box<dyn Tool>]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|tool| {
            let definition = tool.definition();
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": definition.name,
                    "description": definition.description,
                    "parameters": definition.parameters_schema,
                }
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use kordi_tools::{ToolLayer, ToolRiskLevel};
    use serde_json::{Value, json};
    use tokio_util::sync::CancellationToken;

    struct NamedTool {
        name: &'static str,
        description: &'static str,
    }

    #[async_trait]
    impl Tool for NamedTool {
        fn name(&self) -> &str {
            self.name
        }

        fn description(&self) -> &str {
            self.description
        }

        fn parameters_schema(&self) -> Value {
            json!({"type": "object"})
        }

        async fn execute(
            &self,
            _params: Value,
            _ctx: &kordi_tools::ToolContext,
            _cancel: CancellationToken,
        ) -> kordi_core::error::KordiResult<kordi_tools::ToolResult> {
            unimplemented!("tool execution is not needed for registry tests")
        }
    }

    #[test]
    fn active_tool_metadata_defaults_to_observation_read_only_without_changing_model_schema() {
        let registry = ToolRegistry::from_sources(
            vec![Box::new(NamedTool {
                name: "read",
                description: "read",
            })],
            vec![],
            ToolSelection::All,
        );

        let metadata = registry
            .metadata_for("read")
            .expect("active tool metadata should be available");
        assert_eq!(metadata.layer, ToolLayer::Observation);
        assert_eq!(metadata.risk, ToolRiskLevel::ReadOnly);
        assert!(metadata.supports_parallel);
        assert!(
            registry.tool_defs()[0]["function"]
                .get("metadata")
                .is_none()
        );
    }

    #[test]
    fn settings_tool_selection_defaults_to_all_when_unset() {
        let selection = ToolSelectionPreference::UseSettings.resolve(None);
        assert_eq!(selection, ToolSelection::All);
    }

    #[test]
    fn settings_tool_selection_uses_settings_when_present() {
        let selection = ToolSelectionPreference::UseSettings
            .resolve(Some(&["read".to_string(), "bash".to_string()]));
        assert_eq!(
            selection,
            ToolSelection::Only(vec!["read".to_string(), "bash".to_string()])
        );
    }

    #[test]
    fn session_observation_tools_are_active_by_default() {
        let registry = ToolRegistry::from_builtin_and_extensions(vec![], ToolSelection::All);

        assert!(
            registry
                .active_names()
                .contains(&"search_sessions".to_string())
        );
        assert!(
            registry
                .active_names()
                .contains(&"read_session".to_string())
        );
        assert_eq!(
            registry.metadata_for("search_sessions").unwrap().layer,
            ToolLayer::Observation,
        );
        assert_eq!(
            registry.metadata_for("read_session").unwrap().risk,
            ToolRiskLevel::ReadOnly,
        );
    }

    #[test]
    fn extension_tool_overrides_builtin_with_same_name() {
        let registry = ToolRegistry::from_sources(
            vec![Box::new(NamedTool {
                name: "read",
                description: "builtin read",
            })],
            vec![Box::new(NamedTool {
                name: "read",
                description: "extension read",
            })],
            ToolSelection::All,
        );

        assert_eq!(registry.active_names(), &["read".to_string()]);
        assert_eq!(registry.available_tools().len(), 1);
        assert_eq!(
            registry.available_tools()[0].source,
            ToolSourceKind::Extension
        );
        assert_eq!(registry.available_tools()[0].description, "extension read");
    }

    #[test]
    fn explicit_selection_preserves_requested_order_and_ignores_unknown_names() {
        let registry = ToolRegistry::from_sources(
            vec![
                Box::new(NamedTool {
                    name: "read",
                    description: "read",
                }),
                Box::new(NamedTool {
                    name: "bash",
                    description: "bash",
                }),
            ],
            vec![Box::new(NamedTool {
                name: "my_tool",
                description: "custom",
            })],
            ToolSelection::Only(vec![
                "my_tool".to_string(),
                "bash".to_string(),
                "missing".to_string(),
                "bash".to_string(),
            ]),
        );

        assert_eq!(
            registry.active_names(),
            &["my_tool".to_string(), "bash".to_string()]
        );
        assert_eq!(registry.len(), 2);
    }
}

#[cfg(test)]
#[path = "tool_registry_connector_tests.rs"]
mod connector_tests;
