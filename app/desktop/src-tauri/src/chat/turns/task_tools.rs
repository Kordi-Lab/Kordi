use super::*;

fn stored_tool_is_model_task_tool(
    tool: &kordi_cli::desktop_runtime::DesktopChatStoredTool,
) -> bool {
    let name = tool.name.trim().to_lowercase();
    name == "task_operator" || name == "update_plan" || tool.is_error
}

fn snapshot_tool_is_model_task_tool(tool: &DesktopChatToolSnapshot) -> bool {
    let name = tool.name.trim().to_lowercase();
    name == "task_operator" || name == "update_plan" || tool.is_error
}

pub(crate) fn turn_snapshot_has_model_task_tools(tools: &[DesktopChatToolSnapshot]) -> bool {
    tools.iter().any(snapshot_tool_is_model_task_tool)
}

pub(crate) fn desktop_task_tools_from_messages(
    messages: &[kordi_cli::desktop_runtime::DesktopChatMessage],
) -> Vec<DesktopChatToolSnapshot> {
    let mut tools = Vec::new();
    for message in messages.iter().rev() {
        if message.role == "user" {
            break;
        }
        if message.role != "assistant" {
            continue;
        }
        for tool in message
            .tools
            .iter()
            .filter(|tool| stored_tool_is_model_task_tool(tool))
            .rev()
        {
            tools.push(DesktopChatToolSnapshot {
                id: tool.id.clone(),
                name: tool.name.clone(),
                status: tool.status.clone(),
                arguments: tool.arguments.clone(),
                live_output: tool.live_output.clone(),
                result_text: tool.result_text.clone(),
                detail: tool.detail.clone(),
                artifact_path: tool.artifact_path.clone(),
                tool_layer: tool.tool_layer.clone(),
                is_error: tool.is_error,
            });
        }
    }
    tools.reverse();
    tools
}
