//! Apple tokens a deleted account could not have revoked: queued in the
//! deletion transaction, retried with backoff, dropped after the last try.

use super::*;
use crate::auth::oauth::apple::revocations::{retry_due, MAX_ATTEMPTS};

async fn queued(pool: &PgPool, token_id: &str) -> Option<(i32, bool)> {
    query_as(
        "SELECT attempts, next_attempt_at <= now() FROM cloud_apple_token_revocations \
         WHERE token_id = $1",
    )
    .bind(token_id)
    .fetch_optional(pool)
    .await
    .unwrap()
}

async fn token_id(pool: &PgPool, account_id: &str) -> String {
    query_as::<_, (String,)>("SELECT token_id FROM cloud_apple_tokens WHERE account_id = $1")
        .bind(account_id)
        .fetch_one(pool)
        .await
        .unwrap()
        .0
}

#[tokio::test]
async fn deleted_accounts_apple_tokens_are_retried_until_revoked_or_dropped() {
    let Some(pool) = pool().await else { return };
    let email = format!("{}@example.test", unique("apple-queue"));
    let apple = fake_apple(&unique("apple-subject"), &email, "refresh-after-deletion");
    let account_id = sign_in(&pool, Some(&TestCipher), &apple, None)
        .await
        .unwrap()
        .body
        .account
        .account_id;
    let token = token_id(&pool, &account_id).await;

    // Apple was down during deletion, so the token is still stored.
    let mut tx = pool.begin().await.unwrap();
    let deletion = crate::account_deletion::delete_in_transaction(&mut tx, &account_id)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(deletion.queued_apple_tokens, 1);
    assert!(stored_tokens(&pool, &account_id).await.is_empty());
    assert_eq!(queued(&pool, &token).await, Some((0, true)));

    let config = config();
    *apple.revoke_result.lock().unwrap() = Err(AppleApiError::Unavailable);
    retry_due(&pool, &TestCipher, &config, &apple, NOW).await;
    assert_eq!(queued(&pool, &token).await, Some((1, false)), "backs off");

    query("UPDATE cloud_apple_token_revocations SET next_attempt_at = now() WHERE token_id = $1")
        .bind(&token)
        .execute(&pool)
        .await
        .unwrap();
    *apple.revoke_result.lock().unwrap() = Ok(());
    let outcome = retry_due(&pool, &TestCipher, &config, &apple, NOW).await;
    assert!(outcome.revoked >= 1);
    assert_eq!(queued(&pool, &token).await, None);
    let form = apple.revoked.lock().unwrap().last().unwrap().clone();
    assert_eq!(field(&form, "token"), Some("refresh-after-deletion"));
    assert_eq!(field(&form, "token_type_hint"), Some("refresh_token"));

    // A token Apple keeps refusing is dropped after the last attempt. One
    // test, so no other retry pass runs against the shared queue meanwhile.
    let token = unique("apple-token");
    let sealed = TestCipher.encrypt(b"refresh-never-revoked").unwrap();
    query(
        "INSERT INTO cloud_apple_token_revocations \
           (token_id, client_id, refresh_token_ciphertext, cipher_key_id, attempts) \
         VALUES ($1, $2, $3, 'test:v1', $4)",
    )
    .bind(&token)
    .bind(SERVICES_ID)
    .bind(&sealed)
    .bind(MAX_ATTEMPTS - 1)
    .execute(&pool)
    .await
    .unwrap();
    *apple.revoke_result.lock().unwrap() = Err(AppleApiError::Rejected);
    let outcome = retry_due(&pool, &TestCipher, &config, &apple, NOW).await;
    assert!(outcome.dropped >= 1);
    assert_eq!(queued(&pool, &token).await, None);
}
