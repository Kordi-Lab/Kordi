use serde_json::Value;

/// Canonical local history must apply the same transcript-only boundary as Cloud history.
pub(super) fn message_text(text: String, content: Option<&str>) -> String {
    let content = content.and_then(|value| serde_json::from_str::<Value>(value).ok());
    let Some(voice) = content
        .as_ref()
        .and_then(|content| content.get("voiceMessage"))
    else {
        return text;
    };
    let transcript = voice["transcript"].as_str().unwrap_or_default().trim();
    let state = voice.get("transcription");
    let ready = state.is_none_or(|state| {
        state["status"] == "ready"
            && state["sourceVersion"].as_str().is_some()
            && (state["sourceVersion"] == voice["mediaId"]
                || voice["mediaId"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("pending:")))
    });
    if ready && !transcript.is_empty() && transcript != "Transcription unavailable." {
        return format!("[Voice transcript; audio was not provided. Tone, speaker identity, and background sounds are unknown.]\n{transcript}");
    }
    let status = match state.and_then(|s| s["status"].as_str()) {
        Some("pending") => "pending",
        Some("failed") => "failed",
        _ => "unavailable",
    };
    format!("[Voice message: transcription {status}. No spoken content or audio was provided to the agent.]")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn local_history_excludes_failed_and_stale_transcripts() {
        for status in ["pending", "failed", "unavailable"] {
            let content =
                json!({"voiceMessage":{"mediaId":"audio-v1","transcript":"must not be spoken",
                "transcription":{"status":status,"sourceVersion":"audio-v1"}}})
                .to_string();
            assert!(!message_text("must not be spoken".into(), Some(&content))
                .contains("must not be spoken"));
        }
        let content = json!({"voiceMessage":{"mediaId":"audio-v2","transcript":"old speech",
            "transcription":{"status":"ready","sourceVersion":"audio-v1"}}})
        .to_string();
        assert!(!message_text("old speech".into(), Some(&content)).contains("old speech"));
        let content =
            json!({"voiceMessage":{"transcript":"Transcription unavailable."}}).to_string();
        assert!(
            !message_text("Transcription unavailable.".into(), Some(&content))
                .contains("Transcription unavailable.")
        );
    }
    #[test]
    fn local_transcripts_have_provenance_and_text_messages_stay_unchanged() {
        let content = json!({"voiceMessage":{"mediaId":"audio-v1","transcript":"Meet at noon.",
            "transcription":{"status":"ready","sourceVersion":"audio-v1"}}})
        .to_string();
        let text = message_text("Meet at noon.".into(), Some(&content));
        assert!(text.contains("audio was not provided"));
        assert!(text.ends_with("Meet at noon."));
        assert_eq!(message_text("Hello".into(), None), "Hello");
    }
}
