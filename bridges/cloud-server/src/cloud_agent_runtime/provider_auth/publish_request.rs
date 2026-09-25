//! Validation of a snapshot publish request.

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct PublishProviderAuthSnapshotRequest {
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    pub label: Option<String>,
    pub payload: Value,
}

const MAX_PROVIDER_CHARS: usize = 80;
const MAX_AUTH_CHOICE_CHARS: usize = 160;
const MAX_LABEL_CHARS: usize = 80;
/// Largest serialized payload a snapshot may hold. Real credentials, even
/// OAuth material with its metadata, stay far below this.
pub const MAX_PAYLOAD_BYTES: usize = 64 * 1024;

impl PublishProviderAuthSnapshotRequest {
    /// Validates a publish. The provider is a lowercase ID of at most 80
    /// characters and the account choice at most 160 characters without
    /// control characters. A longer label is shortened to 80 characters. The
    /// payload is kept as sent, including an OMP `baseUrl` and `api`, and must
    /// serialize to at most 64 KiB.
    pub fn normalized(&self) -> Option<NormalizedProviderAuthSnapshotInput> {
        let provider = self.provider.trim().to_ascii_lowercase();
        let auth_choice = self.auth_choice.trim().to_string();
        let label = self
            .label
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                value
                    .chars()
                    .take(MAX_LABEL_CHARS)
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            });
        let provider_is_id = provider.len() <= MAX_PROVIDER_CHARS
            && provider
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            && provider.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_.".contains(&byte)
            });
        if !provider_is_id
            || auth_choice.is_empty()
            || auth_choice.chars().count() > MAX_AUTH_CHOICE_CHARS
            || auth_choice.chars().any(char::is_control)
            || self.payload.is_null()
            || !serde_json::to_vec(&self.payload)
                .is_ok_and(|bytes| bytes.len() <= MAX_PAYLOAD_BYTES)
            || label
                .as_deref()
                .is_some_and(|value| value.chars().any(char::is_control))
        {
            return None;
        }
        Some(NormalizedProviderAuthSnapshotInput {
            provider,
            auth_choice,
            label,
            payload: self.payload.clone(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct NormalizedProviderAuthSnapshotInput {
    pub provider: String,
    pub auth_choice: String,
    pub label: Option<String>,
    pub payload: Value,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        provider: &str,
        auth_choice: &str,
        label: Option<&str>,
    ) -> PublishProviderAuthSnapshotRequest {
        PublishProviderAuthSnapshotRequest {
            provider: provider.to_string(),
            auth_choice: auth_choice.to_string(),
            label: label.map(str::to_string),
            payload: serde_json::json!({ "apiKey": "synthetic" }),
        }
    }

    #[test]
    fn publish_request_bounds_provider_and_choice_and_shortens_labels() {
        let normalized = request(" OpenAI-Codex ", "profile:work", Some("Work")).normalized();
        assert_eq!(normalized.unwrap().provider, "openai-codex");
        for (provider, auth_choice) in [
            ("open ai", "default"),
            ("-openai", "default"),
            ("openai/codex", "default"),
            (&"a".repeat(81) as &str, "default"),
            ("openai", &"c".repeat(161) as &str),
            ("openai", "line\nbreak"),
        ] {
            assert!(
                request(provider, auth_choice, None).normalized().is_none(),
                "{provider:?} {auth_choice:?}"
            );
        }
        assert!(request(&"a".repeat(80), &"c".repeat(160), None)
            .normalized()
            .is_some());
        let long_label = format!("{} tail", "L".repeat(79));
        let shortened = request("openai", "default", Some(&long_label))
            .normalized()
            .unwrap()
            .label
            .unwrap();
        assert_eq!(shortened, "L".repeat(79));
        let accented = "\u{e9}".repeat(90);
        assert_eq!(
            request("openai", "default", Some(&accented))
                .normalized()
                .unwrap()
                .label
                .unwrap()
                .chars()
                .count(),
            80
        );
        assert!(request("openai", "default", Some("tab\tlabel"))
            .normalized()
            .is_none());
    }

    #[test]
    fn publish_request_keeps_omp_endpoint_fields_and_bounds_payload_size() {
        let omp = PublishProviderAuthSnapshotRequest {
            provider: "mistral".to_string(),
            auth_choice: "cloud-login:session".to_string(),
            label: None,
            payload: serde_json::json!({
                "apiMode": "api-key",
                "apiKey": "synthetic",
                "baseUrl": "https://api.mistral.ai/v1",
                "api": "openai-completions"
            }),
        };
        assert_eq!(omp.normalized().unwrap().payload, omp.payload);
        // OMP sends a null `baseUrl` when it only knows a templated host.
        let templated = PublishProviderAuthSnapshotRequest {
            payload: serde_json::json!({
                "apiMode": "api-key",
                "apiKey": "synthetic",
                "baseUrl": null,
                "api": "bedrock-converse-stream"
            }),
            ..omp
        };
        assert_eq!(templated.normalized().unwrap().payload, templated.payload);
        let sized = |bytes: usize| PublishProviderAuthSnapshotRequest {
            provider: "openai".to_string(),
            auth_choice: "default".to_string(),
            label: None,
            // `{"apiKey":""}` adds 13 bytes around the key.
            payload: serde_json::json!({ "apiKey": "k".repeat(bytes - 13) }),
        };
        assert!(sized(MAX_PAYLOAD_BYTES).normalized().is_some());
        assert!(sized(MAX_PAYLOAD_BYTES + 1).normalized().is_none());
    }

    #[test]
    fn publish_request_rejects_empty_fields() {
        let request = PublishProviderAuthSnapshotRequest {
            provider: " ".to_string(),
            auth_choice: "default".to_string(),
            label: None,
            payload: serde_json::json!({"token":"x"}),
        };
        assert!(request.normalized().is_none());
    }
}
