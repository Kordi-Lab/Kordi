//! Configuration for live connector events (webhooks and push) and the
//! polling fallback, read once from the environment.

use std::fmt;

pub const DEFAULT_POLL_MINUTES: i64 = 15;
const MAX_POLL_MINUTES: i64 = 24 * 60;
pub const GOOGLE_TOKENINFO_URL: &str = "https://oauth2.googleapis.com/tokeninfo";

#[derive(Clone)]
pub struct ConnectorHooks {
    /// `KORDI_CONNECTOR_GITHUB_WEBHOOK_SECRET`: HMAC key for
    /// `X-Hub-Signature-256`.
    pub github_webhook_secret: Option<String>,
    /// `KORDI_CONNECTOR_SLACK_SIGNING_SECRET`.
    pub slack_signing_secret: Option<String>,
    /// `KORDI_CONNECTOR_GOOGLE_PUSH_AUDIENCE`: the audience of the Pub/Sub
    /// push OIDC token. Without it Google push is rejected.
    pub google_push_audience: Option<String>,
    /// `KORDI_CONNECTOR_GOOGLE_PUSH_SERVICE_ACCOUNT`: the service account
    /// email the push subscription signs as. Required with the audience,
    /// because any Google service account can mint a token for any audience.
    pub google_push_service_account: Option<String>,
    /// `KORDI_CONNECTOR_GMAIL_PUBSUB_TOPIC`: `projects/<p>/topics/<t>` for
    /// Gmail `users.watch`.
    pub gmail_pubsub_topic: Option<String>,
    /// Google's token info endpoint; tests point it at a local stub.
    pub google_tokeninfo_url: String,
    /// `KORDI_CONNECTOR_POLL_MINUTES`, default 15, accepted 1 to 1440.
    pub poll_minutes: i64,
}

impl Default for ConnectorHooks {
    fn default() -> Self {
        Self {
            github_webhook_secret: None,
            slack_signing_secret: None,
            google_push_audience: None,
            google_push_service_account: None,
            gmail_pubsub_topic: None,
            google_tokeninfo_url: GOOGLE_TOKENINFO_URL.to_string(),
            poll_minutes: DEFAULT_POLL_MINUTES,
        }
    }
}

impl fmt::Debug for ConnectorHooks {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectorHooks")
            .field("github_webhook", &self.github_webhook_secret.is_some())
            .field("slack_signing", &self.slack_signing_secret.is_some())
            .field("google_push_audience", &self.google_push_audience)
            .field("gmail_pubsub_topic", &self.gmail_pubsub_topic)
            .field("poll_minutes", &self.poll_minutes)
            .finish_non_exhaustive()
    }
}

fn env_value(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Parses `KORDI_CONNECTOR_POLL_MINUTES`, falling back to 15.
pub fn poll_minutes_from(value: Option<&str>) -> i64 {
    value
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|minutes| (1..=MAX_POLL_MINUTES).contains(minutes))
        .unwrap_or(DEFAULT_POLL_MINUTES)
}

impl ConnectorHooks {
    pub fn from_env() -> Self {
        Self {
            github_webhook_secret: env_value("KORDI_CONNECTOR_GITHUB_WEBHOOK_SECRET"),
            slack_signing_secret: env_value("KORDI_CONNECTOR_SLACK_SIGNING_SECRET"),
            google_push_audience: env_value("KORDI_CONNECTOR_GOOGLE_PUSH_AUDIENCE"),
            google_push_service_account: env_value("KORDI_CONNECTOR_GOOGLE_PUSH_SERVICE_ACCOUNT"),
            gmail_pubsub_topic: env_value("KORDI_CONNECTOR_GMAIL_PUBSUB_TOPIC"),
            google_tokeninfo_url: GOOGLE_TOKENINFO_URL.to_string(),
            poll_minutes: poll_minutes_from(env_value("KORDI_CONNECTOR_POLL_MINUTES").as_deref()),
        }
    }

    /// Gmail push needs the topic and a verifiable push token.
    pub fn gmail_push_enabled(&self) -> bool {
        self.gmail_pubsub_topic.is_some()
            && self.google_push_audience.is_some()
            && self.google_push_service_account.is_some()
    }
}
