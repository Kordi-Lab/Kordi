//! Voice metadata and model-visible text share one fail-closed interpretation.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde_json::{json, Value};

const LEGACY_FAILURE: &str = "Transcription unavailable.";
const TRANSCRIPT_NOTE: &str = "[Voice transcript; audio was not provided. Tone, speaker identity, and background sounds are unknown.]";

pub fn block(content: &Value) -> Option<&Value> {
    content["blocks"]
        .as_array()?
        .iter()
        .find(|b| b["type"] == "voice")
}

pub fn valid_transcription(voice: &Value) -> bool {
    let text = voice["transcript"].as_str().unwrap_or_default().trim();
    if text.chars().count() > 20_000 {
        return false;
    }
    let Some(state) = voice.get("transcription") else {
        return !text.is_empty();
    };
    let status = state["status"].as_str().unwrap_or_default();
    matches!(status, "pending" | "ready" | "failed" | "unavailable")
        && state["sourceVersion"].as_str() == voice["mediaId"].as_str()
        && state["sourceVersion"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 128)
        && matches!(state["engine"].as_str(), Some("apple-speech-v1" | "legacy"))
        && state["attempts"].as_u64().is_some_and(|n| n <= 3)
        && state.get("language").is_none_or(|v| {
            v.as_str().is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 64
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            })
        })
        && if status == "ready" {
            !text.is_empty() && text != LEGACY_FAILURE
        } else {
            text.is_empty()
        }
}

pub fn agent_text(voice: &Value) -> String {
    let text = voice["transcript"].as_str().unwrap_or_default().trim();
    let status = voice["transcription"]["status"].as_str();
    if valid_transcription(voice) && status.is_none_or(|s| s == "ready") && text != LEGACY_FAILURE {
        return format!("{TRANSCRIPT_NOTE}\n{text}");
    }
    let status = match status {
        Some("pending") => "pending",
        Some("failed") => "failed",
        _ => "unavailable",
    };
    format!("[Voice message: transcription {status}. No spoken content or audio was provided to the agent.]")
}

/// Preserve routing and attribution while replacing only the model-visible speech.
pub fn body_for_agent(content: &Value) -> String {
    let body = content["blocks"][0]["text"].as_str().unwrap_or_default();
    let Some(voice) = block(content) else {
        return body.to_owned();
    };
    replace_body_text(content, agent_text(voice))
}

pub fn replace_body_text(content: &Value, text: String) -> String {
    let body = content["blocks"][0]["text"].as_str().unwrap_or_default();
    let Some(voice) = block(content) else {
        return body.to_owned();
    };
    for prefix in ["kordi-cloud-group:", "kordi-cloud-message:"] {
        if let Some(encoded) = body.strip_prefix(prefix) {
            let envelope = URL_SAFE_NO_PAD
                .decode(encoded)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
            if let Some(mut envelope) = envelope {
                let target = if prefix == "kordi-cloud-group:" {
                    &mut envelope["message"]
                } else {
                    &mut envelope
                };
                if let Some(target) = target.as_object_mut() {
                    target.insert("text".into(), json!(text));
                    target.insert("voiceMessage".into(), voice.clone());
                    if let Ok(bytes) = serde_json::to_vec(&envelope) {
                        return format!("{prefix}{}", URL_SAFE_NO_PAD.encode(bytes));
                    }
                }
            }
            // Never convert a malformed routing envelope into a user instruction.
            return String::new();
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    fn voice(status: &str, text: &str) -> Value {
        json!({"type":"voice","mediaId":"audio-v1","transcript":text,
            "transcription":{"status":status,"sourceVersion":"audio-v1","engine":"apple-speech-v1","language":"en-US","attempts":1}})
    }
    #[test]
    fn failed_silent_and_stale_transcripts_never_become_speech() {
        for state in ["pending", "failed", "unavailable"] {
            assert!(valid_transcription(&voice(state, "")));
            assert!(!valid_transcription(&voice(state, "invented speech")));
            assert!(!agent_text(&voice(state, "invented speech")).contains("invented speech"));
        }
        let mut stale = voice("ready", "old speech");
        stale["mediaId"] = json!("audio-v2");
        assert!(!valid_transcription(&stale));
        assert!(!agent_text(&stale).contains("old speech"));
        assert!(!agent_text(&json!({"transcript":LEGACY_FAILURE})).contains(LEGACY_FAILURE));
        assert!(!valid_transcription(&voice("ready", "")));
    }
    #[test]
    fn ready_multilingual_transcript_keeps_provenance_and_envelope_identity() {
        let v = voice(
            "ready",
            "Meet at noon. \u{0645}\u{0631}\u{062D}\u{0628}\u{0627}",
        );
        let body = format!(
            "kordi-cloud-group:{}",
            URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(
                    &json!({"message":{"id":"message-1","senderAccountId":"sender","text":"old"}})
                )
                .unwrap()
            )
        );
        let result = body_for_agent(&json!({"blocks":[{"type":"text","text":body},v]}));
        let bytes = URL_SAFE_NO_PAD
            .decode(result.strip_prefix("kordi-cloud-group:").unwrap())
            .unwrap();
        let result: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result["message"]["id"], "message-1");
        assert_eq!(result["message"]["senderAccountId"], "sender");
        assert!(result["message"]["text"]
            .as_str()
            .unwrap()
            .contains(TRANSCRIPT_NOTE));
        assert!(result["message"]["text"]
            .as_str()
            .unwrap()
            .contains("Meet at noon."));
    }
}
