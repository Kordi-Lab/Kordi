//! The push for a usage threshold notice. It goes to an organization owner's
//! devices that take message notifications, once per threshold and window;
//! tapping it opens the app, where Settings shows the organization's usage.

use a2::{request::payload::PayloadLike, CollapseId, NotificationOptions, Priority, PushType};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::PushNotificationService;

/// What the push says and whom it is for.
pub struct UsageNoticePush<'a> {
    pub account_id: &'a str,
    pub organization_id: &'a str,
    pub body: &'a str,
}

#[derive(Serialize)]
struct Payload<'a> {
    aps: Value,
    notification_type: &'static str,
    account_id: &'a str,
    organization_id: &'a str,
    #[serde(skip)]
    device_token: &'a str,
    #[serde(skip)]
    options: NotificationOptions<'a>,
}

impl std::fmt::Debug for Payload<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UsageNoticePushPayload { redacted }")
    }
}

impl PayloadLike for Payload<'_> {
    fn get_device_token(&self) -> &str {
        self.device_token
    }
    fn get_options(&self) -> &NotificationOptions<'_> {
        &self.options
    }
}

impl PushNotificationService {
    /// Best effort: one attempt per device, a dead token is removed.
    pub async fn send_usage_notice(&self, pool: &PgPool, push: &UsageNoticePush<'_>) {
        let tokens: Vec<(String, String, bool)> = match query_as(
            "SELECT push.device_id, push.device_token, push.message_sound_enabled \
             FROM cloud_apns_push_tokens push \
             JOIN cloud_devices device ON device.device_id = push.device_id \
             WHERE push.account_id = $1 AND push.apns_environment = $2 \
               AND push.message_notifications_enabled AND device.revoked_at IS NULL \
               AND device.account_id = push.account_id \
               AND EXISTS (SELECT 1 FROM cloud_refresh_tokens session \
                           WHERE session.device_id = device.device_id \
                             AND session.account_id = push.account_id \
                             AND session.revoked_at IS NULL \
                             AND session.expires_at::timestamptz > NOW())",
        )
        .bind(push.account_id)
        .bind(&self.environment)
        .fetch_all(pool)
        .await
        {
            Ok(tokens) => tokens,
            Err(error) => {
                eprintln!("[notifications] load usage notice devices: {error}");
                return;
            }
        };
        let collapse = format!("usage:{}", push.organization_id);
        for (device_id, device_token, sound) in tokens {
            let mut aps = json!({"alert": {"title": "Kordi", "body": push.body}});
            if sound {
                aps["sound"] = json!("default");
            }
            let payload = Payload {
                aps,
                notification_type: "usage_notice",
                account_id: push.account_id,
                organization_id: push.organization_id,
                device_token: &device_token,
                options: NotificationOptions {
                    apns_push_type: Some(PushType::Alert),
                    apns_priority: Some(Priority::Normal),
                    apns_topic: Some(&self.application_topic),
                    apns_collapse_id: CollapseId::new(&collapse).ok(),
                    ..Default::default()
                },
            };
            match self.client.send(payload).await {
                Ok(_) => {}
                Err(error) if super::message::is_permanent_token_error(&error) => {
                    let removed = query(
                        "DELETE FROM cloud_apns_push_tokens \
                         WHERE device_id = $1 AND device_token = $2 AND apns_environment = $3",
                    )
                    .bind(&device_id)
                    .bind(&device_token)
                    .bind(&self.environment)
                    .execute(pool)
                    .await;
                    if let Err(error) = removed {
                        eprintln!("[notifications] remove dead push token: {error}");
                    }
                }
                Err(error) => {
                    eprintln!("[notifications] usage notice push failed: {error}");
                }
            }
        }
    }
}
