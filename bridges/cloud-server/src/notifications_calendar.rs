use super::PushNotificationService;
use a2::{request::payload::PayloadLike, CollapseId, NotificationOptions, Priority, PushType};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Payload<'a> {
    aps: Value,
    account_id: &'a str,
    calendar_event_id: &'a str,
    #[serde(skip)]
    device_token: &'a str,
    #[serde(skip)]
    options: NotificationOptions<'a>,
}
impl std::fmt::Debug for Payload<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CalendarPushPayload { redacted }")
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
    pub fn spawn_calendar_worker(&self, pool: PgPool) -> tokio::task::JoinHandle<()> {
        let service = self.clone();
        tokio::spawn(async move {
            let mut timer = tokio::time::interval(std::time::Duration::from_secs(5));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                timer.tick().await;
                if service.deliver_calendar_reminders(&pool).await.is_err() {
                    eprintln!(
                        "[calendar] Reminder delivery failed; pending deliveries will retry."
                    );
                }
            }
        })
    }
    async fn deliver_calendar_reminders(&self, pool: &PgPool) -> Result<(), sqlx_core::Error> {
        query("INSERT INTO cloud_calendar_reminder_deliveries(account_id,event_id,revision,device_id)
          SELECT e.account_id,e.event_id,e.revision,p.device_id FROM cloud_calendar_events e
          JOIN cloud_apns_push_tokens p ON p.account_id=e.account_id AND p.apns_environment=$1
          JOIN cloud_devices d ON d.device_id=p.device_id AND d.account_id=p.account_id AND d.revoked_at IS NULL
          WHERE e.payload->>'reminderAt' IS NOT NULL AND (e.payload->>'reminderAt')::timestamptz<=now()
          AND (e.payload->>'startAt')::timestamptz+interval '1 hour'>now()
          AND EXISTS(SELECT 1 FROM cloud_refresh_tokens s WHERE s.device_id=d.device_id AND s.account_id=e.account_id AND s.revoked_at IS NULL AND s.expires_at::timestamptz>now())
          ON CONFLICT DO NOTHING").bind(&self.environment).execute(pool).await?;
        type Delivery = (String, String, i64, String, Value, String);
        let pending:Vec<Delivery>=query_as("SELECT r.account_id,r.event_id,r.revision,r.device_id,e.payload,p.device_token
          FROM cloud_calendar_reminder_deliveries r JOIN cloud_calendar_events e ON e.account_id=r.account_id AND e.event_id=r.event_id AND e.revision=r.revision
          JOIN cloud_apns_push_tokens p ON p.account_id=r.account_id AND p.device_id=r.device_id AND p.apns_environment=$1
          JOIN cloud_devices d ON d.device_id=p.device_id AND d.account_id=p.account_id AND d.revoked_at IS NULL
          WHERE r.accepted_at IS NULL AND r.attempts<8 AND r.next_attempt_at<=now()
          AND (e.payload->>'startAt')::timestamptz+interval '1 hour'>now()
          AND EXISTS(SELECT 1 FROM cloud_refresh_tokens s WHERE s.device_id=d.device_id AND s.account_id=r.account_id AND s.revoked_at IS NULL AND s.expires_at::timestamptz>now())
          ORDER BY r.next_attempt_at LIMIT 100").bind(&self.environment).fetch_all(pool).await?;
        for (account, event_id, revision, device, payload, token) in pending {
            let changed=query("UPDATE cloud_calendar_reminder_deliveries SET attempts=attempts+1,next_attempt_at=now()+interval '30 seconds' WHERE account_id=$1 AND event_id=$2 AND revision=$3 AND device_id=$4 AND accepted_at IS NULL AND next_attempt_at<=now()")
                .bind(&account).bind(&event_id).bind(revision).bind(&device).execute(pool).await?;
            if changed.rows_affected() == 0 {
                continue;
            }
            let Ok(event) = serde_json::from_value::<crate::digest::models::CalendarEvent>(payload)
            else {
                continue;
            };
            if !crate::digest::authorized(pool, &account, &event.source_ids).await? {
                continue;
            }
            let current:Option<(i64,)>=query_as("SELECT revision FROM cloud_calendar_events WHERE account_id=$1 AND event_id=$2 AND revision=$3").bind(&account).bind(&event_id).bind(revision).fetch_optional(pool).await?;
            if current.is_none() {
                continue;
            }
            let collapse = hex::encode(Sha256::digest(
                format!("{account}:{event_id}:{revision}:{device}").as_bytes(),
            ));
            let expires = chrono::DateTime::parse_from_rfc3339(&event.start_at)
                .map(|d| d.timestamp() + 3600)
                .unwrap_or(Utc::now().timestamp());
            let notification = Payload {
                aps: json!({"alert":{"title":"Kordi calendar","body":"You have a calendar reminder."},"sound":"default","category":"KORDI_CALENDAR"}),
                account_id: &account,
                calendar_event_id: &event_id,
                device_token: &token,
                options: NotificationOptions {
                    apns_push_type: Some(PushType::Alert),
                    apns_priority: Some(Priority::High),
                    apns_topic: Some(&self.application_topic),
                    apns_expiration: Some(expires.max(0) as u64),
                    apns_collapse_id: CollapseId::new(&collapse).ok(),
                    ..Default::default()
                },
            };
            if matches!(
                tokio::time::timeout(
                    std::time::Duration::from_secs(20),
                    self.client.send(notification)
                )
                .await,
                Ok(Ok(_))
            ) {
                query("UPDATE cloud_calendar_reminder_deliveries SET accepted_at=now() WHERE account_id=$1 AND event_id=$2 AND revision=$3 AND device_id=$4").bind(&account).bind(&event_id).bind(revision).bind(&device).execute(pool).await?;
            }
        }
        Ok(())
    }
}
