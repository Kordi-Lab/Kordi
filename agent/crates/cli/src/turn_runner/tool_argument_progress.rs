use kordi_provider::StreamEvent;
use std::collections::HashMap;

// JSON formatting outside strings should not occupy an entire generation.
// Preserve arbitrary whitespace in string values such as file contents.
const MAX_FORMATTING_RUN: usize = 8 * 1024;

#[derive(Default)]
struct ArgumentState {
    in_string: bool,
    escaped: bool,
    formatting_run: usize,
}

#[derive(Default)]
pub(super) struct ToolArgumentProgress {
    calls: HashMap<String, ArgumentState>,
}

impl ToolArgumentProgress {
    pub(super) fn observe(&mut self, event: &StreamEvent) -> Result<(), ()> {
        match event {
            StreamEvent::ToolCallDelta {
                id,
                arguments_delta,
            } => {
                let state = self.calls.entry(id.clone()).or_default();
                for byte in arguments_delta.bytes() {
                    if state.in_string {
                        if state.escaped {
                            state.escaped = false;
                        } else if byte == b'\\' {
                            state.escaped = true;
                        } else if byte == b'"' {
                            state.in_string = false;
                        }
                    } else if matches!(byte, b' ' | b'\t' | b'\r' | b'\n') {
                        state.formatting_run += 1;
                        if state.formatting_run > MAX_FORMATTING_RUN {
                            return Err(());
                        }
                    } else {
                        state.formatting_run = 0;
                        state.in_string = byte == b'"';
                    }
                }
            }
            StreamEvent::ToolCallEnd { id } => {
                self.calls.remove(id);
            }
            _ => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(id: &str, text: &str) -> StreamEvent {
        StreamEvent::ToolCallDelta {
            id: id.into(),
            arguments_delta: text.into(),
        }
    }

    #[test]
    fn stops_whitespace_run_across_stream_chunks_and_interleaved_calls() {
        let mut guard = ToolArgumentProgress::default();
        guard.observe(&delta("slow", "{\n")).unwrap();
        for _ in 0..7 {
            guard.observe(&delta("slow", &" ".repeat(1024))).unwrap();
            guard.observe(&delta("other", "{}")).unwrap();
        }
        assert!(guard.observe(&delta("slow", &"\t".repeat(1024))).is_err());
    }

    #[test]
    fn preserves_large_string_values_escaped_quotes_and_normal_json_formatting() {
        let mut guard = ToolArgumentProgress::default();
        guard
            .observe(&delta("write", "{\n  \"content\": \"\\"))
            .unwrap();
        guard.observe(&delta("write", "\"")).unwrap();
        guard
            .observe(&delta("write", &" ".repeat(MAX_FORMATTING_RUN * 4)))
            .unwrap();
        guard.observe(&delta("write", "\"\n}\n")).unwrap();
        guard
            .observe(&StreamEvent::ToolCallEnd { id: "write".into() })
            .unwrap();
        guard
            .observe(&delta("write", &" ".repeat(MAX_FORMATTING_RUN)))
            .unwrap();
        assert!(guard.observe(&delta("write", " ")).is_err());
    }
}
