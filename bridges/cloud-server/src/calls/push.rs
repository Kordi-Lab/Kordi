use std::io::Cursor;

use a2::{
    Client, ClientConfig, DefaultNotificationBuilder, Endpoint, NotificationBuilder,
    NotificationOptions, Priority, PushType,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::calls::models::CallSnapshot;

#[derive(Clone)]
pub struct CallPushConfig {
    client: Client,
    environment: String,
    application_topic: String,
    voip_topic: String,
}

#[derive(Debug, thiserror::Error)]
pub enum CallPushConfigError {
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

impl CallPushConfig {
    pub fn from_env() -> Result<Option<Self>, CallPushConfigError> {
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
                    _ => return Err(CallPushConfigError::InvalidEnvironment),
                };
                if bundle_id.len() > 200
                    || bundle_id.split('.').count() < 2
                    || !bundle_id
                        .bytes()
                        .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'.' | b'-'))
                {
                    return Err(CallPushConfigError::InvalidBundleId);
                }
                let private_key = STANDARD
                    .decode(private_key)
                    .map_err(|_| CallPushConfigError::InvalidPrivateKey)?;
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
            _ => Err(CallPushConfigError::Incomplete),
        }
    }

    pub async fn send_incoming_call(&self, pool: &PgPool, call: &CallSnapshot, caller_name: &str) {
        let recipients = call
            .participants
            .iter()
            .filter(|participant| participant.state == "invited")
            .map(|participant| participant.account_id.clone())
            .collect::<Vec<_>>();
        if recipients.is_empty() {
            return;
        }
        let tokens: Vec<(String,)> = match query_as(
            "SELECT push.device_token FROM cloud_voip_push_tokens push \
             JOIN cloud_devices device ON device.device_id = push.device_id \
             WHERE push.account_id = ANY($1) AND push.apns_environment = $2 \
               AND device.revoked_at IS NULL",
        )
        .bind(&recipients)
        .bind(&self.environment)
        .fetch_all(pool)
        .await
        {
            Ok(tokens) => tokens,
            Err(error) => {
                eprintln!("[calls] load incoming-call recipients: {error}");
                return;
            }
        };

        for (device_token,) in tokens {
            let mut payload = DefaultNotificationBuilder::new()
                .set_content_available()
                .build(
                    &device_token,
                    NotificationOptions {
                        apns_push_type: Some(PushType::Voip),
                        apns_priority: Some(Priority::High),
                        apns_topic: Some(&self.voip_topic),
                        apns_expiration: Some(0),
                        ..Default::default()
                    },
                );
            let call_id = call.id.to_string();
            let conversation_id = call.conversation_id.to_string();
            if payload.add_custom_data("call_id", &call_id).is_err()
                || payload
                    .add_custom_data("conversation_id", &conversation_id)
                    .is_err()
                || payload
                    .add_custom_data("caller_account_id", &call.created_by_account_id)
                    .is_err()
                || payload
                    .add_custom_data("caller_name", &caller_name)
                    .is_err()
                || payload
                    .add_custom_data("kind", &call.kind.as_str())
                    .is_err()
            {
                eprintln!("[calls] could not encode incoming-call notification");
                continue;
            }
            if let Err(error) = self.client.send(payload).await {
                eprintln!("[calls] APNs rejected an incoming-call notification: {error}");
            }
        }
    }

    pub async fn send_group_meeting(&self, pool: &PgPool, call: &CallSnapshot, caller_name: &str) {
        let recipients = call
            .participants
            .iter()
            .filter(|participant| participant.state == "invited")
            .map(|participant| participant.account_id.clone())
            .collect::<Vec<_>>();
        if recipients.is_empty() {
            return;
        }
        let tokens: Vec<(String,)> = match query_as(
            "SELECT push.device_token FROM cloud_apns_push_tokens push \
             JOIN cloud_devices device ON device.device_id = push.device_id \
             WHERE push.account_id = ANY($1) AND push.apns_environment = $2 \
               AND device.revoked_at IS NULL",
        )
        .bind(&recipients)
        .bind(&self.environment)
        .fetch_all(pool)
        .await
        {
            Ok(tokens) => tokens,
            Err(error) => {
                eprintln!("[calls] load meeting notification recipients: {error}");
                return;
            }
        };

        let body = format!("{caller_name} started a video chat.");
        for (device_token,) in tokens {
            let mut payload = DefaultNotificationBuilder::new()
                .set_title("Kordi meeting")
                .set_body(&body)
                .set_sound("default")
                .build(
                    &device_token,
                    NotificationOptions {
                        apns_push_type: Some(PushType::Alert),
                        apns_priority: Some(Priority::High),
                        apns_topic: Some(&self.application_topic),
                        ..Default::default()
                    },
                );
            let call_id = call.id.to_string();
            let conversation_id = call.conversation_id.to_string();
            if payload.add_custom_data("call_id", &call_id).is_err()
                || payload
                    .add_custom_data("conversation_id", &conversation_id)
                    .is_err()
                || payload
                    .add_custom_data("kind", &call.kind.as_str())
                    .is_err()
            {
                eprintln!("[calls] could not encode meeting notification");
                continue;
            }
            if let Err(error) = self.client.send(payload).await {
                eprintln!("[calls] APNs rejected a meeting notification: {error}");
            }
        }
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}
