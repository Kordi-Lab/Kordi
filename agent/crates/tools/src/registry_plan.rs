use crate::{Tool, ToolDefinition, ToolMetadata};

#[derive(Clone, Debug, PartialEq)]
pub struct ToolRegistryPlanEntry {
    pub definition: ToolDefinition,
    pub metadata: ToolMetadata,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolRegistryPlan {
    pub entries: Vec<ToolRegistryPlanEntry>,
}

impl ToolRegistryPlan {
    pub fn from_tools(tools: &[Box<dyn Tool>]) -> Self {
        Self {
            entries: tools
                .iter()
                .map(|tool| {
                    let definition = tool.definition();
                    let metadata = definition.metadata.clone();
                    ToolRegistryPlanEntry {
                        definition,
                        metadata,
                    }
                })
                .collect(),
        }
    }

    pub fn model_visible_definitions(&self) -> Vec<serde_json::Value> {
        self.entries
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": entry.definition.name,
                        "description": entry.definition.description,
                        "parameters": entry.definition.parameters_schema,
                    }
                })
            })
            .collect()
    }
}
