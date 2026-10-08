//! Standard OAuth 2 token exchange shared by every connector provider.

use async_trait::async_trait;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::Deserialize;
use serde_json::Value;

use super::{
    parse_scope_list, ConnectorOAuthClient, ConnectorProvider, ConnectorSecret,
    ConnectorToolDescriptor, ProviderError, ProviderSpec, TokenGrant,
};

#[derive(Debug, Deserialize)]
struct RawTokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    /// Slack returns user tokens here.
    authed_user: Option<RawSlackUser>,
    team: Option<RawSlackTeam>,
    /// Slack signals failure with `ok: false` and HTTP 200.
    ok: Option<bool>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawSlackTeam {
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawSlackUser {
    id: Option<String>,
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
}

/// Normalizes a token endpoint body into a [`TokenGrant`].
pub(crate) fn token_grant_from_json(
    body: &Value,
    previous_refresh: Option<&str>,
    now: DateTime<Utc>,
) -> Result<TokenGrant, ProviderError> {
    let raw: RawTokenResponse =
        serde_json::from_value(body.clone()).map_err(|_| ProviderError::InvalidResponse)?;
    if raw.ok == Some(false) || raw.error.is_some() {
        return Err(ProviderError::Request(
            raw.error.unwrap_or_else(|| "provider error".to_string()),
        ));
    }
    let team_id = raw.team.and_then(|team| team.id);
    let (access, refresh, expires_in, scope, account) = match raw.access_token {
        Some(access) => (access, raw.refresh_token, raw.expires_in, raw.scope, None),
        None => {
            let user = raw.authed_user.ok_or(ProviderError::InvalidResponse)?;
            let account = team_id
                .zip(user.id)
                .map(|(team, user)| format!("{team}:{user}"));
            (
                user.access_token.ok_or(ProviderError::InvalidResponse)?,
                user.refresh_token,
                user.expires_in,
                user.scope,
                account,
            )
        }
    };
    if access.trim().is_empty() {
        return Err(ProviderError::InvalidResponse);
    }
    Ok(TokenGrant {
        secret: ConnectorSecret {
            access_token: access,
            refresh_token: refresh.or_else(|| previous_refresh.map(str::to_string)),
            expires_at: expires_in
                .filter(|seconds| *seconds > 0)
                .map(|seconds| now + ChronoDuration::seconds(seconds)),
        },
        granted_scopes: scope.as_deref().map(parse_scope_list),
        provider_account_id: account,
    })
}

/// Standard OAuth 2 code exchange, refresh, and revoke for any spec. Exposes
/// no tools by itself; [`super::ServiceProvider`] pairs it with a service.
pub struct OAuth2ConnectorProvider {
    pub(super) spec: &'static ProviderSpec,
    pub(super) http: reqwest::Client,
    token_url: String,
    client: Option<ConnectorOAuthClient>,
}

impl OAuth2ConnectorProvider {
    pub fn new(spec: &'static ProviderSpec, http: reqwest::Client) -> Self {
        Self {
            spec,
            http,
            token_url: spec.token_url.to_string(),
            client: None,
        }
    }

    /// Points token exchange and refresh at another endpoint and fixes the
    /// OAuth client, for tests against a local stub.
    pub fn with_test_endpoints(mut self, token_url: String, client: ConnectorOAuthClient) -> Self {
        self.token_url = token_url;
        self.client = Some(client);
        self
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> Result<Value, ProviderError> {
        let response = self
            .http
            .post(&self.token_url)
            .header("accept", "application/json")
            .form(form)
            .send()
            .await
            .map_err(|error| ProviderError::Request(error.without_url().to_string()))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::BAD_REQUEST
        {
            return Err(ProviderError::Unauthorized);
        }
        if !status.is_success() {
            return Err(ProviderError::Request(format!("HTTP {}", status.as_u16())));
        }
        response
            .json::<Value>()
            .await
            .map_err(|_| ProviderError::InvalidResponse)
    }
}

#[async_trait]
impl ConnectorProvider for OAuth2ConnectorProvider {
    fn spec(&self) -> &'static ProviderSpec {
        self.spec
    }

    fn tools(&self) -> &[ConnectorToolDescriptor] {
        &[]
    }

    fn oauth_client(&self) -> Result<ConnectorOAuthClient, ProviderError> {
        match &self.client {
            Some(client) => Ok(client.clone()),
            None => super::oauth_client_from_env(self.spec),
        }
    }

    async fn exchange_code(
        &self,
        client: &ConnectorOAuthClient,
        code: &str,
        code_verifier: Option<&str>,
    ) -> Result<TokenGrant, ProviderError> {
        let mut form = vec![
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
            ("code", code),
            ("redirect_uri", client.redirect_uri.as_str()),
            ("grant_type", "authorization_code"),
        ];
        if let Some(verifier) = code_verifier.filter(|_| self.spec.supports_pkce) {
            form.push(("code_verifier", verifier));
        }
        let body = self.token_request(&form).await?;
        token_grant_from_json(&body, None, Utc::now())
    }

    async fn refresh(
        &self,
        client: &ConnectorOAuthClient,
        secret: &ConnectorSecret,
    ) -> Result<ConnectorSecret, ProviderError> {
        let refresh = secret
            .refresh_token
            .as_deref()
            .ok_or(ProviderError::Unauthorized)?;
        let form = [
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
            ("refresh_token", refresh),
            ("grant_type", "refresh_token"),
        ];
        let body = self.token_request(&form).await?;
        token_grant_from_json(&body, Some(refresh), Utc::now()).map(|grant| grant.secret)
    }

    async fn revoke(
        &self,
        client: &ConnectorOAuthClient,
        secret: &ConnectorSecret,
    ) -> Result<(), ProviderError> {
        let Some(revoke_url) = self.spec.revoke_url else {
            return Ok(());
        };
        let request = match self.spec.id {
            "github" => self
                .http
                .delete(format!("{revoke_url}/{}/grant", client.client_id))
                .basic_auth(&client.client_id, Some(&client.client_secret))
                .header("accept", "application/vnd.github+json")
                .header("user-agent", "kordi-cloud-server")
                .json(&serde_json::json!({ "access_token": secret.access_token })),
            "slack" => self.http.post(revoke_url).bearer_auth(&secret.access_token),
            _ => self.http.post(revoke_url).form(&[(
                "token",
                secret
                    .refresh_token
                    .as_deref()
                    .unwrap_or(&secret.access_token),
            )]),
        };
        let response = request
            .send()
            .await
            .map_err(|error| ProviderError::Request(error.without_url().to_string()))?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(ProviderError::Request(format!(
                "HTTP {}",
                response.status().as_u16()
            )))
        }
    }

    async fn execute(
        &self,
        _tool: &str,
        _args: &Value,
        _secret: &ConnectorSecret,
        _settings: &Value,
    ) -> Result<Value, ProviderError> {
        Err(ProviderError::UnknownTool)
    }
}
