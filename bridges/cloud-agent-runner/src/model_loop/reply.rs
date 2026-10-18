//! The text a cloud run replies with. A model can end its turn on a tool call
//! with no closing words. The server refuses an empty reply, so the runner,
//! the one place that sees every tool result, names what the run did instead:
//! the documents it created, or the last tool's summary, or a short line. A
//! run whose last tool failed, or that ran no tool, fails rather than claiming
//! success.

use serde_json::Value;

use super::ModelLoopError;

/// The reply when the run's last tool succeeded and left nothing to name.
pub(crate) const TOOL_ONLY_REPLY: &str = "Done.";

/// Tool summaries longer than this are not a one-line reply.
const SUMMARY_MAX_CHARS: usize = 240;

/// What one tool call returned to the model.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ToolOutcome {
    pub name: String,
    pub ok: bool,
    pub content: Value,
}

impl ToolOutcome {
    pub(crate) fn new(name: &str, result: &Result<Value, Value>) -> Self {
        let (ok, content) = match result {
            Ok(content) => (true, content.clone()),
            Err(content) => (false, content.clone()),
        };
        Self {
            name: name.to_string(),
            ok,
            content,
        }
    }

    fn result_object(&self) -> Option<serde_json::Map<String, Value>> {
        match &self.content {
            Value::Object(object) => Some(object.clone()),
            Value::String(text) => match serde_json::from_str(text) {
                Ok(Value::Object(object)) => Some(object),
                _ => None,
            },
            _ => None,
        }
    }

    fn created_document_title(&self) -> Option<String> {
        if self.name != "create_document" || !self.ok {
            return None;
        }
        let result = self.result_object()?;
        if result.get("created") == Some(&Value::Bool(false)) {
            return None;
        }
        ["title", "fileName"]
            .iter()
            .filter_map(|key| result.get(*key).and_then(Value::as_str))
            .map(str::trim)
            .find(|value| !value.is_empty())
            .map(str::to_string)
    }

    fn summary(&self) -> Option<String> {
        let result = self.result_object()?;
        let summary = result.get("summary")?.as_str()?.trim();
        (!summary.is_empty()
            && summary.chars().count() <= SUMMARY_MAX_CHARS
            && !summary.contains(['\r', '\n']))
        .then(|| summary.to_string())
    }
}

/// The run's reply: the model's text, or, when it ended on tool calls with no
/// text, a line naming what the run did.
pub(crate) fn run_reply_text(
    text: String,
    outcomes: &[ToolOutcome],
) -> Result<String, ModelLoopError> {
    if !text.trim().is_empty() {
        return Ok(text);
    }
    let Some(last) = outcomes.last() else {
        return Err(ModelLoopError::Provider(
            "the model finished without a reply".into(),
        ));
    };
    if !last.ok {
        return Err(ModelLoopError::ToolFailed(last.name.clone()));
    }
    let mut titles: Vec<String> = Vec::new();
    for title in outcomes
        .iter()
        .filter_map(ToolOutcome::created_document_title)
    {
        if !titles.contains(&title) {
            titles.push(title);
        }
    }
    if !titles.is_empty() {
        let names = titles
            .iter()
            .map(|title| format!("“{title}”"))
            .collect::<Vec<_>>()
            .join(", ");
        return Ok(format!("Created {names}."));
    }
    Ok(last
        .summary()
        .unwrap_or_else(|| TOOL_ONLY_REPLY.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok(name: &str, content: Value) -> ToolOutcome {
        ToolOutcome::new(name, &Ok(content))
    }

    fn failed(name: &str) -> ToolOutcome {
        ToolOutcome::new(name, &Err("The call failed.".into()))
    }

    fn created(title: &str) -> ToolOutcome {
        ok(
            "create_document",
            json!({"created": true, "title": title, "fileName": "plan.md"})
                .to_string()
                .into(),
        )
    }

    #[test]
    fn model_text_is_the_reply() {
        assert_eq!(
            run_reply_text("Here it is.".into(), &[created("Plan")]).unwrap(),
            "Here it is."
        );
    }

    #[test]
    fn a_created_document_names_the_reply() {
        assert_eq!(
            run_reply_text(" \n".into(), &[created("Launch plan")]).unwrap(),
            "Created “Launch plan”."
        );
        let outcomes = [
            created("Plan"),
            created("Plan"),
            ok("ls", "a.md".into()),
            created("Notes"),
        ];
        assert_eq!(
            run_reply_text(String::new(), &outcomes).unwrap(),
            "Created “Plan”, “Notes”."
        );
        let untitled = ok(
            "create_document",
            json!({"created": true, "fileName": "notes.md"}),
        );
        assert_eq!(
            run_reply_text(String::new(), &[untitled]).unwrap(),
            "Created “notes.md”."
        );
    }

    #[test]
    fn other_tools_reply_with_their_summary_or_a_short_line() {
        let summary = ok(
            "calendar_create_event",
            json!({"summary": "Added the review on Friday."})
                .to_string()
                .into(),
        );
        assert_eq!(
            run_reply_text(String::new(), &[summary]).unwrap(),
            "Added the review on Friday."
        );
        assert_eq!(
            run_reply_text(String::new(), &[ok("write", "wrote notes.md".into())]).unwrap(),
            TOOL_ONLY_REPLY
        );
        let not_created = ok(
            "create_document",
            json!({"created": false, "title": "Plan"}),
        );
        assert_eq!(
            run_reply_text(String::new(), &[not_created]).unwrap(),
            TOOL_ONLY_REPLY
        );
    }

    #[test]
    fn a_failed_last_tool_or_no_tool_fails_the_run() {
        for outcomes in [
            vec![failed("create_document")],
            vec![created("Plan"), failed("bash")],
            vec![ToolOutcome {
                ok: false,
                ..created("Plan")
            }],
        ] {
            let error = run_reply_text(String::new(), &outcomes).unwrap_err();
            assert!(matches!(error, ModelLoopError::ToolFailed(_)), "{error}");
        }
        let error = run_reply_text("  ".into(), &[]).unwrap_err();
        assert!(matches!(error, ModelLoopError::Provider(_)), "{error}");
    }
}
