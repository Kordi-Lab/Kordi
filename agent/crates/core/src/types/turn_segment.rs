//! Ordered, user-visible content within a single agent request.
//! Tool entries reference the existing tool records; reasoning stays separate.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TurnSegment {
    Text {
        id: String,
        text: String,
        #[serde(default)]
        revision: u64,
    },
    Tool {
        id: String,
        #[serde(rename = "toolId")]
        tool_id: String,
    },
}

impl TurnSegment {
    pub fn start_text(segments: &mut Vec<Self>) {
        // Empty model messages (for example thinking-only messages) do not
        // create visible rows, but do establish a boundary for future deltas.
        if matches!(segments.last(), Some(Self::Text { text, .. }) if text.is_empty()) {
            return;
        }
        segments.push(Self::Text {
            id: format!("text:{}", segments.len()),
            text: String::new(),
            revision: 0,
        });
    }

    pub fn append_text(segments: &mut Vec<Self>, delta: &str) {
        if delta.is_empty() {
            return;
        }
        if !matches!(segments.last(), Some(Self::Text { .. })) {
            Self::start_text(segments);
        }
        if let Some(Self::Text { text, revision, .. }) = segments.last_mut() {
            text.push_str(delta);
            *revision = revision.saturating_add(1);
        }
    }

    pub fn push_tool(segments: &mut Vec<Self>, tool_id: &str) {
        if segments
            .iter()
            .any(|segment| matches!(segment, Self::Tool { tool_id: id, .. } if id == tool_id))
        {
            return;
        }
        segments.push(Self::Tool {
            id: format!("tool:{tool_id}"),
            tool_id: tool_id.to_owned(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_commentary_boundaries_and_deduplicates_tool_starts() {
        let mut segments = Vec::new();
        TurnSegment::append_text(&mut segments, "I will inspect.");
        TurnSegment::push_tool(&mut segments, "read-1");
        TurnSegment::push_tool(&mut segments, "read-1");
        TurnSegment::append_text(&mut segments, "Found the issue.");
        TurnSegment::push_tool(&mut segments, "edit-1");
        TurnSegment::start_text(&mut segments);
        TurnSegment::append_text(&mut segments, "Fixed.");
        let wire = serde_json::to_value(&segments).unwrap();
        assert_eq!(wire[1]["toolId"], "read-1");
        assert_eq!(wire[2]["text"], "Found the issue.");
        assert_eq!(segments.len(), 5);
        assert_eq!(
            serde_json::from_value::<Vec<TurnSegment>>(wire).unwrap(),
            segments
        );
    }
}
