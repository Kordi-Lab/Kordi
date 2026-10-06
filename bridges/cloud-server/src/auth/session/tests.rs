//! Session lifecycle checks against a real Postgres at `$DATABASE_URL`.
//! Skipped when `DATABASE_URL` is unset.

use super::*;

async fn pool() -> Option<PgPool> {
    let url = std::env::var("DATABASE_URL").ok()?;
    Some(crate::pg::init_pool(&url).await.expect("init test pool"))
}

async fn account_with_device(pool: &PgPool) -> (String, String) {
    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let account_id = format!("acct_session_{suffix}");
    let device_id = format!("dev_session_{suffix}");
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_accounts \
         (account_id, display_name, primary_email, created_at, updated_at, avatar_source, \
          avatar_style, avatar_seed, avatar_renderer_version, avatar_version, avatar_updated_at) \
         VALUES ($1, 'Session', $2, $3, $3, 'generated', 'lorelei', $1, 'fixture', 1, $3)",
    )
    .bind(&account_id)
    .bind(format!("{account_id}@example.test"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    query(
        "INSERT INTO cloud_devices (device_id, account_id, device_name, device_public_key, created_at, last_seen_at) \
         VALUES ($1, $2, 'Session device', $3, $4, $4)",
    )
    .bind(&device_id)
    .bind(&account_id)
    .bind(format!("legacy:{suffix}"))
    .bind(&now)
    .execute(pool)
    .await
    .unwrap();
    (account_id, device_id)
}

#[tokio::test]
async fn signed_out_sessions_stop_long_lived_connections() {
    let Some(pool) = pool().await else { return };
    let (account_id, device_id) = account_with_device(&pool).await;
    let kept = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    let signed_out = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();

    assert!(
        session_is_active(&pool, &account_id, &device_id, &signed_out.token_id)
            .await
            .unwrap()
    );
    revoke_session(&pool, &signed_out.token_id).await.unwrap();

    assert!(
        !session_is_active(&pool, &account_id, &device_id, &signed_out.token_id)
            .await
            .unwrap(),
        "a signed-out session must not keep a connection open"
    );
    assert!(
        device_is_active(&pool, &account_id, &device_id)
            .await
            .unwrap(),
        "signing out one session leaves the device authorized"
    );
    assert!(
        session_is_active(&pool, &account_id, &device_id, &kept.token_id)
            .await
            .unwrap(),
        "other sessions on the device are unaffected"
    );
    assert!(
        !session_is_active(&pool, "acct_other", &device_id, &kept.token_id)
            .await
            .unwrap(),
        "a session is bound to its own account"
    );
}

#[tokio::test]
async fn expired_sessions_and_revoked_devices_stop_long_lived_connections() {
    let Some(pool) = pool().await else { return };
    let (account_id, device_id) = account_with_device(&pool).await;
    let session = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();

    query("UPDATE cloud_refresh_tokens SET expires_at = $1 WHERE token_id = $2")
        .bind((Utc::now() - Duration::minutes(1)).to_rfc3339())
        .bind(&session.token_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        !session_is_active(&pool, &account_id, &device_id, &session.token_id)
            .await
            .unwrap()
    );

    let fresh = issue_session(&pool, &account_id, &device_id, 30)
        .await
        .unwrap();
    query("UPDATE cloud_devices SET revoked_at = $1 WHERE device_id = $2")
        .bind(Utc::now().to_rfc3339())
        .bind(&device_id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        !session_is_active(&pool, &account_id, &device_id, &fresh.token_id)
            .await
            .unwrap()
    );
}
