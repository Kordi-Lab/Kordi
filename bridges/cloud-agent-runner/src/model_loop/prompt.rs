use kordi_tools::{web_fetch::WebFetchTool, web_search::WebSearchTool, Tool};
use serde_json::{json, Value};

pub fn cloud_sandbox_system_prompt() -> &'static str {
    "You are running in Kordi Cloud fallback. \
You may work only inside the Cloud sandbox workspace. You cannot read owner laptop files, \
owner-local services, localhost/private networks, other users' data, or unsynced private resources. \
Do not ask for approval prompts; unavailable actions should be explained as runtime boundaries. \
Export artifacts only when explicitly useful to share; unexported sandbox files remain private. \
Never put file paths in replies to a group; name files by their file name."
}

/// Guidance for `create_document`, only for a run whose lease carries it, so
/// the prompt never asks for a tool the model does not have (issue 1808).
pub fn group_document_guidance(
    tools: &[kordi_tools::connector_tools::ConnectorToolDescriptor],
) -> Option<&'static str> {
    tools
        .iter()
        .any(|tool| tool.is_group_document_create())
        .then_some(
            "When someone in this group asks for a document, note, report, or plan, create it \
with create_document (Markdown, or HTML for a page) so it is attached to your reply and saved in \
the group's Artifacts for every member; do not only write it to a sandbox file. Write the \
complete document first, then call create_document once per document with a specific title and \
the finished content.",
        )
}

pub fn tool_catalog() -> Vec<Value> {
    vec![
        serde_json::json!({
            "type":"function", "function": {
                "name":"task_operator", "description":"Create a real independent execution subsession of this Agent, or inspect one by its exact sessionId. After a successful spawn, briefly acknowledge in the parent chat and end the parent turn; do not wait or copy the child result here.",
                "parameters":{"type":"object","properties":{
                    "action":{"type":"string","enum":["spawn","inspect"]},
                    "taskName":{"type":"string","description":"Stable ASCII letters, numbers, and underscores; reuse the same name when retrying a spawn."},
                    "taskTitle":{"type":"string"}, "message":{"type":"string","description":"Public task instructions posted as this Agent to all parent-chat members. Never include private Ask Agent context, credentials, or system instructions."},
                    "forkTurns":{"type":"string","enum":["none"]},
                    "writeScope":{"type":"array","items":{"type":"string"}},
                    "sessionId":{"type":"string"}
                },"required":["action"]}
            }
        }),
        tool_schema(
            "read",
            "Read a UTF-8 text file or image inside the Cloud sandbox. Images must be PNG, JPEG, WebP, or GIF, at most 4 MiB, and within decoding limits; actual image content is returned to the model.",
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
        context_tool_schema(&kordi_tools::session_observation::SearchSessionsTool),
        context_tool_schema(&kordi_tools::session_observation::ReadSessionTool),
        local_tool_schema(&kordi_tools::calendar::ReadCalendarTool),
        local_tool_schema(&WebSearchTool),
        local_tool_schema(&WebFetchTool),
        local_tool_schema(&kordi_tools::reflection_tool::ReflectionTool),
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

fn context_tool_schema(tool: &dyn Tool) -> Value {
    let mut schema = local_tool_schema(tool);
    schema["function"]["parameters"]["properties"]["beforeSequence"] = serde_json::json!({
        "type": "integer", "minimum": 1,
        "description": "Continue an older page using nextBeforeSequence returned by the previous call. Search examines a bounded page; continue only while older matches are still needed, and stop when the result note says there are no more matches."
    });
    schema
}

#[cfg(test)]
mod tests {
    use kordi_tools::connector_tools::{
        ConnectorToolDescriptor, ConnectorToolGroup, CREATE_DOCUMENT_TOOL, DOCUMENT_TOOLS_PROVIDER,
    };

    fn tool(name: &str) -> ConnectorToolDescriptor {
        ConnectorToolDescriptor {
            connector_id: "kordi-documents".into(),
            provider: DOCUMENT_TOOLS_PROVIDER.into(),
            name: name.into(),
            group: ConnectorToolGroup::Act,
            description: String::new(),
            input_schema: serde_json::json!({ "type": "object" }),
        }
    }

    #[test]
    fn document_guidance_follows_the_lease() {
        let base = super::cloud_sandbox_system_prompt();
        assert!(!base.contains("create_document"));
        assert!(base.contains("Never put file paths in replies to a group"));
        let guidance = super::group_document_guidance(&[tool(CREATE_DOCUMENT_TOOL)]).unwrap();
        assert!(guidance.contains("group's Artifacts") && guidance.contains("once per document"));
        assert!(super::group_document_guidance(&[tool("read_document")]).is_none());
        assert!(super::group_document_guidance(&[]).is_none());
    }
}
