//! Operator access is logged, and reports follow their retention periods.
use super::*;
use kordi_cloud_server::safety::retention::sweep;

async fn new_report(h: &Harness) -> String {
    let reporter = h.signup("Retention reporter").await;
    let reported = h.signup("Retention reported").await;
    let (status, body) = h.report(&reporter, account_report(&reported)).await;
    assert_eq!(status, StatusCode::CREATED);
    body["report"]["reportId"].as_str().unwrap().to_string()
}

async fn state(pool: &PgPool, report_id: &str) -> Option<(String, Option<String>)> {
    query_as("SELECT status, resolution FROM cloud_abuse_reports WHERE report_id = $1")
        .bind(report_id)
        .fetch_optional(pool)
        .await
        .unwrap()
}

async fn access_log(pool: &PgPool, report_id: &str) -> Vec<(String, String)> {
    query_as(
        "SELECT operator_label, action FROM cloud_abuse_report_access_log \
         WHERE report_id = $1 ORDER BY access_id",
    )
    .bind(report_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn operators_read_and_close_reports_through_logged_functions() {
    let Some(h) = harness().await else { return };
    let report_id = new_report(&h).await;
    let queued: Option<(String, i32)> = query_as(
        "SELECT reason, evidence_message_count FROM kordi_safety_report_queue WHERE report_id = $1",
    )
    .bind(&report_id)
    .fetch_optional(&h.pool)
    .await
    .unwrap();
    assert_eq!(queued, Some(("spam".to_string(), 0)));

    assert!(query("SELECT * FROM kordi_safety_view_report($1, '  ')")
        .bind(&report_id)
        .execute(&h.pool)
        .await
        .is_err());
    let (viewed,): (String,) =
        query_as("SELECT report_id FROM kordi_safety_view_report($1, 'Operator One')")
            .bind(&report_id)
            .fetch_one(&h.pool)
            .await
            .unwrap();
    assert_eq!(viewed, report_id);
    assert!(
        query("SELECT kordi_safety_close_report($1, 'Operator One', 'expired_unreviewed')")
            .bind(&report_id)
            .execute(&h.pool)
            .await
            .is_err()
    );
    let close = || {
        query_as::<_, (bool,)>("SELECT kordi_safety_close_report($1, 'Operator One', 'no_action')")
            .bind(&report_id)
            .fetch_one(&h.pool)
    };
    assert!(close().await.unwrap().0);
    assert!(!close().await.unwrap().0, "a closed report stays closed");
    assert_eq!(
        state(&h.pool, &report_id).await,
        Some(("closed".to_string(), Some("no_action".to_string())))
    );
    assert_eq!(
        access_log(&h.pool, &report_id).await,
        vec![
            ("Operator One".to_string(), "view".to_string()),
            ("Operator One".to_string(), "close".to_string())
        ]
    );
    let queued: Option<(String,)> =
        query_as("SELECT report_id FROM kordi_safety_report_queue WHERE report_id = $1")
            .bind(&report_id)
            .fetch_optional(&h.pool)
            .await
            .unwrap();
    assert_eq!(queued, None);
}

#[tokio::test]
async fn unreviewed_reports_close_and_closed_reports_expire() {
    let Some(h) = harness().await else { return };
    let old = new_report(&h).await;
    let fresh = new_report(&h).await;
    query("UPDATE cloud_abuse_reports SET created_at = now() - interval '181 days' WHERE report_id = $1")
        .bind(&old)
        .execute(&h.pool)
        .await
        .unwrap();
    let now = chrono::Utc::now();
    let outcome = sweep(&h.pool, now).await.unwrap();
    assert!(outcome.expired >= 1);
    assert_eq!(
        state(&h.pool, &old).await,
        Some(("closed".to_string(), Some("expired_unreviewed".to_string())))
    );
    assert_eq!(state(&h.pool, &fresh).await.unwrap().0, "open");

    // Closed 89 days ago: kept. Closed 91 days ago: deleted with its log.
    query("SELECT * FROM kordi_safety_view_report($1, 'Operator Two')")
        .bind(&old)
        .execute(&h.pool)
        .await
        .unwrap();
    for (days, kept) in [(89, true), (91, false)] {
        query("UPDATE cloud_abuse_reports SET closed_at = $2 WHERE report_id = $1")
            .bind(&old)
            .bind(now - chrono::Duration::days(days))
            .execute(&h.pool)
            .await
            .unwrap();
        sweep(&h.pool, now).await.unwrap();
        assert_eq!(state(&h.pool, &old).await.is_some(), kept, "{days} days");
    }
    assert!(access_log(&h.pool, &old).await.is_empty());
    assert_eq!(state(&h.pool, &fresh).await.unwrap().0, "open");
}
