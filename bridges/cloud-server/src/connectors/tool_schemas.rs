//! Argument schemas for connector tools, delivered on the lease with each
//! tool descriptor. Provider adapters add their tools here as they land
//! (PR 3); a tool without an entry gets an open object schema.

use serde_json::{json, Value};

/// JSON Schema for the arguments of `tool`.
pub fn input_schema(tool: &str) -> Value {
    if let Some(schema) = super::providers::input_schema(tool) {
        return schema;
    }
    match tool {
        #[cfg(test)]
        super::providers::stub::STUB_READ_TOOL => json!({
            "type": "object",
            "properties": { "q": { "type": "string" } }
        }),
        #[cfg(test)]
        super::providers::stub::STUB_ACT_TOOL => json!({
            "type": "object",
            "properties": { "text": { "type": "string" } },
            "required": ["text"]
        }),
        _ => json!({ "type": "object" }),
    }
}
