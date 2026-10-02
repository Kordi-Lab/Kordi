//! Installation keys as the desktop registers them at sign-in.

use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::SigningKey;
use p256::pkcs8::EncodePublicKey;

pub(super) fn random_device_key() -> SigningKey {
    SigningKey::random(&mut rand::rngs::OsRng)
}

/// The base64url DER SubjectPublicKeyInfo the desktop registers.
fn spki(key: &SigningKey) -> String {
    let der = key.verifying_key().to_public_key_der().unwrap();
    URL_SAFE_NO_PAD.encode(der.as_bytes())
}

/// Signs up (`/v1/cloud/auth/signup`) or in (`/v1/cloud/auth/login`) on a
/// Mac that registers `key` as its installation key, as the desktop does.
pub(super) async fn sign_in_with_device_key(
    router: &axum::Router,
    path: &str,
    email: &str,
    key: &SigningKey,
) -> TestAccount {
    let body = json!({"email":email,"password":"correct horse","displayName":"Owner",
        "avatarSeed":"agent_runtime_avatar",
        "device":{"displayName":"Mac","platform":"macos","publicKey":spki(key),"keyAlgorithm":"p256"}});
    let response = router
        .clone()
        .oneshot(post(path, Body::from(body.to_string())))
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "{path}: {}",
        response.status()
    );
    let body = read_json(response).await;
    TestAccount {
        account_id: body["account"]["accountId"].as_str().unwrap().to_string(),
        token: body["session"]["token"].as_str().unwrap().to_string(),
    }
}

/// The device that registered `key` as its installation key for `account`.
pub(super) async fn device_id_for_key(
    pool: &sqlx_postgres::PgPool,
    account: &TestAccount,
    key: &SigningKey,
) -> String {
    let (device_id,): (String,) = sqlx_core::query_as::query_as(
        "SELECT device_id FROM cloud_devices WHERE account_id=$1 AND device_public_key=$2",
    )
    .bind(&account.account_id)
    .bind(spki(key))
    .fetch_one(pool)
    .await
    .unwrap();
    device_id
}
