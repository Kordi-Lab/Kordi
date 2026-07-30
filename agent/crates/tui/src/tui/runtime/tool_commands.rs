use super::*;
use crate::tui::format_tool_call_title;
use crate::tui::streaming::ToolCallState;
use crate::tui::types::TuiCommand;
use crate::tui::{BlockKind, NewBlock};

impl TuiState {
    pub(super) fn apply_tool_command(&mut self, command: TuiCommand) -> RenderIntent {
        match command {
            TuiCommand::ToolCallStart { id, name } => {
                self.spinner.notify_activity();
                self.spinner
                    .set_mode(super::super::spinner::SpinnerMode::Thinking);
                let Some(turn_root_id) = self.ensure_active_turn_root() else {
                    return RenderIntent::None;
                };
                let initial_title = format_tool_call_title(&name, "");
                self.status_line = format!("Preparing {initial_title}...");
                let Ok(tool_use_id) = self.transcript.append_child_block(
                    turn_root_id,
                    NewBlock::new(BlockKind::ToolUse, initial_title).with_expandable(true),
                ) else {
                    return RenderIntent::None;
                };
                if let Some(active_turn) = self.active_turn.as_mut() {
                    active_turn.tools.insert(
                        id.clone(),
                        ToolCallState {
                            name,
                            raw_args: String::new(),
                            tool_use_id,
                            tool_result_id: None,
                            execution_started: false,
                            started_tick: None,
                            started_at: None,
                            finished_duration_ms: None,
                            live_output: String::new(),
                            result_content: None,
                            result_details: None,
                            artifact_path: None,
                            is_error: false,
                        },
                    );
                }
                self.projection_dirty = true;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::ToolCallDelta { id, args } => {
                self.spinner.notify_activity();
                self.spinner
                    .set_mode(super::super::spinner::SpinnerMode::Thinking);
                if args.is_empty() {
                    return RenderIntent::None;
                }
                let display_name = match self.tool_call_state_mut(&id) {
                    Some(tool) => {
                        tool.raw_args.push_str(&args);
                        format_tool_call_title(&tool.name, &tool.raw_args)
                    }
                    None => return RenderIntent::None,
                };
                self.status_line = format!("Preparing {display_name}...");
                self.refresh_tool_rendering(&id);
                RenderIntent::Render
            }
            TuiCommand::ToolExecuting { id } => {
                self.spinner.notify_activity();
                let tick_count = self.tick_count;
                let Some(tool) = self.tool_call_state_mut(&id) else {
                    return RenderIntent::None;
                };
                tool.execution_started = true;
                if tool.started_tick.is_none() {
                    tool.started_tick = Some(tick_count);
                }
                if tool.started_at.is_none() {
                    tool.started_at = Some(std::time::Instant::now());
                }
                self.refresh_tool_rendering(&id);
                if let Some(message) = self.running_tool_status_message() {
                    self.status_line = message;
                }
                RenderIntent::Render
            }
            TuiCommand::ToolOutputDelta { id, chunk } => {
                if chunk.is_empty() {
                    return RenderIntent::None;
                }
                self.spinner.notify_activity();
                let Some(tool) = self.tool_call_state_mut(&id) else {
                    return RenderIntent::None;
                };
                tool.append_live_output(&chunk);
                self.refresh_tool_rendering(&id);
                if let Some(message) = self.running_tool_status_message() {
                    self.status_line = message;
                }
                RenderIntent::Schedule
            }
            TuiCommand::ToolResult {
                id,
                name: _,
                content,
                details,
                artifact_path,
                is_error,
            } => {
                self.spinner.notify_activity();
                let tick_count = self.tick_count;
                let Some(tool) = self.tool_call_state_mut(&id) else {
                    return RenderIntent::None;
                };
                tool.live_output.clear();
                tool.result_content = Some(content);
                tool.result_details = details;
                tool.artifact_path = artifact_path;
                tool.is_error = is_error;
                if tool.finished_duration_ms.is_none() {
                    let duration_from_details = tool
                        .result_details
                        .as_ref()
                        .and_then(|details| details.get("durationMs"))
                        .and_then(|value| value.as_u64());
                    let duration_from_instant = tool
                        .started_at
                        .map(|started_at| started_at.elapsed().as_millis() as u64);
                    let duration_from_ticks = tool
                        .started_tick
                        .map(|started| tick_count.saturating_sub(started) * 80);
                    tool.finished_duration_ms = duration_from_details
                        .or(duration_from_instant)
                        .or(duration_from_ticks);
                }
                self.refresh_tool_rendering(&id);
                if let Some(message) = self.running_tool_status_message() {
                    self.status_line = message;
                }
                if let Some(tool) = self.tool_call_state(&id).cloned() {
                    self.all_tool_states.insert(id.clone(), tool);
                }
                self.force_full_repaint = true;
                RenderIntent::Render
            }
            _ => unreachable!("command routed to the wrong handler"),
        }
    }
}
