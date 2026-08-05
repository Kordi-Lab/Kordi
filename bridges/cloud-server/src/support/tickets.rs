use chrono::{Duration, Utc};
use serde_json::Value;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::mailer::SupportMailer;

#[derive(Debug, Clone)]
pub struct NewSupportTicket<'a> {
    pub account_id: &'a str,
    pub category: &'a str,
    pub subject: &'a str,
    pub description: &'a str,
    pub session_id: Option<&'a str>,
    pub diagnostics: Value,
    pub client_submission_id: &'a str,
}

#[derive(Debug, Clone)]
pub struct StoredSupportTicket {
    pub ticket_id: String,
    pub created_at: String,
    pub notification_status: String,
    pub created: bool,
}

#[derive(Debug, Clone)]
pub struct SupportTicketForDelivery {
    pub ticket_id: String,
    pub account_id: String,
    pub category: String,
    pub subject: String,
    pub description: String,
    pub session_id: Option<String>,
    pub diagnostics: Value,
    pub created_at: String,
    pub display_name: Option<String>,
    pub primary_email: Option<String>,
    pub notification_attempts: i32,
}

type DeliveryRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    Value,
    String,
    Option<String>,
    Option<String>,
    i32,
);

fn delivery_row(row: DeliveryRow) -> SupportTicketForDelivery {
    SupportTicketForDelivery {
        ticket_id: row.0,
        account_id: row.1,
        category: row.2,
        subject: row.3,
        description: row.4,
        session_id: row.5,
        diagnostics: row.6,
        created_at: row.7,
        display_name: row.8,
        primary_email: row.9,
        notification_attempts: row.10,
    }
}

pub async fn create_ticket(
    pool: &PgPool,
    input: NewSupportTicket<'_>,
) -> Result<StoredSupportTicket, sqlx_core::Error> {
    let ticket_id = format!("support_{}", uuid::Uuid::new_v4().simple());
    let now = Utc::now().to_rfc3339();
    let row: (String, String, String, bool) = query_as(
        "INSERT INTO cloud_support_tickets (
             ticket_id, account_id, category, subject, description, session_id,
             diagnostics_json, client_submission_id, notification_status,
             notification_attempts, next_notification_attempt_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 0, $9, $9, $9)
         ON CONFLICT (account_id, client_submission_id) DO UPDATE
         SET client_submission_id = cloud_support_tickets.client_submission_id
         RETURNING ticket_id, created_at, notification_status, ticket_id = $1",
    )
    .bind(&ticket_id)
    .bind(input.account_id)
    .bind(input.category)
    .bind(input.subject)
    .bind(input.description)
    .bind(input.session_id)
    .bind(input.diagnostics)
    .bind(input.client_submission_id)
    .bind(&now)
    .fetch_one(pool)
    .await?;
    Ok(StoredSupportTicket {
        ticket_id: row.0,
        created_at: row.1,
        notification_status: row.2,
        created: row.3,
    })
}

pub async fn ticket_by_submission_id(
    pool: &PgPool,
    account_id: &str,
    client_submission_id: &str,
) -> Result<Option<StoredSupportTicket>, sqlx_core::Error> {
    let row: Option<(String, String, String)> = query_as(
        "SELECT ticket_id, created_at, notification_status
         FROM cloud_support_tickets
         WHERE account_id = $1 AND client_submission_id = $2",
    )
    .bind(account_id)
    .bind(client_submission_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| StoredSupportTicket {
        ticket_id: row.0,
        created_at: row.1,
        notification_status: row.2,
        created: false,
    }))
}

async fn claim_ticket(
    pool: &PgPool,
    ticket_id: Option<&str>,
) -> Result<Option<SupportTicketForDelivery>, sqlx_core::Error> {
    let now = Utc::now();
    let stale_sending = (now - Duration::minutes(5)).to_rfc3339();
    let now = now.to_rfc3339();
    let row = query_as::<_, DeliveryRow>(
        "WITH candidate AS (
             SELECT t.ticket_id
             FROM cloud_support_tickets t
             WHERE ($1::TEXT IS NULL OR t.ticket_id = $1)
               AND t.notification_attempts < 8
               AND (
                    (t.notification_status = 'pending' AND t.next_notification_attempt_at <= $2)
                    OR (t.notification_status = 'sending' AND t.updated_at <= $3)
               )
             ORDER BY t.created_at ASC
             FOR UPDATE SKIP LOCKED
             LIMIT 1
         )
         UPDATE cloud_support_tickets t
         SET notification_status = 'sending',
             notification_attempts = t.notification_attempts + 1,
             notification_error = NULL,
             updated_at = $2
         FROM candidate
         WHERE t.ticket_id = candidate.ticket_id
         RETURNING t.ticket_id, t.account_id, t.category, t.subject, t.description,
             t.session_id, t.diagnostics_json, t.created_at,
             (SELECT display_name FROM cloud_accounts WHERE account_id = t.account_id),
             (SELECT primary_email FROM cloud_accounts WHERE account_id = t.account_id),
             t.notification_attempts",
    )
    .bind(ticket_id)
    .bind(&now)
    .bind(&stale_sending)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(delivery_row))
}

fn retry_delay_minutes(attempts: i32) -> i64 {
    match attempts {
        0 | 1 => 1,
        2 => 5,
        3 => 15,
        4 => 60,
        _ => 360,
    }
}

pub async fn deliver_ticket(
    pool: &PgPool,
    mailer: &SupportMailer,
    ticket_id: Option<&str>,
) -> Result<bool, sqlx_core::Error> {
    let Some(ticket) = claim_ticket(pool, ticket_id).await? else {
        return Ok(false);
    };
    match mailer.send(&ticket).await {
        Ok(()) => {
            let now = Utc::now().to_rfc3339();
            query(
                "UPDATE cloud_support_tickets
                 SET notification_status = 'sent', notified_at = $2, updated_at = $2
                 WHERE ticket_id = $1",
            )
            .bind(&ticket.ticket_id)
            .bind(&now)
            .execute(pool)
            .await?;
        }
        Err(error) => {
            let now = Utc::now();
            let next = (now + Duration::minutes(retry_delay_minutes(ticket.notification_attempts)))
                .to_rfc3339();
            let safe_error = error.chars().take(500).collect::<String>();
            query(
                "UPDATE cloud_support_tickets
                 SET notification_status = 'pending', notification_error = $2,
                     next_notification_attempt_at = $3, updated_at = $4
                 WHERE ticket_id = $1",
            )
            .bind(&ticket.ticket_id)
            .bind(safe_error)
            .bind(next)
            .bind(now.to_rfc3339())
            .execute(pool)
            .await?;
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use sqlx_core::query::query;

    use super::{
        claim_ticket, create_ticket, retry_delay_minutes, ticket_by_submission_id, NewSupportTicket,
    };

    #[test]
    fn notification_retry_backoff_is_bounded() {
        assert_eq!(retry_delay_minutes(1), 1);
        assert_eq!(retry_delay_minutes(2), 5);
        assert_eq!(retry_delay_minutes(3), 15);
        assert_eq!(retry_delay_minutes(4), 60);
        assert_eq!(retry_delay_minutes(8), 360);
    }

    #[tokio::test]
    async fn submissions_are_idempotent_and_sent_delivery_is_terminal() {
        let Some(database_url) = std::env::var("DATABASE_URL").ok() else {
            return;
        };
        let pool = match crate::pg::init_pool(&database_url).await {
            Ok(pool) => pool,
            Err(error) => {
                eprintln!("[support_ticket_test] init_pool failed, skipping: {error}");
                return;
            }
        };
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let account_id = format!("acct_support_test_{suffix}");
        let submission_id = format!("desktop:test:{suffix}");
        let now = Utc::now().to_rfc3339();
        query(
            "INSERT INTO cloud_accounts (
                 account_id, display_name, primary_email, created_at, updated_at
             ) VALUES ($1, 'Support test', NULL, $2, $2)",
        )
        .bind(&account_id)
        .bind(&now)
        .execute(&pool)
        .await
        .unwrap();

        let input = || NewSupportTicket {
            account_id: &account_id,
            category: "issue",
            subject: "The approval card reopened",
            description: "The same proposal must retain its terminal state.",
            session_id: Some("session:support"),
            diagnostics: serde_json::json!({}),
            client_submission_id: &submission_id,
        };
        let (first, second) =
            tokio::join!(create_ticket(&pool, input()), create_ticket(&pool, input()),);
        let first = first.unwrap();
        let second = second.unwrap();
        assert_eq!(first.ticket_id, second.ticket_id);
        assert_ne!(first.created, second.created);

        let restored = ticket_by_submission_id(&pool, &account_id, &submission_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.ticket_id, first.ticket_id);
        assert!(!restored.created);
        assert!(ticket_by_submission_id(&pool, "acct_other", &submission_id)
            .await
            .unwrap()
            .is_none());

        query(
            "UPDATE cloud_support_tickets
             SET notification_status = 'sent', updated_at = $2
             WHERE ticket_id = $1",
        )
        .bind(&restored.ticket_id)
        .bind(Utc::now().to_rfc3339())
        .execute(&pool)
        .await
        .unwrap();
        assert!(claim_ticket(&pool, Some(&restored.ticket_id))
            .await
            .unwrap()
            .is_none());

        let repeated = create_ticket(&pool, input()).await.unwrap();
        assert_eq!(repeated.ticket_id, restored.ticket_id);
        assert_eq!(repeated.notification_status, "sent");
        assert!(!repeated.created);

        query("DELETE FROM cloud_accounts WHERE account_id = $1")
            .bind(&account_id)
            .execute(&pool)
            .await
            .unwrap();
    }
}
