//! One start per OMP tool call, whichever side reports it first.
//!
//! The worker sends a host tool call before its `tool_start` event, and the
//! host may begin executing (and report the call as running) before that event
//! is read. A start announced by the host lets the running state and output of
//! a silent long command, such as a disk-usage scan, show as soon as it runs.

use std::collections::HashSet;
use std::sync::Mutex;

use crate::turn_runner::TurnEvent;

#[derive(Default)]
pub(super) struct ToolStarts(Mutex<HashSet<String>>);

impl ToolStarts {
    /// The start and arguments of a call, the first time it is announced.
    pub(super) fn announce(&self, id: &str, name: &str, arguments: String) -> Vec<TurnEvent> {
        let first = self
            .0
            .lock()
            .map(|mut started| started.insert(id.to_string()))
            .unwrap_or(false);
        if !first {
            return Vec::new();
        }
        vec![
            TurnEvent::ToolCallStart {
                id: id.to_string(),
                name: name.to_string(),
            },
            TurnEvent::ToolCallDelta {
                id: id.to_string(),
                args: arguments,
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn starts(events: &[TurnEvent]) -> Vec<(String, String)> {
        events
            .iter()
            .filter_map(|event| match event {
                TurnEvent::ToolCallStart { id, name } => Some((id.clone(), name.clone())),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_host_call_before_its_start_event_is_announced_once_with_its_arguments() {
        let tool_starts = ToolStarts::default();
        let input = r#"{"command":"du -sh ~/Library"}"#.to_string();

        // The worker's call reaches the host first; the event follows.
        let from_host = tool_starts.announce("call-1", "bash", input.clone());
        let from_event = tool_starts.announce("call-1", "bash", input.clone());

        assert_eq!(starts(&from_host), vec![("call-1".into(), "bash".into())]);
        assert!(matches!(
            &from_host[1],
            TurnEvent::ToolCallDelta { id, args } if id == "call-1" && *args == input
        ));
        assert!(from_event.is_empty(), "the start must not repeat");
    }

    #[test]
    fn an_event_start_before_the_host_call_is_not_repeated_by_the_host() {
        let tool_starts = ToolStarts::default();
        let first = tool_starts.announce("call-2", "read", "{}".into());
        let second = tool_starts.announce("call-2", "read", "{}".into());
        assert_eq!(first.len(), 2);
        assert!(second.is_empty());
        assert_eq!(
            tool_starts.announce("call-3", "read", "{}".into()).len(),
            2,
            "every call starts once"
        );
    }
}
