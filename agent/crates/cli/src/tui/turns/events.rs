use super::*;

impl TuiController {
    pub(super) fn handle_turn_event(&mut self, event: TurnEvent) {
        match event {
            TurnEvent::TextStart => {}
            TurnEvent::TurnStart { turn_index } => {
                self.send_command(TuiCommand::TurnStart { turn_index });
            }
            TurnEvent::TextDelta(text) => {
                self.send_command(TuiCommand::TextDelta(text));
            }
            TurnEvent::ThinkingDelta(text) => {
                self.send_command(TuiCommand::ThinkingDelta(text));
            }
            TurnEvent::ToolCallStart { id, name } => {
                self.send_command(TuiCommand::ToolCallStart { id, name });
            }
            TurnEvent::ToolCallDelta { id, args } => {
                self.send_command(TuiCommand::ToolCallDelta { id, args });
            }
            TurnEvent::ToolExecuting { id } => {
                self.send_command(TuiCommand::ToolExecuting { id });
            }
            TurnEvent::ToolOutputDelta { id, chunk } => {
                self.send_command(TuiCommand::ToolOutputDelta { id, chunk });
            }
            TurnEvent::ToolResult {
                id,
                name,
                content,
                details,
                artifact_path,
                is_error,
            } => {
                self.send_command(TuiCommand::ToolResult {
                    id,
                    name,
                    content,
                    details,
                    artifact_path,
                    is_error,
                });
            }
            TurnEvent::TurnEnd => {
                self.retry_status = None;
                self.send_command(TuiCommand::TurnEnd);
                self.publish_status();
            }
            TurnEvent::ContextOverflow { message } => {
                self.send_command(TuiCommand::PushNote {
                    level: TuiNoteLevel::Warning,
                    text: message,
                });
            }
            TurnEvent::AutoRetryStart {
                attempt,
                max_attempts,
                delay_ms,
                error_message,
            } => {
                self.retry_status = Some(format!(
                    "Retrying ({attempt}/{max_attempts}) in {}s... {error_message}",
                    ((delay_ms + 500) / 1000).max(1)
                ));
                self.publish_status();
            }
            TurnEvent::AutoRetryEnd => {
                self.retry_status = None;
                self.publish_status();
            }
            TurnEvent::AutoCompactionStart => {
                self.auto_compaction_in_progress = true;
                self.publish_footer();
                self.publish_status();
            }
            TurnEvent::Done { .. } => {}
            TurnEvent::Status(message) => {
                let is_auto_success = is_auto_compaction_status(&message);
                let is_auto_terminal = is_auto_compaction_terminal_status(&message);
                if is_auto_terminal {
                    self.auto_compaction_in_progress = false;
                }
                if is_auto_success {
                    if let Err(err) = self.rebuild_current_transcript() {
                        self.send_command(TuiCommand::PushNote {
                            level: TuiNoteLevel::Error,
                            text: format!("Failed to rebuild transcript after compaction: {err}"),
                        });
                    } else {
                        self.publish_footer();
                    }
                } else if is_auto_terminal {
                    self.publish_footer();
                }
                self.publish_status();
                if !is_auto_success {
                    self.send_command(TuiCommand::PushNote {
                        level: TuiNoteLevel::Status,
                        text: message,
                    });
                }
            }
            TurnEvent::Error(message) => {
                self.auto_compaction_in_progress = false;
                self.retry_status = None;
                self.publish_footer();
                self.publish_status();
                self.send_command(TuiCommand::TurnError {
                    message: message.clone(),
                });
                self.send_command(TuiCommand::PushNote {
                    level: TuiNoteLevel::Error,
                    text: message,
                });
            }
        }
    }
}
