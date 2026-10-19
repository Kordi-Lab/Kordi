//! The quick urgency check a digest run can be instead of a digest (issue
//! 1870): the run's system prompt and a tiny user prompt, no tools, and the
//! reply as it is. The server decides what the reply means.

use super::*;

/// Whether the run's frozen input is a quick check.
pub(super) fn is_triage(input: &Value) -> bool {
    input.get("triage").and_then(Value::as_bool) == Some(true)
}

/// The user prompt. It matches the server's `digest::urgent::triage_prompt`,
/// which a Mac uses.
pub(super) fn prompt(input: &Value) -> String {
    let messages: Vec<_> = input["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|source| {
            json!({"sender":source["senderName"],"sentAt":source["createdAt"],"text":source["text"]})
        })
        .collect();
    format!(
        "Do these new messages need the viewer's attention soon? Now: {}. Viewer timezone: {}. Messages: {}",
        input["asOf"],
        input["timezone"],
        Value::Array(messages)
    )
}

pub(super) async fn run_legacy<P: CloudModelProvider + Sync>(
    provider: &P,
    run: &CloudAgentRun,
    auth: &OpenAiProviderConfig,
    input: &Value,
) -> Result<String, ModelLoopError> {
    let messages = [
        json!({"role":"system","content":run.system_prompt}),
        json!({"role":"user","content":prompt(input)}),
    ];
    match provider.next_response(auth, &messages, &[]).await? {
        ModelProviderResponse::FinalText(text) => Ok(text),
        ModelProviderResponse::ToolCalls(_) => Ok(r#"{"urgent":false}"#.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quick_check_sends_only_the_marked_messages() {
        let input = json!({"triage":true,"asOf":"2026-10-18T12:00:00Z","timezone":"UTC",
            "sources":[{"id":"m1","senderName":"Alex","createdAt":"2026-10-18T11:59:00Z","text":"Can we meet at 3pm?","sessionId":"s"}]});
        assert!(is_triage(&input));
        assert!(!is_triage(&json!({"sources":[]})));
        let prompt = prompt(&input);
        assert!(prompt.contains("Can we meet at 3pm?"));
        assert!(!prompt.contains("sessionId") && !prompt.contains("m1"));
    }
}
