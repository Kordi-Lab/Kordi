use a2::{
    DefaultNotificationBuilder, NotificationBuilder, NotificationOptions, Priority, PushType,
};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use crate::calls::CallSnapshot;

use super::PushNotificationService;

impl PushNotificationService {
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
