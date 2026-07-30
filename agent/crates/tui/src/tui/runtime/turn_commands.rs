use super::*;
use crate::tui::streaming::ActiveTurnState;
use crate::tui::types::{TuiCommand, TuiNoteLevel};
use crate::tui::{BlockKind, NewBlock};

impl TuiState {
    pub(super) fn apply_turn_command(&mut self, command: TuiCommand) -> RenderIntent {
        match command {
            TuiCommand::PushNote { level, text } => {
                let title = match level {
                    TuiNoteLevel::Status => "status",
                    TuiNoteLevel::Highlight => "highlight",
                    TuiNoteLevel::Warning => "warning",
                    TuiNoteLevel::Error => "error",
                };
                self.transcript.append_root_block(
                    NewBlock::new(BlockKind::SystemNote, title).with_content(text),
                );
                self.projection_dirty = true;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::TurnStart { turn_index } => {
                self.active_turn = None;
                self.spinner
                    .set_mode(super::super::spinner::SpinnerMode::Requesting);
                self.spinner.notify_activity();
                self.status_line = "Requesting response...".to_string();
                let root_id = self.transcript.append_root_block(
                    NewBlock::new(
                        BlockKind::AssistantMessage,
                        format!("turn {} • streaming", turn_index + 1),
                    )
                    .with_expandable(true),
                );
                self.active_turn = Some(ActiveTurnState::new(root_id, turn_index, self.tick_count));
                self.projection_dirty = true;
                self.dirty = true;
                RenderIntent::Render
            }
            TuiCommand::TextDelta(text) => {
                self.spinner.notify_activity();
                self.spinner
                    .set_mode(super::super::spinner::SpinnerMode::Thinking);
                if text.is_empty() {
                    return RenderIntent::None;
                }
                self.status_line = "Writing...".to_string();
                let Ok(content_id) = self.ensure_assistant_content_block() else {
                    return RenderIntent::None;
                };
                let _ = self.transcript.append_streamed_content(content_id, text);
                self.projection_dirty = true;
                self.dirty = true;
                RenderIntent::Schedule
            }
            TuiCommand::ThinkingDelta(text) => {
                self.spinner.notify_activity();
                self.spinner
                    .set_mode(super::super::spinner::SpinnerMode::Thinking);
                if text.is_empty() {
                    return RenderIntent::None;
                }
                self.status_line = "Thinking...".to_string();
                let Ok(thinking_id) = self.ensure_thinking_block() else {
                    return RenderIntent::None;
                };
                let _ = self.transcript.append_streamed_content(thinking_id, text);
                self.projection_dirty = true;
                self.dirty = true;
                RenderIntent::Schedule
            }
            TuiCommand::TurnEnd => {
                self.force_full_repaint = true;
                self.finish_active_turn("complete");
                RenderIntent::Render
            }
            TuiCommand::TurnAborted => {
                self.force_full_repaint = true;
                self.finish_active_turn("aborted");
                RenderIntent::Render
            }
            TuiCommand::TurnError { message } => {
                self.status_line = message;
                self.force_full_repaint = true;
                self.finish_active_turn("error");
                RenderIntent::Render
            }
            _ => unreachable!("command routed to the wrong handler"),
        }
    }
}
