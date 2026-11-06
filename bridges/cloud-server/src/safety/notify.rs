//! Tells the support inbox about each new report, so a person reviews it.
//!
//! The notice carries metadata only: the reference, reason, target kind,
//! message count, the reported account id, and how to open the report through the logged
//! operator function. Report details and copied messages stay in the report.
//! Delivery uses the support mailer (`KORDI_SUPPORT_INBOX` and the
//! `KORDI_SUPPORT_SMTP_*` settings) and retries with backoff; without a
//! mailer, reports wait in `kordi_safety_report_queue`.

use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::reports::reference;
use crate::server::ServerState;
use crate::support::SupportService;

const MAX_ATTEMPTS: i32 = 8;
const SWEEP_INTERVAL: Duration = Duration::from_secs(30);

/// One claimed notice: report id, reason, target kind, message count,
/// reported account, created at, attempts so far.
type NoticeRow = (
    String,
    String,
    String,
    i32,
    Option<String>,
    DateTime<Utc>,
    i32,
);

/// Subject and body of the support notice for a claimed report.
pub(crate) fn notice_text(row: &NoticeRow) -> (String, String) {
    let (report_id, reason, target_kind, count, reported, created_at, _) = row;
    let reference = reference(report_id);
    let subject = format!("[Kordi report] {reference} {reason}");
    let body = format!(
        "A person reported another account in Kordi. Review it within 24 hours.\n\n\
         Reference: {reference}\nReport: {report_id}\nReason: {reason}\nTarget: {target_kind}\n\
         Messages included: {count}\nReported account: {}\nCreated: {}\n\n\
         Open it through the operator database path (every read is logged):\n\
         SELECT * FROM kordi_safety_view_report('{report_id}', '<your name>');\n\n\
         This notice never contains report details or messages.",
        reported.as_deref().unwrap_or("deleted account"),
        created_at.to_rfc3339(),
    );
    (subject, body)
}

fn retry_delay(attempts: i32) -> chrono::Duration {
    chrono::Duration::minutes(match attempts {
        0 | 1 => 1,
        2 => 5,
        3 => 15,
        4 => 60,
        _ => 360,
    })
}

async fn claim(
    pool: &PgPool,
    report_id: Option<&str>,
) -> Result<Option<NoticeRow>, sqlx_core::Error> {
    query_as(
        "WITH candidate AS ( \
             SELECT report_id FROM cloud_abuse_reports \
             WHERE ($1::TEXT IS NULL OR report_id = $1) \
               AND notification_attempts < $2 \
               AND ((notification_status = 'pending' AND next_notification_at <= now()) \
                 OR (notification_status = 'sending' \
                     AND next_notification_at <= now() - INTERVAL '5 minutes')) \
             ORDER BY created_at \
             FOR UPDATE SKIP LOCKED \
             LIMIT 1) \
         UPDATE cloud_abuse_reports report \
         SET notification_status = 'sending', \
             notification_attempts = report.notification_attempts + 1, \
             next_notification_at = now() \
         FROM candidate WHERE report.report_id = candidate.report_id \
         RETURNING report.report_id, report.reason, report.target_kind, \
                   report.evidence_message_count, report.reported_account_id, \
                   report.created_at, report.notification_attempts",
    )
    .bind(report_id)
    .bind(MAX_ATTEMPTS)
    .fetch_optional(pool)
    .await
}

/// Sends one pending notice (the given report's, or the oldest due one).
/// Returns whether a notice was claimed.
pub(crate) async fn deliver_one(
    pool: &PgPool,
    service: &SupportService,
    report_id: Option<&str>,
) -> Result<bool, sqlx_core::Error> {
    let Some(row) = claim(pool, report_id).await? else {
        return Ok(false);
    };
    let (subject, body) = notice_text(&row);
    let attempts = row.6;
    match service.send_notice(&subject, body).await {
        Ok(true) => {
            query(
                "UPDATE cloud_abuse_reports \
                 SET notification_status = 'sent', notified_at = now() WHERE report_id = $1",
            )
            .bind(&row.0)
            .execute(pool)
            .await?;
        }
        Ok(false) | Err(_) => {
            let status = if attempts >= MAX_ATTEMPTS {
                "failed"
            } else {
                "pending"
            };
            eprintln!("[safety] report notice attempt {attempts} did not send");
            query(
                "UPDATE cloud_abuse_reports \
                 SET notification_status = $2, next_notification_at = $3 WHERE report_id = $1",
            )
            .bind(&row.0)
            .bind(status)
            .bind(Utc::now() + retry_delay(attempts))
            .execute(pool)
            .await?;
        }
    }
    Ok(true)
}

/// Tries to send a new report's notice right away; the worker retries.
pub(crate) fn deliver_soon(state: &Arc<ServerState>, report_id: String) {
    let Some(service) = state.support().cloned() else {
        return;
    };
    if !service.mail_delivery_enabled() {
        return;
    }
    let pool = state.db_pool().clone();
    tokio::spawn(async move {
        if deliver_one(&pool, &service, Some(&report_id))
            .await
            .is_err()
        {
            eprintln!("[safety] report notice delivery failed; the worker retries");
        }
    });
}

/// Starts the worker that sends report notices to the support inbox.
pub fn spawn_report_notice_worker(state: Arc<ServerState>) {
    let Some(service) = state.support().cloned() else {
        println!(
            "Kordi abuse reports wait in kordi_safety_report_queue; support is not configured"
        );
        return;
    };
    if !service.mail_delivery_enabled() {
        println!("Kordi abuse reports wait in kordi_safety_report_queue until SMTP is configured");
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            for _ in 0..10 {
                match deliver_one(state.db_pool(), &service, None).await {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(_) => {
                        eprintln!("[safety] report notice worker failed; retrying later");
                        break;
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_carry_metadata_and_no_report_content() {
        let row: NoticeRow = (
            "rpt_0123abcdef4567890123456789abcdef".into(),
            "harassment".into(),
            "message".into(),
            2,
            Some("acct_reported".into()),
            Utc::now(),
            1,
        );
        let (subject, body) = notice_text(&row);
        assert_eq!(subject, "[Kordi report] R-0123ABCD harassment");
        assert!(body.contains("Reported account: acct_reported"));
        assert!(!body.contains("Reporter"));
        assert!(body.contains("kordi_safety_view_report('rpt_0123abcdef4567890123456789abcdef'"));
    }

    #[test]
    fn retries_back_off() {
        assert!(retry_delay(1) < retry_delay(3));
        assert_eq!(retry_delay(9), chrono::Duration::minutes(360));
    }
}
