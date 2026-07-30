use super::*;
use crate::tui::streaming::{ToolCallState, format_elapsed_ms};
use crate::tui::types::{TuiCommand, TuiMode, TuiSearchState};
use crate::tui::{format_tool_call_content, format_tool_result_content};

impl TuiState {
    pub fn apply_command(&mut self, command: TuiCommand) -> RenderIntent {
        match command {
            command @ (TuiCommand::SetStatusLine(_)
            | TuiCommand::SetFooter(_)
            | TuiCommand::SetInputMonitor(_)
            | TuiCommand::SetTranscript(_)
            | TuiCommand::SetTranscriptWithToolStates { .. }
            | TuiCommand::SetInput(_)
            | TuiCommand::SetLocalActionActive(_)
            | TuiCommand::OpenAuthDialog(_)
            | TuiCommand::UpdateAuthDialog(_)
            | TuiCommand::CloseAuthDialog
            | TuiCommand::OpenApprovalDialog(_)
            | TuiCommand::CloseApprovalDialog
            | TuiCommand::SetExtraSlashItems(_)
            | TuiCommand::OpenSelectMenu { .. }
            | TuiCommand::OpenTreeMenu { .. }
            | TuiCommand::CloseSelectMenu
            | TuiCommand::CloseTreeMenu
            | TuiCommand::SetColorTheme(_)) => self.apply_shell_command(command),
            command @ (TuiCommand::PushNote { .. }
            | TuiCommand::TurnStart { .. }
            | TuiCommand::TextDelta(_)
            | TuiCommand::ThinkingDelta(_)
            | TuiCommand::TurnEnd
            | TuiCommand::TurnAborted
            | TuiCommand::TurnError { .. }) => self.apply_turn_command(command),
            command @ (TuiCommand::ToolCallStart { .. }
            | TuiCommand::ToolCallDelta { .. }
            | TuiCommand::ToolExecuting { .. }
            | TuiCommand::ToolOutputDelta { .. }
            | TuiCommand::ToolResult { .. }) => self.apply_tool_command(command),
        }
    }

    pub(super) fn reset_transcript_state(&mut self) {
        self.active_turn = None;
        self.all_tool_states.clear();
        self.expanded_tool_blocks.clear();
        self.focused_block = None;
        self.search = TuiSearchState::default();
        self.mode = TuiMode::Normal;
        self.viewport.auto_follow = true;
        self.selection_anchor_row = None;
        self.selection_anchor_col = None;
        self.selection_focus_row = None;
        self.selection_focus_col = None;
        self.tree_menu = None;
    }

    pub(crate) fn mode_help_text(&self) -> String {
        match self.mode {
            TuiMode::Normal => String::new(),
            TuiMode::Transcript => {
                "tool expand mode • j/k or ↑/↓ select tool call • Enter expand/collapse • Esc returns"
                    .to_string()
            }
        }
    }

    pub(crate) fn current_layout(&self) -> TuiLayout {
        let input_inner_width = self.size.width.max(1) as usize;
        let requested_input_lines = if let Some(dialog) = self.approval_dialog.as_ref() {
            crate::tui::frame::measure_approval_input(dialog, input_inner_width)
        } else {
            let (visible_input, visible_cursor) =
                crate::tui::frame::visible_input_text(&self.input, self.cursor, &self.cwd);
            crate::tui::frame::attachment_line_count(self, input_inner_width)
                + measure_input(&visible_input, visible_cursor, input_inner_width)
                    .lines
                    .len()
        };
        compute_layout_with_footer(
            self.size,
            requested_input_lines,
            self.requested_footer_height(),
        )
    }

    pub(crate) fn requested_footer_height(&self) -> u16 {
        if self.tree_menu.is_some() {
            self.size
                .height
                .saturating_sub(if self.size.height >= 8 { 4 } else { 1 })
        } else if let Some(menu) = self.select_menu.as_ref() {
            menu.rendered_height()
        } else if let Some(menu) = self.slash_menu.as_ref() {
            menu.rendered_height()
        } else if let Some(menu) = self.at_file_menu.as_ref() {
            menu.rendered_height()
        } else if self.size.height >= 14 {
            2
        } else {
            0
        }
    }

    pub(super) fn tree_menu_max_visible(&self) -> usize {
        self.size
            .height
            .saturating_sub(if self.size.height >= 8 { 8 } else { 3 }) as usize
    }

    pub(crate) fn toggle_tool_output_expansion(&mut self) {
        let block_id = match self.focused_block {
            Some(id) => id,
            None => {
                self.status_line = crate::ui_hints::NO_BLOCK_FOCUSED_HINT.to_string();
                self.dirty = true;
                return;
            }
        };

        let tool_use_id = if self
            .transcript
            .block(block_id)
            .is_some_and(|block| block.kind == super::super::transcript::BlockKind::ToolUse)
        {
            block_id
        } else if let Some(parent_id) = self
            .transcript
            .block(block_id)
            .and_then(|block| block.parent)
        {
            if self
                .transcript
                .block(parent_id)
                .is_some_and(|block| block.kind == super::super::transcript::BlockKind::ToolUse)
            {
                parent_id
            } else {
                self.status_line = "not a tool block".to_string();
                self.dirty = true;
                return;
            }
        } else {
            self.status_line = "not a tool block".to_string();
            self.dirty = true;
            return;
        };

        let should_expand = !self.expanded_tool_blocks.contains(&tool_use_id);
        if should_expand {
            self.expanded_tool_blocks.insert(tool_use_id);
        } else {
            self.expanded_tool_blocks.remove(&tool_use_id);
        }

        if let Some(active_turn) = self.active_turn.as_ref() {
            let ids = active_turn
                .tools
                .iter()
                .filter(|(_, tool)| tool.tool_use_id == tool_use_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in ids {
                self.refresh_tool_rendering(&id);
            }
        }

        let historical_tool_ids = self
            .all_tool_states
            .iter()
            .filter(|(_, tool)| tool.tool_use_id == tool_use_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for tool_id in historical_tool_ids {
            self.refresh_historical_tool_rendering(&tool_id);
        }
        self.projection_dirty = true;
        self.dirty = true;
    }

    pub(super) fn restore_historical_tool_rendering(&mut self) {
        let historical_tool_ids = self.all_tool_states.keys().cloned().collect::<Vec<_>>();
        for tool_id in historical_tool_ids {
            self.refresh_historical_tool_rendering(&tool_id);
        }
    }

    fn refresh_historical_tool_rendering(&mut self, tool_id: &str) {
        let Some(tool) = self.all_tool_states.get(tool_id).cloned() else {
            return;
        };
        let expanded = self.expanded_tool_blocks.contains(&tool.tool_use_id);
        let _ = self.transcript.replace_content(
            tool.tool_use_id,
            format_tool_call_content(&tool.name, &tool.raw_args, expanded),
        );
        if let Some(formatted) = self.format_historical_tool_result(&tool, expanded)
            && let Some(result_id) = tool.tool_result_id
        {
            let _ = self
                .transcript
                .replace_tool_result_content(result_id, formatted);
        }
    }

    fn format_historical_tool_result(
        &self,
        tool: &ToolCallState,
        expanded: bool,
    ) -> Option<String> {
        let content = tool.result_content.as_ref()?;
        let elapsed = tool
            .result_details
            .as_ref()
            .and_then(|details| details.get("durationMs"))
            .and_then(|value| value.as_u64())
            .map(format_elapsed_ms);
        Some(if tool.name == "bash" {
            format_bash_visual_result_content(BashVisualResult {
                label: "Took",
                content,
                details: tool.result_details.as_ref(),
                artifact_path: tool.artifact_path.as_deref(),
                is_error: tool.is_error,
                expanded,
                total_width: self.size.width as usize,
                elapsed: elapsed.as_deref(),
            })
        } else {
            format_tool_result_content(
                &tool.name,
                content,
                tool.result_details.clone(),
                tool.artifact_path.clone(),
                tool.is_error,
                expanded,
            )
        })
    }

    pub(crate) fn is_tool_block_expanded(&self, tool_use_id: BlockId) -> bool {
        self.expanded_tool_blocks.contains(&tool_use_id)
    }
}
