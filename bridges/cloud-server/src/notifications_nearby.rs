//! The push for a Grounding nearby alert (#2100). It goes to the recipient's
//! devices that take message notifications, with the same preview, sound and
//! session rules as a message push; tapping it opens the nearby person.

use a2::{request::payload::PayloadLike, CollapseId, NotificationOptions, Priority, PushType};
use serde::Serialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

use super::PushNotificationService;

const THREAD: &str = "common-ground-nearby";
const PRIVATE_TITLE: &str = "Nearby";
const PRIVATE_BODY: &str = "Someone nearby matches what you're looking for";

/// What the push says and who it is about.
pub struct NearbyAlertPush<'a> {
    pub account_id: &'a str,
    pub other_account_id: &'a str,
    pub alert_id: &'a str,
    pub title: &'a str,
    pub body: &'a str,
}

#[derive(Serialize)]
struct Payload<'a> {
    aps: Value,
    notification_type: &'static str,
    account_id: &'a str,
    other_account_id: &'a str,
    alert_id: &'a str,
    #[serde(skip)]
    device_token: &'a str,
    #[serde(skip)]
    options: NotificationOptions<'a>,
}

impl std::fmt::Debug for Payload<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("NearbyAlertPushPayload { redacted }")
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

/// The `aps` dictionary: the alert, or the private one with previews off.
fn aps(push: &NearbyAlertPush<'_>, previews: bool, sound: bool) -> Value {
    let (title, body) = match previews {
        true => (push.title, push.body),
        false => (PRIVATE_TITLE, PRIVATE_BODY),
    };
    let mut aps = json!({ "alert": { "title": title, "body": body }, "thread-id": THREAD });
    if sound {
        aps["sound"] = json!("default");
    }
    aps
}

impl PushNotificationService {
    /// Best effort: one attempt per device, a dead token is removed.
    pub async fn send_nearby_alert(&self, pool: &PgPool, push: &NearbyAlertPush<'_>) {
        let tokens: Vec<(String, String, bool, bool)> = match query_as(
            "SELECT push.device_id, push.device_token, push.message_sound_enabled, \
                    push.message_previews_enabled \
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
                eprintln!("[notifications] load nearby alert devices: {error}");
                return;
            }
        };
        let collapse = format!("cg-nearby-{}", push.other_account_id);
        for (device_id, device_token, sound, previews) in tokens {
            let payload = Payload {
                aps: aps(push, previews, sound),
                notification_type: "common_ground_nearby",
                account_id: push.account_id,
                other_account_id: push.other_account_id,
                alert_id: push.alert_id,
                device_token: &device_token,
                options: NotificationOptions {
                    apns_push_type: Some(PushType::Alert),
                    apns_priority: Some(Priority::High),
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
                Err(_) => eprintln!("[notifications] nearby alert push failed"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_off_hides_who_and_why() {
        let push = NearbyAlertPush {
            account_id: "acct_r",
            other_account_id: "acct_o",
            alert_id: "cgna_1",
            title: "Maya Chen is nearby",
            body: "Someone founding a startup · Under 500 m",
        };
        assert_eq!(
            aps(&push, true, true),
            json!({
                "alert": { "title": "Maya Chen is nearby", "body": "Someone founding a startup · Under 500 m" },
                "thread-id": "common-ground-nearby",
                "sound": "default",
            })
        );
        assert_eq!(
            aps(&push, false, false),
            json!({
                "alert": { "title": "Nearby", "body": "Someone nearby matches what you're looking for" },
                "thread-id": "common-ground-nearby",
            })
        );
    }
}
