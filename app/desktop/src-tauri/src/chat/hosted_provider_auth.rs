use std::future::Future;
use std::sync::{Arc, Mutex};

use kordi_cli::desktop_runtime::{DesktopChatContextMessage, DesktopCloudExecutionLease};
use kordi_cli::login::{AuthSource, ProviderAuthMethod, ResolvedProviderAuth};
use serde::Deserialize;
use serde_json::{json, Value};

use super::DesktopChatMessageRoute;

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const UNAVAILABLE: &str = "Hosted provider credentials are unavailable for this desktop turn";
/// The server strips the token expiry before handing material to the desktop,
/// but it refreshes any token within five minutes of expiring first. That is
/// the only lifetime the desktop can rely on for an OAuth access token.
const GUARANTEED_OAUTH_TTL_MS: i64 = 5 * 60 * 1000;
/// Inherited credentials this close to expiry are resolved again.
const REFRESH_MARGIN_MS: i64 = 60 * 1000;

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

#[derive(Clone)]
pub(super) struct HostedTurnAuth {
    pub provider: String,
    pub auth: ResolvedProviderAuth,
    pub base_url: Option<String>,
    pub api: Option<String>,
    /// When the access token stops working. `None` for credentials without
    /// an expiry, such as API keys.
    pub expires_at_ms: Option<i64>,
}

impl HostedTurnAuth {
    fn needs_refresh(&self, now_ms: i64) -> bool {
        self.expires_at_ms
            .is_some_and(|expires_at| expires_at <= now_ms + REFRESH_MARGIN_MS)
    }
}

/// A hosted credential resolved for a parent turn and reused by turns that
/// hold no execution lease of their own: background children, messages sent
/// to them, and the parent follow-up turn. The cell is shared so a refreshed
/// credential replaces the stale one for every later turn.
#[derive(Clone)]
pub(super) struct InheritedHostedAuth {
    current: Arc<Mutex<HostedTurnAuth>>,
    lease: Option<DesktopCloudExecutionLease>,
}

impl InheritedHostedAuth {
    pub(super) fn new(auth: HostedTurnAuth, lease: Option<DesktopCloudExecutionLease>) -> Self {
        Self {
            current: Arc::new(Mutex::new(auth)),
            lease,
        }
    }

    pub(super) fn current(&self) -> HostedTurnAuth {
        self.current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    #[cfg(test)]
    pub(super) fn lease(&self) -> Option<&DesktopCloudExecutionLease> {
        self.lease.as_ref()
    }

    /// The inherited credential while it is fresh. Near expiry it is resolved
    /// again against the parent lease; the inherited one is only the fallback
    /// when that fails.
    pub(super) async fn for_turn(&self, route: Option<&DesktopChatMessageRoute>) -> HostedTurnAuth {
        self.for_turn_with(now_millis(), |lease| {
            let route = route.cloned();
            async move {
                let route = route.ok_or_else(|| UNAVAILABLE.to_string())?;
                resolve_with_lease(&route, &lease).await
            }
        })
        .await
    }

    async fn for_turn_with<F, Fut>(&self, now_ms: i64, refresh: F) -> HostedTurnAuth
    where
        F: FnOnce(DesktopCloudExecutionLease) -> Fut,
        Fut: Future<Output = Result<HostedTurnAuth, String>>,
    {
        let inherited = self.current();
        if !inherited.needs_refresh(now_ms) {
            return inherited;
        }
        let Some(lease) = self.lease.clone() else {
            return inherited;
        };
        match refresh(lease).await {
            Ok(fresh) => {
                *self
                    .current
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = fresh.clone();
                fresh
            }
            Err(_) => inherited,
        }
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

fn payload_expiry(payload: &serde_json::Map<String, Value>) -> Option<i64> {
    payload.get("expiresAtMs").and_then(|value| {
        value
            .as_i64()
            .or_else(|| value.as_str().and_then(|text| text.trim().parse().ok()))
    })
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
    issued_at_ms: i64,
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
    let expires_at_ms = match method {
        ProviderAuthMethod::OAuth => {
            Some(payload_expiry(payload).unwrap_or(issued_at_ms + GUARANTEED_OAUTH_TTL_MS))
        }
        _ => payload_expiry(payload),
    };
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
        expires_at_ms,
    })
}

pub(super) async fn resolve_for_turn(
    route: &DesktopChatMessageRoute,
    context_messages: &[DesktopChatContextMessage],
) -> Result<HostedTurnAuth, String> {
    resolve_with_lease(route, lease_from_context(context_messages)?).await
}

async fn resolve_with_lease(
    route: &DesktopChatMessageRoute,
    lease: &DesktopCloudExecutionLease,
) -> Result<HostedTurnAuth, String> {
    let issued_at_ms = now_millis();
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
    let mut endpoint = reqwest::Url::parse(&base_url).map_err(|_| UNAVAILABLE)?;
    endpoint
        .path_segments_mut()
        .map_err(|_| UNAVAILABLE)?
        .extend([
            "v1",
            "cloud",
            "agent-runs",
            &lease.run_id,
            "desktop",
            "provider-auth",
        ]);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| UNAVAILABLE)?;
    let mut response = client
        .post(endpoint)
        .bearer_auth(session.token)
        .json(&json!({ "claimId": lease.claim_id }))
        .send()
        .await
        .map_err(|_| UNAVAILABLE)?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(UNAVAILABLE.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(UNAVAILABLE.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let envelope: HostedProviderAuthEnvelope =
        serde_json::from_slice(&bytes).map_err(|_| UNAVAILABLE)?;
    credential_from_material(route, envelope.provider_auth, issued_at_ms)
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
            1_000,
        )
        .expect("matching hosted credentials");
        assert_eq!(selected.provider, "openai-codex");
        assert_eq!(selected.auth.method, ProviderAuthMethod::OAuth);
        assert_eq!(selected.auth.credential, "synthetic-access");
        assert_eq!(
            selected.auth.account_id.as_deref(),
            Some("synthetic-account")
        );
        assert_eq!(
            selected.expires_at_ms,
            Some(1_000 + GUARANTEED_OAUTH_TTL_MS)
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
            1_000,
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
            1_000,
        )
        .expect("matching hosted API key");
        assert_eq!(selected.auth.method, ProviderAuthMethod::ApiKey);
        assert_eq!(selected.expires_at_ms, None);
    }

    #[test]
    fn hosted_route_requires_a_real_execution_lease() {
        assert!(route_uses_hosted_auth(Some(&route())));
        assert!(lease_from_context(&[]).is_err());
    }

    fn auth(credential: &str, expires_at_ms: Option<i64>) -> HostedTurnAuth {
        HostedTurnAuth {
            provider: "openai-codex".into(),
            auth: ResolvedProviderAuth {
                source: AuthSource::KordiAuth,
                credential_provider: "openai-codex".into(),
                method: ProviderAuthMethod::OAuth,
                credential: credential.into(),
                account_id: None,
                account_label: None,
                authority: None,
            },
            base_url: None,
            api: None,
            expires_at_ms,
        }
    }

    fn lease() -> DesktopCloudExecutionLease {
        DesktopCloudExecutionLease {
            session_id: "session:group:parent".into(),
            run_id: "run-parent".into(),
            claim_id: "claim-parent".into(),
            owner_account_id: "owner".into(),
        }
    }

    #[tokio::test]
    async fn fresh_inherited_auth_is_used_without_a_lease_request() {
        let inherited =
            InheritedHostedAuth::new(auth("parent-token", Some(500_000)), Some(lease()));
        let selected = inherited
            .for_turn_with(100_000, |_| async {
                panic!("a fresh inherited credential must not be resolved again")
            })
            .await;
        assert_eq!(selected.auth.credential, "parent-token");
    }

    #[tokio::test]
    async fn expired_inherited_auth_is_resolved_again_and_shared() {
        let inherited =
            InheritedHostedAuth::new(auth("parent-token", Some(100_000)), Some(lease()));
        let selected = inherited
            .for_turn_with(100_000, |lease| async move {
                assert_eq!(lease.claim_id, "claim-parent");
                Ok(auth("fresh-token", Some(900_000)))
            })
            .await;
        assert_eq!(selected.auth.credential, "fresh-token");
        assert_eq!(inherited.current().auth.credential, "fresh-token");
    }

    #[tokio::test]
    async fn auth_near_expiry_is_resolved_again() {
        let inherited =
            InheritedHostedAuth::new(auth("parent-token", Some(100_000 + 30_000)), Some(lease()));
        let selected = inherited
            .for_turn_with(100_000, |_| async { Ok(auth("fresh-token", None)) })
            .await;
        assert_eq!(selected.auth.credential, "fresh-token");
    }

    #[tokio::test]
    async fn failed_refresh_falls_back_to_the_inherited_auth() {
        let inherited = InheritedHostedAuth::new(auth("parent-token", Some(0)), Some(lease()));
        let selected = inherited
            .for_turn_with(100_000, |_| async { Err(UNAVAILABLE.to_string()) })
            .await;
        assert_eq!(selected.auth.credential, "parent-token");

        let without_lease = InheritedHostedAuth::new(auth("parent-token", Some(0)), None);
        let selected = without_lease
            .for_turn_with(100_000, |_| async {
                panic!("no lease means no refresh request")
            })
            .await;
        assert_eq!(selected.auth.credential, "parent-token");
    }

    #[tokio::test]
    async fn api_keys_without_expiry_are_never_resolved_again() {
        let inherited = InheritedHostedAuth::new(auth("api-key", None), Some(lease()));
        let selected = inherited
            .for_turn_with(i64::MAX / 2, |_| async {
                panic!("credentials without an expiry stay in use")
            })
            .await;
        assert_eq!(selected.auth.credential, "api-key");
    }
}
