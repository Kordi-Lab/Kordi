//! Pool worker settings read from `KORDI_POOL_WORKER_*`. Errors name the
//! setting that is wrong and never repeat its value.

use std::path::PathBuf;
use std::time::Duration;

pub const DEFAULT_METADATA_URL: &str = "http://metadata.google.internal";
pub const DEFAULT_SECRET_MANAGER_URL: &str = "https://secretmanager.googleapis.com";

const DEFAULT_CONCURRENCY: usize = 2;
const MAX_CONCURRENCY: usize = 4;
const DEFAULT_POLL_MS: u64 = 2_000;
const MIN_POLL_MS: u64 = 250;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct PoolWorkerConfigError(String);

fn invalid(message: impl Into<String>) -> PoolWorkerConfigError {
    PoolWorkerConfigError(message.into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelProviderKind {
    OpenAi,
    OpenAiCompatible,
    OpenRouter,
    VertexAi,
}

impl ModelProviderKind {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "openai" => Some(Self::OpenAi),
            "openai-compatible" => Some(Self::OpenAiCompatible),
            "openrouter" => Some(Self::OpenRouter),
            "vertex-ai" => Some(Self::VertexAi),
            _ => None,
        }
    }

    /// The provider id the model loop understands.
    pub fn id(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::OpenAiCompatible => "openai-compatible",
            Self::OpenRouter => "openrouter",
            Self::VertexAi => "vertex-ai",
        }
    }
}

/// Where the model credential comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelCredentialSource {
    /// A Secret Manager version name, read with the worker identity.
    SecretManager(String),
    /// A local file holding the API key.
    ApiKeyFile(PathBuf),
    /// A Vertex AI access token from the metadata server.
    Vertex { project: String, location: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolWorkerConfig {
    pub pool_id: String,
    pub control_plane_url: String,
    pub audience: String,
    pub provider: ModelProviderKind,
    pub model: String,
    /// The model endpoint for API-key providers; built for Vertex AI.
    pub base_url: String,
    pub credential: ModelCredentialSource,
    pub worker_id: String,
    pub identity_token_file: Option<PathBuf>,
    pub concurrency: usize,
    pub poll_interval: Duration,
    /// Google endpoints; only tests point them elsewhere.
    pub(crate) metadata_url: String,
    pub(crate) secret_manager_url: String,
}

impl PoolWorkerConfig {
    pub fn from_lookup(
        get: impl Fn(&str) -> Option<String>,
    ) -> Result<Self, PoolWorkerConfigError> {
        let read = |name: &str| {
            get(&format!("KORDI_POOL_WORKER_{name}"))
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };
        let pool_id = read("POOL_ID")
            .filter(|value| is_identifier(value, 64))
            .ok_or_else(|| {
                invalid("KORDI_POOL_WORKER_POOL_ID must be 1-64 letters, digits, '.', '_' or '-'")
            })?;
        let control_plane_url = read("CONTROL_PLANE_URL")
            .and_then(|value| control_plane_url(&value))
            .ok_or_else(|| {
                invalid(
                    "KORDI_POOL_WORKER_CONTROL_PLANE_URL must be an https URL (http only for loopback)",
                )
            })?;
        let audience =
            read("AUDIENCE").ok_or_else(|| invalid("KORDI_POOL_WORKER_AUDIENCE is required"))?;
        let provider = read("PROVIDER")
            .and_then(|value| ModelProviderKind::parse(&value))
            .ok_or_else(|| {
                invalid(
                    "KORDI_POOL_WORKER_PROVIDER must be openai, openai-compatible, openrouter or vertex-ai",
                )
            })?;
        let model = read("MODEL")
            .filter(|value| !value.chars().any(|c| c.is_whitespace() || c.is_control()))
            .ok_or_else(|| invalid("KORDI_POOL_WORKER_MODEL must be a model id without spaces"))?;
        let base_url = read("BASE_URL");
        let secret = read("MODEL_SECRET");
        let key_file = read("API_KEY_FILE");
        let (base_url, credential) = if provider == ModelProviderKind::VertexAi {
            if base_url.is_some() || secret.is_some() || key_file.is_some() {
                return Err(invalid(
                    "vertex-ai must not set KORDI_POOL_WORKER_BASE_URL, KORDI_POOL_WORKER_MODEL_SECRET or KORDI_POOL_WORKER_API_KEY_FILE",
                ));
            }
            let project = read("VERTEX_PROJECT")
                .filter(|value| is_identifier_with(value, 100, ':'))
                .ok_or_else(|| {
                    invalid("vertex-ai requires a valid KORDI_POOL_WORKER_VERTEX_PROJECT")
                })?;
            let location = read("VERTEX_LOCATION")
                .filter(|value| {
                    value.len() <= 64
                        && value
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                })
                .ok_or_else(|| {
                    invalid("vertex-ai requires a valid KORDI_POOL_WORKER_VERTEX_LOCATION")
                })?;
            (
                vertex_base_url(&project, &location),
                ModelCredentialSource::Vertex { project, location },
            )
        } else {
            if read("VERTEX_PROJECT").is_some() || read("VERTEX_LOCATION").is_some() {
                return Err(invalid(
                    "KORDI_POOL_WORKER_VERTEX_PROJECT and KORDI_POOL_WORKER_VERTEX_LOCATION are only for vertex-ai",
                ));
            }
            let base_url = base_url
                .and_then(|value| model_base_url(&value))
                .ok_or_else(|| {
                    invalid("KORDI_POOL_WORKER_BASE_URL must be an https URL without credentials, query or fragment")
                })?;
            let credential = match (secret, key_file) {
                (Some(secret), None) if is_secret_version(&secret) => {
                    ModelCredentialSource::SecretManager(secret)
                }
                (Some(_), None) => {
                    return Err(invalid(
                        "KORDI_POOL_WORKER_MODEL_SECRET must look like projects/<p>/secrets/<s>/versions/<v>",
                    ))
                }
                (None, Some(path)) => ModelCredentialSource::ApiKeyFile(PathBuf::from(path)),
                _ => {
                    return Err(invalid(
                        "set exactly one of KORDI_POOL_WORKER_MODEL_SECRET or KORDI_POOL_WORKER_API_KEY_FILE",
                    ))
                }
            };
            (base_url, credential)
        };
        let worker_id = match read("ID") {
            Some(value) if is_identifier(&value, 128) => value,
            Some(_) => {
                return Err(invalid(
                    "KORDI_POOL_WORKER_ID must be 1-128 letters, digits, '.', '_' or '-'",
                ))
            }
            None => format!("pool-worker-{}", uuid::Uuid::new_v4().simple()),
        };
        let concurrency = match read("CONCURRENCY") {
            None => DEFAULT_CONCURRENCY,
            Some(value) => value
                .parse::<usize>()
                .ok()
                .filter(|value| (1..=MAX_CONCURRENCY).contains(value))
                .ok_or_else(|| invalid("KORDI_POOL_WORKER_CONCURRENCY must be 1-4"))?,
        };
        let poll_ms = match read("POLL_MS") {
            None => DEFAULT_POLL_MS,
            Some(value) => value
                .parse::<u64>()
                .ok()
                .filter(|value| *value >= MIN_POLL_MS)
                .ok_or_else(|| invalid("KORDI_POOL_WORKER_POLL_MS must be at least 250"))?,
        };
        Ok(Self {
            pool_id,
            control_plane_url,
            audience,
            provider,
            model,
            base_url,
            credential,
            worker_id,
            identity_token_file: read("IDENTITY_TOKEN_FILE").map(PathBuf::from),
            concurrency,
            poll_interval: Duration::from_millis(poll_ms),
            metadata_url: DEFAULT_METADATA_URL.to_string(),
            secret_manager_url: DEFAULT_SECRET_MANAGER_URL.to_string(),
        })
    }
}

/// The OpenAI-compatible Vertex AI endpoint for a project and location.
pub fn vertex_base_url(project: &str, location: &str) -> String {
    if location == "global" {
        format!("https://aiplatform.googleapis.com/v1/projects/{project}/locations/global/endpoints/openapi")
    } else {
        format!("https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi")
    }
}

fn is_identifier(value: &str, max: usize) -> bool {
    is_identifier_with(value, max, '-')
}

fn is_identifier_with(value: &str, max: usize, extra: char) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') || c == extra)
}

fn is_secret_version(value: &str) -> bool {
    let parts: Vec<&str> = value.split('/').collect();
    parts.len() == 6
        && parts[0] == "projects"
        && parts[2] == "secrets"
        && parts[4] == "versions"
        && [parts[1], parts[3], parts[5]]
            .iter()
            .all(|part| is_identifier_with(part, 255, ':'))
}

fn plain_url(value: &str) -> Option<reqwest::Url> {
    let url = reqwest::Url::parse(value).ok()?;
    let plain = url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none();
    plain.then_some(url)
}

fn control_plane_url(value: &str) -> Option<String> {
    let url = plain_url(value)?;
    let loopback = matches!(url.host_str()?, "127.0.0.1" | "localhost" | "[::1]" | "::1");
    let allowed = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    allowed.then(|| value.trim_end_matches('/').to_string())
}

fn model_base_url(value: &str) -> Option<String> {
    let url = plain_url(value)?;
    (url.scheme() == "https").then(|| value.trim_end_matches('/').to_string())
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
