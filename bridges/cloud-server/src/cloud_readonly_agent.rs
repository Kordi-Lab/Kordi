use futures_util::StreamExt;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudReadonlyCredential {
    OpenAiCodexOAuth { access_token: String, account_id: String },
}

fn clean_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

pub fn extract_readonly_credential(
    auth_json: &Value,
    active_provider: Option<&str>,
    active_profile_id: Option<&str>,
) -> Option<CloudReadonlyCredential> {
    let provider = clean_text(active_provider)
        .or_else(|| clean_text(auth_json.get("last_provider")?.as_str()))?;
    let normalized_provider = match provider.as_str() {
        "openai" | "openai-codex" => "openai",
        _ => return None,
    };
    let active_profile = clean_text(active_profile_id).or_else(|| {
        auth_json
            .get("active_auth_profiles")
            .and_then(Value::as_object)
            .and_then(|profiles| profiles.get(normalized_provider).or_else(|| profiles.get(&provider)))
            .and_then(Value::as_str)
            .and_then(|value| clean_text(Some(value)))
    });
    let profiles = auth_json
        .get("profiles")
        .and_then(Value::as_object)?
        .get(normalized_provider)
        .or_else(|| auth_json.get("profiles")?.as_object()?.get(&provider))?
        .as_array()?;
    let profile = active_profile
        .as_deref()
        .and_then(|profile_id| {
            profiles.iter().find(|profile| {
                profile
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id == profile_id)
            })
        })
        .or_else(|| profiles.iter().find(|profile| profile.get("type").and_then(Value::as_str) == Some("oauth")))?;
    if profile.get("type").and_then(Value::as_str) != Some("oauth") {
        return None;
    }
    let access_token = clean_text(profile.get("access").and_then(Value::as_str))?;
    let account_id = profile
        .get("accountId")
        .and_then(Value::as_str)
        .or_else(|| profile.get("extra").and_then(|extra| extra.get("accountId")).and_then(Value::as_str))
        .and_then(|value| clean_text(Some(value)))?;

    Some(CloudReadonlyCredential::OpenAiCodexOAuth { access_token, account_id })
}

fn codex_request_body(prompt: &str, owner_display_name: Option<&str>) -> Value {
    let owner = owner_display_name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("the owner");
    json!({
        "model": "gpt-5.4",
        "store": false,
        "stream": true,
        "instructions": format!(
            "You are {owner}'s Kordi responding from Cloud while the desktop is offline. You do not have local filesystem, shell, browser, app, camera, microphone, or device access. Answer read-only questions from the conversation when possible. If the user asks you to inspect or control the owner's computer, say you cannot access the local device right now and explain what information would be needed. The decision to refuse must be based on this capability boundary, not on a hard-coded server template. Be concise."
        ),
        "input": [{ "role": "user", "content": prompt }],
        "text": { "verbosity": "medium" },
        "tool_choice": "none",
        "parallel_tool_calls": false
    })
}

pub async fn generate_readonly_cloud_agent_response(
    client: &reqwest::Client,
    auth_json: &Value,
    active_provider: Option<&str>,
    active_profile_id: Option<&str>,
    prompt: &str,
    owner_display_name: Option<&str>,
) -> Option<String> {
    let credential = extract_readonly_credential(auth_json, active_provider, active_profile_id)?;
    match credential {
        CloudReadonlyCredential::OpenAiCodexOAuth { access_token, account_id } => {
            let response = client
                .post("https://chatgpt.com/backend-api/codex/responses")
                .header("Authorization", format!("Bearer {access_token}"))
                .header("chatgpt-account-id", account_id)
                .header("OpenAI-Beta", "responses=experimental")
                .header("accept", "text/event-stream")
                .header("content-type", "application/json")
                .header("originator", "kordi")
                .header("User-Agent", "kordi")
                .json(&codex_request_body(prompt, owner_display_name))
                .send()
                .await
                .ok()?;
            if !response.status().is_success() {
                return None;
            }
            let mut stream = response.bytes_stream();
            let mut buffer = String::new();
            let mut text = String::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.ok()?;
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(pos) = buffer.find('\n') {
                    let line = buffer[..pos].trim().to_string();
                    buffer = buffer[pos + 1..].to_string();
                    let Some(data) = line.strip_prefix("data: ") else { continue; };
                    if data == "[DONE]" {
                        let trimmed = text.trim();
                        return (!trimmed.is_empty()).then(|| trimmed.to_string());
                    }
                    let Ok(event) = serde_json::from_str::<Value>(data) else { continue; };
                    if event.get("type").and_then(Value::as_str) == Some("response.output_text.delta") {
                        if let Some(delta) = event.get("delta").and_then(Value::as_str) {
                            text.push_str(delta);
                        }
                    }
                }
            }
            let trimmed = text.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_active_openai_codex_oauth_credential() {
        let auth_json = json!({
            "version": 2,
            "last_provider": "openai",
            "active_auth_profiles": { "openai": "profile-openai" },
            "profiles": {
                "openai": [{
                    "id": "profile-openai",
                    "type": "oauth",
                    "access": "access-token",
                    "refresh": "refresh-token",
                    "expires": 9999999999_i64,
                    "accountId": "acct-openai"
                }]
            }
        });

        assert_eq!(
            extract_readonly_credential(&auth_json, Some("openai"), None),
            Some(CloudReadonlyCredential::OpenAiCodexOAuth {
                access_token: "access-token".to_string(),
                account_id: "acct-openai".to_string(),
            })
        );
    }

    #[test]
    fn unsupported_or_missing_credentials_do_not_generate_hardcoded_model_auth() {
        let auth_json = json!({
            "version": 2,
            "last_provider": "lm-studio",
            "profiles": {}
        });

        assert_eq!(extract_readonly_credential(&auth_json, None, None), None);
    }
}
