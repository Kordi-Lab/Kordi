use super::*;
use crate::tui::streaming::ToolCallState;
use crate::tui::types::TuiCommand;

impl TuiState {
    pub(super) fn apply_shell_command(&mut self, command: TuiCommand) -> RenderIntent {
        match command {
            TuiCommand::SetStatusLine(status) => {
                self.status_line = status;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::SetFooter(footer) => {
                self.footer = footer;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::SetInputMonitor(text) => {
                self.input_monitor = text;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::SetTranscript(transcript) => {
                self.reset_transcript_state();
                self.transcript = transcript;
                self.projection_dirty = true;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::SetTranscriptWithToolStates {
                transcript,
                tool_states,
            } => {
                self.reset_transcript_state();
                self.transcript = transcript;
                self.all_tool_states = tool_states
                    .into_iter()
                    .map(|(id, tool)| {
                        (
                            id,
                            ToolCallState {
                                name: tool.name,
                                raw_args: tool.raw_args,
                                tool_use_id: tool.tool_use_id,
                                tool_result_id: tool.tool_result_id,
                                execution_started: false,
                                started_tick: None,
                                started_at: None,
                                finished_duration_ms: None,
                                live_output: String::new(),
                                result_content: tool.result_content,
                                result_details: tool.result_details,
                                artifact_path: tool.artifact_path,
                                is_error: tool.is_error,
                            },
                        )
                    })
                    .collect();
                self.restore_historical_tool_rendering();
                self.projection_dirty = true;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::SetInput(input) => {
                self.input = input;
                self.cursor = self.input.len();
                self.slash_menu = None;
                self.select_menu = None;
                self.tree_menu = None;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::SetLocalActionActive(active) => {
                self.local_action_active = active;
                if active {
                    if self.local_action_started_tick.is_none() {
                        self.local_action_started_tick = Some(self.tick_count);
                    }
                    if self.local_action_started_at.is_none() {
                        self.local_action_started_at = Some(std::time::Instant::now());
                    }
                } else {
                    self.local_action_started_tick = None;
                    self.local_action_started_at = None;
                    self.queued_submission_previews.clear();
                    self.editing_queued_messages = false;
                }
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::OpenAuthDialog(dialog) | TuiCommand::UpdateAuthDialog(dialog) => {
                self.approval_dialog = None;
                self.auth_dialog = Some(dialog);
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::CloseAuthDialog => {
                self.auth_dialog = None;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::OpenApprovalDialog(dialog) => {
                self.auth_dialog = None;
                self.approval_dialog = Some(dialog);
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::CloseApprovalDialog => {
                self.approval_dialog = None;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::SetExtraSlashItems(items) => {
                self.extra_slash_items = items;
                self.slash_menu = None;
                self.update_slash_menu();
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::OpenSelectMenu {
                menu_id,
                title,
                items,
                selected_value,
            } => {
                self.slash_menu = None;
                self.tree_menu = None;
                self.select_menu = Some(TuiSelectMenuState::new(
                    menu_id,
                    title,
                    items,
                    selected_value,
                ));
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::OpenTreeMenu {
                menu_id,
                title: _,
                tree,
                entries,
                active_leaf,
                selected_value,
            } => {
                self.slash_menu = None;
                self.select_menu = None;
                self.tree_menu = Some(super::super::menus::TuiTreeMenuState::new(
                    menu_id,
                    tree,
                    entries,
                    active_leaf,
                    selected_value,
                    self.tree_menu_max_visible(),
                ));
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::CloseSelectMenu => {
                self.select_menu = None;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::CloseTreeMenu => {
                self.tree_menu = None;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::SetColorTheme(theme) => {
                self.color_theme = theme;
                self.spinner.set_color_theme(theme);
                self.projection_dirty = true;
                self.dirty = true;
                RenderIntent::Render
            }
            _ => unreachable!("command routed to the wrong handler"),
        }
    }
}
