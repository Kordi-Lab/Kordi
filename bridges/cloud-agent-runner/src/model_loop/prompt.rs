use kordi_tools::{web_fetch::WebFetchTool, web_search::WebSearchTool, Tool};
use serde_json::{json, Value};

pub fn cloud_sandbox_system_prompt() -> &'static str {
    "You are running in Kordi Cloud fallback because the owner device is offline. \
You may work only inside the Cloud sandbox workspace. You cannot read owner laptop files, \
owner-local services, localhost/private networks, other users' data, or unsynced private resources. \
Do not ask for approval prompts; unavailable actions should be explained as runtime boundaries. \
Export artifacts only when explicitly useful to share; unexported sandbox files remain private."
}

pub fn tool_catalog() -> Vec<Value> {
    vec![
        tool_schema(
            "read",
            "Read a UTF-8 text file inside the Cloud sandbox.",
            vec![("path", "string")],
        ),
        tool_schema(
            "write",
            "Write a UTF-8 text file inside the Cloud sandbox.",
            vec![("path", "string"), ("content", "string")],
        ),
        tool_schema(
            "edit",
            "Replace file content inside the Cloud sandbox.",
            vec![("path", "string"), ("content", "string")],
        ),
        tool_schema(
            "ls",
            "List a Cloud sandbox directory.",
            vec![("path", "string")],
        ),
        tool_schema(
            "find",
            "Find entries inside a Cloud sandbox directory.",
            vec![("path", "string")],
        ),
        tool_schema(
            "grep",
            "Search entries inside a Cloud sandbox directory.",
            vec![("path", "string")],
        ),
        tool_schema(
            "bash",
            "Run a shell command inside the Cloud sandbox.",
            vec![("command", "string")],
        ),
        local_tool_schema(&WebSearchTool),
        local_tool_schema(&WebFetchTool),
        tool_schema(
            "export_artifact",
            "Export a file from the Cloud sandbox into chat attachments.",
            vec![
                ("path", "string"),
                ("name", "string"),
                ("contentType", "string"),
            ],
        ),
    ]
}

fn local_tool_schema(tool: &dyn Tool) -> Value {
    let definition = tool.definition();
    json!({
        "type": "function",
        "function": {
            "name": definition.name,
            "description": definition.description,
            "parameters": definition.parameters_schema,
        }
    })
}

fn tool_schema(name: &str, description: &str, properties: Vec<(&str, &str)>) -> Value {
    let mut props = serde_json::Map::new();
    let mut required = Vec::new();
    for (property, kind) in properties {
        props.insert(property.to_string(), json!({ "type": kind }));
        required.push(Value::String(property.to_string()));
    }
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": props,
                "required": required
            }
        }
    })
}
