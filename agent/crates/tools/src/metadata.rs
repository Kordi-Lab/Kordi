use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolLayer {
    #[default]
    Observation,
    Planning,
    Operator,
    Execution,
    Reflection,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolRiskLevel {
    #[default]
    ReadOnly,
    Low,
    Medium,
    High,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolMetadata {
    pub layer: ToolLayer,
    pub risk: ToolRiskLevel,
    pub supports_parallel: bool,
}

impl ToolMetadata {
    pub const fn new(layer: ToolLayer, risk: ToolRiskLevel, supports_parallel: bool) -> Self {
        Self {
            layer,
            risk,
            supports_parallel,
        }
    }

    pub const fn observation() -> Self {
        Self::new(ToolLayer::Observation, ToolRiskLevel::ReadOnly, true)
    }

    pub const fn planning() -> Self {
        Self::new(ToolLayer::Planning, ToolRiskLevel::Low, false)
    }

    pub const fn operator(risk: ToolRiskLevel) -> Self {
        Self::new(ToolLayer::Operator, risk, false)
    }

    pub const fn execution(risk: ToolRiskLevel) -> Self {
        Self::new(ToolLayer::Execution, risk, false)
    }

    pub const fn reflection() -> Self {
        Self::new(ToolLayer::Reflection, ToolRiskLevel::Low, false)
    }
}

impl Default for ToolMetadata {
    fn default() -> Self {
        Self::observation()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters_schema: Value,
    pub metadata: ToolMetadata,
}
