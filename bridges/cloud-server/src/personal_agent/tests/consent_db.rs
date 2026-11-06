//! A personal agent's sweep is background AI: it reads new events only for
//! an owner who allowed AI.

use sqlx_core::query::query;

use super::fixture::*;

#[tokio::test]
async fn an_undecided_owner_gets_no_evaluation() {
    let Some(f) = fixture().await else { return };
    query("UPDATE cloud_accounts SET ai_consent_status = 'unset' WHERE account_id = $1")
        .bind(&f.owner)
        .execute(&f.pool)
        .await
        .unwrap();
    f.watching().await;
    f.mail("Sam <sam@example.com>", "Dinner tonight?", 120)
        .await;
    let candidate = f.candidate(&quick()).await.expect("a candidate");
    let outcome = crate::personal_agent::sweep::evaluate(&f.pool, &candidate)
        .await
        .unwrap();
    assert_eq!(outcome, crate::personal_agent::sweep::Outcome::Skipped);
    assert!(f.state().await.1.is_none(), "no evaluation run");
}
