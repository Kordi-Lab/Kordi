use std::io::Cursor;

use a2::{Client, ClientConfig, Endpoint};
use base64::{engine::general_purpose::STANDARD, Engine as _};

#[path = "notifications_calendar.rs"]
mod calendar;
#[path = "notifications_calls.rs"]
mod calls;
#[path = "notifications_message.rs"]
mod message;

pub(crate) use message::{is_agent_authored_message, is_frontend_visible_message};

#[derive(Clone)]
pub struct PushNotificationService {
    pub(super) client: Client,
    pub(super) environment: String,
    pub(super) application_topic: String,
    pub(super) voip_topic: String,
}

#[derive(Debug, thiserror::Error)]
pub enum PushNotificationConfigError {
    #[error("KORDI_APNS_ENVIRONMENT, KORDI_APNS_KEY_ID, KORDI_APNS_TEAM_ID, KORDI_APNS_PRIVATE_KEY_BASE64, and KORDI_APNS_BUNDLE_ID must be configured together")]
    Incomplete,
    #[error("KORDI_APNS_ENVIRONMENT must be development or production")]
    InvalidEnvironment,
    #[error("KORDI_APNS_BUNDLE_ID is invalid")]
    InvalidBundleId,
    #[error("KORDI_APNS_PRIVATE_KEY_BASE64 is invalid")]
    InvalidPrivateKey,
    #[error("could not configure the APNs client")]
    Client(#[from] a2::Error),
}

impl PushNotificationService {
    pub fn from_env() -> Result<Option<Self>, PushNotificationConfigError> {
        let environment = non_empty_env("KORDI_APNS_ENVIRONMENT");
        let key_id = non_empty_env("KORDI_APNS_KEY_ID");
        let team_id = non_empty_env("KORDI_APNS_TEAM_ID");
        let private_key = non_empty_env("KORDI_APNS_PRIVATE_KEY_BASE64");
        let bundle_id = non_empty_env("KORDI_APNS_BUNDLE_ID");
        match (environment, key_id, team_id, private_key, bundle_id) {
            (None, None, None, None, None) => Ok(None),
            (
                Some(environment),
                Some(key_id),
                Some(team_id),
                Some(private_key),
                Some(bundle_id),
            ) => {
                let endpoint = match environment.as_str() {
                    "development" => Endpoint::Sandbox,
                    "production" => Endpoint::Production,
                    _ => return Err(PushNotificationConfigError::InvalidEnvironment),
                };
                if bundle_id.len() > 200
                    || bundle_id.split('.').count() < 2
                    || !bundle_id
                        .bytes()
                        .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'.' | b'-'))
                {
                    return Err(PushNotificationConfigError::InvalidBundleId);
                }
                let private_key = STANDARD
                    .decode(private_key)
                    .map_err(|_| PushNotificationConfigError::InvalidPrivateKey)?;
                let client = Client::token(
                    Cursor::new(private_key),
                    key_id,
                    team_id,
                    ClientConfig::new(endpoint),
                )?;
                Ok(Some(Self {
                    client,
                    environment,
                    application_topic: bundle_id.clone(),
                    voip_topic: format!("{bundle_id}.voip"),
                }))
            }
            _ => Err(PushNotificationConfigError::Incomplete),
        }
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
