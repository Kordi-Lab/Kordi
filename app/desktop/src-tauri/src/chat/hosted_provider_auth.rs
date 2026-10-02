use kordi_cli::desktop_runtime::{DesktopChatContextMessage, DesktopCloudExecutionLease};
use kordi_cli::login::{AuthSource, ProviderAuthMethod, ResolvedProviderAuth};
use serde::Deserialize;
use serde_json::{json, Value};

use super::DesktopChatMessageRoute;
use device_proof::{device_proof, request_challenge};

mod device_proof;

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_CHALLENGE_BYTES: usize = 4 * 1024;
const UNAVAILABLE: &str = "Hosted provider credentials are unavailable for this desktop turn";
const DEVICE_KEY_REQUIRED: &str = "This Mac has no registered device key for hosted provider accounts. Sign out of Kordi and sign in again on this Mac, then retry.";
const DEVICE_PROOF_FAILED: &str = "Kordi could not verify this Mac's device key for hosted provider accounts. Sign out of Kordi and sign in again on this Mac, then retry.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostedProviderAuthMaterial {
    provider: String,
    auth_choice: String,
    payload: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostedProviderAuthEnvelope {
    provider_auth: HostedProviderAuthMaterial,
}

pub(super) struct HostedTurnAuth {
    pub provider: String,
    pub auth: ResolvedProviderAuth,
    pub base_url: Option<String>,
    pub api: Option<String>,
}

pub(super) fn route_uses_hosted_auth(route: Option<&DesktopChatMessageRoute>) -> bool {
    route
        .and_then(|route| route.auth_choice.as_deref())
        .is_some_and(|choice| {
            let choice = choice.trim();
            [
                "cloud-login:",
                "cloud-api-key:",
                "ios-codex:",
                "ios-api-key:",
            ]
            .iter()
            .any(|prefix| {
                choice
                    .strip_prefix(prefix)
                    .is_some_and(|suffix| !suffix.is_empty())
            })
        })
}

fn lease_from_context(
    context_messages: &[DesktopChatContextMessage],
) -> Result<&DesktopCloudExecutionLease, String> {
    context_messages
        .iter()
        .find(|message| message.context_role.as_deref() == Some("runtimeIdentity"))
        .and_then(|message| message.execution_lease.as_ref())
        .ok_or_else(|| "Hosted provider requests require an active desktop execution lease".into())
}

fn credential_from_material(
    route: &DesktopChatMessageRoute,
    material: HostedProviderAuthMaterial,
) -> Result<HostedTurnAuth, String> {
    let expected_provider = route
        .auth_provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| UNAVAILABLE.to_string())?;
    let expected_choice = route
        .auth_choice
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| UNAVAILABLE.to_string())?;
    if material.auth_choice != expected_choice
        || !kordi_cli::login::provider_names_match(expected_provider, &material.provider)
    {
        return Err(UNAVAILABLE.into());
    }
    let payload = material.payload.as_object().ok_or(UNAVAILABLE)?;
    let api_mode = payload.get("apiMode").and_then(Value::as_str);
    let (method, credential) = match api_mode {
        Some("openai-codex-oauth") if material.provider == "openai-codex" => (
            ProviderAuthMethod::OAuth,
            payload.get("accessToken").and_then(Value::as_str),
        ),
        Some("anthropic-oauth") if material.provider == "anthropic" => (
            ProviderAuthMethod::OAuth,
            payload.get("accessToken").and_then(Value::as_str),
        ),
        _ => (
            ProviderAuthMethod::ApiKey,
            payload.get("apiKey").and_then(Value::as_str),
        ),
    };
    let credential = credential
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.starts_with('{'))
        .ok_or(UNAVAILABLE)?;
    let account_id = payload
        .get("accountId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let base_url = payload
        .get("baseUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    let api = payload
        .get("api")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string);
    Ok(HostedTurnAuth {
        provider: material.provider.clone(),
        auth: ResolvedProviderAuth {
            source: AuthSource::KordiAuth,
            credential_provider: material.provider,
            method,
            credential: credential.to_string(),
            account_id,
            account_label: None,
            authority: None,
        },
        base_url,
        api,
    })
}

/// The message for a refused request, telling the user how to recover when
/// the refusal concerns this Mac's device key.
fn refusal_message(body: &[u8]) -> String {
    let code = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("errorCode")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    match code.as_deref() {
        Some("device_key_required") => DEVICE_KEY_REQUIRED.into(),
        Some("device_proof_required" | "device_proof_invalid") => DEVICE_PROOF_FAILED.into(),
        _ => UNAVAILABLE.into(),
    }
}

async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err(UNAVAILABLE.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        if bytes.len() + chunk.len() > limit {
            return Err(UNAVAILABLE.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn provider_auth_endpoint(
    base_url: &str,
    lease: &DesktopCloudExecutionLease,
    challenge: bool,
) -> Result<reqwest::Url, String> {
    let mut endpoint = reqwest::Url::parse(base_url).map_err(|_| UNAVAILABLE)?;
    {
        let mut segments = endpoint.path_segments_mut().map_err(|_| UNAVAILABLE)?;
        segments.extend([
            "v1",
            "cloud",
            "agent-runs",
            &lease.run_id,
            "desktop",
            "provider-auth",
        ]);
        if challenge {
            segments.push("challenge");
        }
    }
    Ok(endpoint)
}

pub(super) async fn resolve_for_turn(
    route: &DesktopChatMessageRoute,
    context_messages: &[DesktopChatContextMessage],
) -> Result<HostedTurnAuth, String> {
    let lease = lease_from_context(context_messages)?;
    let owner_account_id = lease.owner_account_id.clone();
    let session = tokio::task::spawn_blocking(crate::cloud_session::cloud_session_load)
        .await
        .map_err(|_| UNAVAILABLE)?
        .map_err(|_| UNAVAILABLE)?
        .ok_or(UNAVAILABLE)?;
    if session.account_id != owner_account_id || session.token.trim().is_empty() {
        return Err(UNAVAILABLE.into());
    }
    let base_url = crate::cloud_api_base_url_from_env()?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| UNAVAILABLE)?;
    let mut body = json!({ "claimId": lease.claim_id });
    // The device key cannot be rotated between signing the proof and the
    // server checking it.
    let key_use = crate::cloud_session::device_key_rotation::DEVICE_KEY_USE
        .read()
        .await;
    if let Some(challenge) = request_challenge(&client, &base_url, &session.token, lease).await? {
        body["deviceProof"] = device_proof(&base_url, &session, lease, challenge).await?;
    }
    let response = client
        .post(provider_auth_endpoint(&base_url, lease, false)?)
        .bearer_auth(session.token)
        .json(&body)
        .send()
        .await
        .map_err(|_| UNAVAILABLE)?;
    drop(key_use);
    if !response.status().is_success() {
        let body = read_limited(response, MAX_CHALLENGE_BYTES)
            .await
            .unwrap_or_default();
        return Err(refusal_message(&body));
    }
    let bytes = read_limited(response, MAX_RESPONSE_BYTES).await?;
    let envelope: HostedProviderAuthEnvelope =
        serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    credential_from_material(route, envelope.provider_auth)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route() -> DesktopChatMessageRoute {
        DesktopChatMessageRoute {
            model: Some("openai-codex/gpt-5.5".into()),
            auth_provider: Some("openai-codex".into()),
            auth_choice: Some("cloud-login:test".into()),
            thinking: None,
        }
    }

    #[test]
    fn exact_hosted_choice_maps_to_ephemeral_codex_oauth() {
        let selected = credential_from_material(
            &route(),
            HostedProviderAuthMaterial {
                provider: "openai-codex".into(),
                auth_choice: "cloud-login:test".into(),
                payload: json!({
                    "apiMode": "openai-codex-oauth",
                    "accessToken": "synthetic-access",
                    "accountId": "synthetic-account"
                }),
            },
        )
        .expect("matching hosted credentials");
        assert_eq!(selected.provider, "openai-codex");
        assert_eq!(selected.auth.method, ProviderAuthMethod::OAuth);
        assert_eq!(selected.auth.credential, "synthetic-access");
        assert_eq!(
            selected.auth.account_id.as_deref(),
            Some("synthetic-account")
        );
    }

    #[test]
    fn mismatched_choice_cannot_use_another_saved_account() {
        let result = credential_from_material(
            &route(),
            HostedProviderAuthMaterial {
                provider: "openai-codex".into(),
                auth_choice: "cloud-login:other".into(),
                payload: json!({ "apiMode": "openai-codex-oauth", "accessToken": "synthetic-access" }),
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn exact_hosted_api_key_uses_api_key_auth_mode() {
        let mut selected = route();
        selected.auth_choice = Some("cloud-api-key:work".into());
        let selected = credential_from_material(
            &selected,
            HostedProviderAuthMaterial {
                provider: "openai".into(),
                auth_choice: "cloud-api-key:work".into(),
                payload: json!({ "apiKey": "synthetic-api-key" }),
            },
        )
        .expect("matching hosted API key");
        assert_eq!(selected.auth.method, ProviderAuthMethod::ApiKey);
    }

    #[test]
    fn hosted_route_requires_a_real_execution_lease() {
        assert!(route_uses_hosted_auth(Some(&route())));
        assert!(lease_from_context(&[]).is_err());
    }

    #[test]
    fn device_key_refusals_tell_the_user_how_to_recover() {
        let refusal =
            |code: &str| refusal_message(json!({ "errorCode": code }).to_string().as_bytes());
        assert_eq!(refusal("device_key_required"), DEVICE_KEY_REQUIRED);
        assert_eq!(refusal("device_proof_required"), DEVICE_PROOF_FAILED);
        assert_eq!(refusal("device_proof_invalid"), DEVICE_PROOF_FAILED);
        assert_eq!(refusal("execution_lease_lost"), UNAVAILABLE);
        assert_eq!(refusal_message(b"not json"), UNAVAILABLE);
    }
}
