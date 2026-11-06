//! A proactive agent is background AI: it reads new messages only for an
//! owner who allowed AI, and never reads a member who declined it.

use sqlx_core::query::query;

use super::fixture::*;
use crate::proactive::sweep::{evaluate, Outcome};

async fn set_consent(f: &Fixture, account: &str, status: &str) {
    query("UPDATE cloud_accounts SET ai_consent_status = $2 WHERE account_id = $1")
        .bind(account)
        .bind(status)
        .execute(&f.pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn an_undecided_owner_gets_no_evaluation_and_the_messages_are_passed_over() {
    let Some(f) = fixture().await else { return };
    f.seed().await;
    set_consent(&f, &f.owner, "unset").await;
    say(
        &f.pool,
        &f.member,
        f.group,
        "The deploy keeps failing, can anyone help?",
        5,
    )
    .await;
    let candidate = f.candidate(&config()).await.expect("a candidate");
    assert_eq!(
        evaluate(&f.pool, &candidate).await.unwrap(),
        Outcome::Skipped
    );
    let (seen, active, _) = f.state().await;
    assert!(active.is_none());
    assert_eq!(
        seen,
        f.latest_sequence().await,
        "passed over, not kept for later"
    );
}

#[tokio::test]
async fn a_declined_members_request_never_wakes_the_agent() {
    let Some(f) = fixture().await else { return };
    f.seed().await;
    set_consent(&f, &f.member, "declined").await;
    say(
        &f.pool,
        &f.member,
        f.group,
        "The deploy keeps failing, can anyone help?",
        5,
    )
    .await;
    if let Some(candidate) = f.candidate(&config()).await {
        assert_eq!(
            evaluate(&f.pool, &candidate).await.unwrap(),
            Outcome::Skipped
        );
    }
    assert!(f.state().await.1.is_none());
}
