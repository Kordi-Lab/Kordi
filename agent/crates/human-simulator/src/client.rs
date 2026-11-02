use anyhow::{Context, Result, bail};
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Debug)]
pub struct HttpFailure(pub StatusCode);
impl std::fmt::Display for HttpFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Service returned HTTP {}", self.0.as_u16())
    }
}
impl std::error::Error for HttpFailure {}

pub fn validate_origin(base: &str) -> Result<String> {
    let url = Url::parse(base).context("Invalid API origin")?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    anyhow::ensure!(
        url.scheme() == "https" || (url.scheme() == "http" && loopback),
        "API requires HTTPS, except loopback test servers"
    );
    anyhow::ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.path() == "/",
        "API origin must not contain credentials, a path, query, or fragment"
    );
    Ok(base.trim_end_matches('/').to_string())
}

#[derive(Clone)]
pub struct ApiClient {
    pub(crate) http: Client,
    base: String,
    token: String,
}

impl ApiClient {
    pub fn new(base: &str, token: String) -> Result<Self> {
        anyhow::ensure!(!token.trim().is_empty(), "Missing API credential");
        Ok(Self {
            base: validate_origin(base)?,
            token,
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(110))
                .build()
                .context("Cannot create API client")?,
        })
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.request(Method::GET, path, &Value::Null).await
    }

    pub async fn post<T: DeserializeOwned>(&self, path: &str, body: &impl Serialize) -> Result<T> {
        self.request(Method::POST, path, body).await
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T> {
        let mut request = self
            .http
            .request(method.clone(), format!("{}{path}", self.base))
            .bearer_auth(&self.token);
        if method != Method::GET {
            request = request.json(body);
        }
        let response = request
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("API transport failed"))?;
        decode_response(response).await
    }
}

pub async fn decode_response<T: DeserializeOwned>(mut response: reqwest::Response) -> Result<T> {
    if !response.status().is_success() {
        return Err(HttpFailure(response.status()).into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("API response interrupted"))?
    {
        anyhow::ensure!(
            bytes.len() + chunk.len() <= 2 * 1024 * 1024,
            "API response exceeds limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("Invalid API JSON response")
}

pub fn required_env(name: &str) -> Result<String> {
    std::env::var(name)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .with_context(|| format!("Set {name}"))
}

pub struct AccountCredentials {
    pub token: Option<String>,
    pub login: Option<(String, String)>,
}
impl AccountCredentials {
    pub fn from_env() -> Result<Self> {
        let login = match (
            std::env::var("KORDI_SIM_ACCOUNT_EMAIL"),
            std::env::var("KORDI_SIM_ACCOUNT_PASSWORD"),
        ) {
            (Ok(email), Ok(password)) => Some((email, password)),
            (Err(_), Err(_)) => None,
            _ => bail!("Set both account email and password, or a session token"),
        };
        Ok(Self {
            token: std::env::var("KORDI_SIM_ACCOUNT_TOKEN").ok(),
            login,
        })
    }
}

pub struct AccountClient {
    api: ApiClient,
    login: Option<(String, String)>,
}
impl AccountClient {
    pub async fn connect(
        base: &str,
        expected_account: &str,
        credentials: AccountCredentials,
    ) -> Result<Self> {
        let token = credentials.token.unwrap_or_else(|| "login-required".into());
        let mut result = Self {
            api: ApiClient::new(base, token)?,
            login: credentials.login,
        };
        if result.api.token == "login-required" {
            result.login().await?;
        }
        let me: Value = result
            .request(Method::GET, "/v1/cloud/auth/me", &Value::Null)
            .await?;
        let id = me["accountId"]
            .as_str()
            .or_else(|| me["account"]["accountId"].as_str());
        anyhow::ensure!(
            id == Some(expected_account),
            "Account credential does not match the registered actor"
        );
        Ok(result)
    }

    async fn login(&mut self) -> Result<()> {
        let (email, password) = self.login.as_ref().context(
            "Account session expired; refresh KORDI_SIM_ACCOUNT_TOKEN or configure account login",
        )?;
        let response = self
            .api
            .http
            .post(format!("{}/v1/cloud/auth/login", self.api.base))
            .json(&json!({"email":email,"password":password}))
            .send()
            .await
            .map_err(|_| anyhow::anyhow!("Account login transport failed"))?;
        let response: Value = decode_response(response).await?;
        self.api.token = response["session"]["token"]
            .as_str()
            .context("Account login returned no session")?
            .to_string();
        Ok(())
    }

    pub async fn request<T: DeserializeOwned>(
        &mut self,
        method: Method,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T> {
        match self.api.request(method.clone(), path, body).await {
            Err(error)
                if error
                    .downcast_ref::<HttpFailure>()
                    .is_some_and(|e| e.0 == StatusCode::UNAUTHORIZED) =>
            {
                self.login().await?;
                self.api.request(method, path, body).await
            }
            result => result,
        }
    }
}
