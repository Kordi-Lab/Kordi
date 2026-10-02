//! A device rotates its registered installation key only with a live
//! challenge issued to its own session, signed by the registered key and the
//! new key, for this server and this device.

use super::*;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::{signature::Signer, Signature, SigningKey};

const CHALLENGE_PATH: &str = "/v1/cloud/auth/devices/current/key-rotation/challenge";
const ROTATION_PATH: &str = "/v1/cloud/auth/devices/current/key-rotation";
/// The audience a device names for a server whose public base URL is not
/// configured, as in these tests.
const AUDIENCE: &str = "https://kordi.ai";

struct Device {
    account: TestAccount,
    key: SigningKey,
    device_id: String,
}

async fn signed_in_device(
    router: &axum::Router,
    pool: &sqlx_postgres::PgPool,
    path: &str,
    email: &str,
) -> Device {
    let key = random_device_key();
    let account = sign_in_with_device_key(router, path, email, &key).await;
    let device_id = device_id_for_key(pool, &account, &key).await;
    Device {
        account,
        key,
        device_id,
    }
}

async fn challenge(router: &axum::Router, account: &TestAccount) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(post_with_token(CHALLENGE_PATH, &account.token))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

async fn nonce(router: &axum::Router, device: &Device) -> String {
    let (status, body) = challenge(router, &device.account).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["algorithm"], "ecdsa-p256-sha256");
    assert_eq!(body["purpose"], "device-key-rotation");
    assert_eq!(body["version"], 2);
    assert_eq!(body["deviceId"], device.device_id.as_str());
    body["nonce"].as_str().unwrap().to_string()
}

/// The signed text is a protocol contract with the desktop.
fn text(audience: &str, account: &str, device: &str, new_key: &str, nonce: &str) -> String {
    format!(
        "kordi-device-proof-v2\npurpose:device-key-rotation\naudience:{audience}\n\
         account:{account}\ndevice:{device}\nkey:{new_key}\nnonce:{nonce}"
    )
}

fn sign(key: &SigningKey, text: &str) -> String {
    let signature: Signature = key.sign(text.as_bytes());
    URL_SAFE_NO_PAD.encode(signature.to_bytes())
}

/// A request that rotates `device` to `new_key`, signed with `old` and `new`
/// over `text`.
fn request(
    new_key: &SigningKey,
    old: &SigningKey,
    new: &SigningKey,
    text: &str,
    nonce: &str,
) -> Value {
    json!({"nonce":nonce,"audience":AUDIENCE,"publicKey":spki(new_key),"keyAlgorithm":"p256",
        "signature":sign(old, text),"newKeySignature":sign(new, text)})
}

fn valid_request(device: &Device, new_key: &SigningKey, nonce: &str) -> Value {
    let text = text(
        AUDIENCE,
        &device.account.account_id,
        &device.device_id,
        &spki(new_key),
        nonce,
    );
    request(new_key, &device.key, new_key, &text, nonce)
}

async fn rotate(router: &axum::Router, account: &TestAccount, body: Value) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(post_json_with_token(ROTATION_PATH, &account.token, body))
        .await
        .unwrap();
    let status = response.status();
    (status, read_json(response).await)
}

async fn registered_key(pool: &sqlx_postgres::PgPool, device: &Device) -> String {
    let (key,): (String,) = sqlx_core::query_as::query_as(
        "SELECT device_public_key FROM cloud_devices WHERE device_id=$1",
    )
    .bind(&device.device_id)
    .fetch_one(pool)
    .await
    .unwrap();
    key
}

async fn setup() -> Option<(sqlx_postgres::PgPool, axum::Router)> {
    let pool = try_pool().await?;
    let router = test_router(Arc::new(ServerState::new(pool.clone(), EventBus::noop())));
    Some((pool, router))
}

#[tokio::test]
async fn a_device_rotates_its_key_once_with_both_signatures() {
    let Some((pool, router)) = setup().await else {
        return;
    };
    let email = unique_email("key-rotation");
    let mut mac = signed_in_device(&router, &pool, "/v1/cloud/auth/signup", &email).await;
    let new_key = random_device_key();
    let issued = nonce(&router, &mac).await;
    let rotation = valid_request(&mac, &new_key, &issued);

    let (status, body) = rotate(&router, &mac.account, rotation.clone()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["deviceId"], mac.device_id.as_str());
    assert_eq!(registered_key(&pool, &mac).await, spki(&new_key));

    let (status, body) = rotate(&router, &mac.account, rotation).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "a used challenge cannot be replayed"
    );
    assert_eq!(body["errorCode"], "device_key_rotation_invalid");

    // The replaced key can no longer rotate the device.
    let issued = nonce(&router, &mac).await;
    let (status, _) = rotate(
        &router,
        &mac.account,
        valid_request(&mac, &random_device_key(), &issued),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(registered_key(&pool, &mac).await, spki(&new_key));

    // A device that lost the answer retries with a fresh challenge; the new
    // key's signature is enough once the key is registered.
    let issued = nonce(&router, &mac).await;
    let (status, body) = rotate(
        &router,
        &mac.account,
        valid_request(&mac, &new_key, &issued),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Signing in again with the new key keeps the same device.
    mac.key = new_key;
    let again = sign_in_with_device_key(&router, "/v1/cloud/auth/login", &email, &mac.key).await;
    assert_eq!(
        device_id_for_key(&pool, &again, &mac.key).await,
        mac.device_id
    );
}

#[tokio::test]
async fn rotation_needs_both_keys_and_this_server_device_and_challenge() {
    let Some((pool, router)) = setup().await else {
        return;
    };
    let email = unique_email("key-rotation-refusals");
    let mac = signed_in_device(&router, &pool, "/v1/cloud/auth/signup", &email).await;
    let other = signed_in_device(&router, &pool, "/v1/cloud/auth/login", &email).await;
    assert_ne!(other.device_id, mac.device_id);
    let original = registered_key(&pool, &mac).await;
    let new_key = random_device_key();
    let new_spki = spki(&new_key);
    let owner = mac.account.account_id.clone();

    let refused = |label: &'static str| {
        move |(status, body): (StatusCode, Value)| {
            assert_eq!(status, StatusCode::FORBIDDEN, "{label}: {body}");
            assert_eq!(body["errorCode"], "device_key_rotation_invalid", "{label}");
        }
    };
    let issued = nonce(&router, &mac).await;
    let signed = text(AUDIENCE, &owner, &mac.device_id, &new_spki, &issued);
    refused("a signature by another key than the registered one")(
        rotate(
            &router,
            &mac.account,
            request(&new_key, &random_device_key(), &new_key, &signed, &issued),
        )
        .await,
    );
    let issued = nonce(&router, &mac).await;
    let signed = text(AUDIENCE, &owner, &mac.device_id, &new_spki, &issued);
    refused("no signature by the new key")(
        rotate(
            &router,
            &mac.account,
            request(&new_key, &mac.key, &mac.key, &signed, &issued),
        )
        .await,
    );
    let issued = nonce(&router, &mac).await;
    let signed = text(
        "https://other.example",
        &owner,
        &mac.device_id,
        &new_spki,
        &issued,
    );
    let mut for_other_server = request(&new_key, &mac.key, &new_key, &signed, &issued);
    for_other_server["audience"] = json!("https://other.example");
    refused("a signature for another server")(
        rotate(&router, &mac.account, for_other_server).await,
    );
    let issued = nonce(&router, &mac).await;
    let signed = text(AUDIENCE, &owner, &other.device_id, &new_spki, &issued);
    refused("a signature for another device")(
        rotate(
            &router,
            &mac.account,
            request(&new_key, &mac.key, &new_key, &signed, &issued),
        )
        .await,
    );
    // Another device's session cannot use this device's challenge, and this
    // device's session cannot use a challenge issued to another device.
    let issued = nonce(&router, &mac).await;
    refused("this device's challenge on another device's session")(
        rotate(
            &router,
            &other.account,
            valid_request(&mac, &new_key, &issued),
        )
        .await,
    );
    let issued = nonce(&router, &other).await;
    refused("another device's challenge on this device's session")(
        rotate(
            &router,
            &mac.account,
            valid_request(&mac, &new_key, &issued),
        )
        .await,
    );
    let issued = nonce(&router, &mac).await;
    sqlx_core::query::query(
        "UPDATE cloud_device_key_rotation_challenges SET expires_at=now()-interval '1 second' WHERE nonce=$1",
    )
    .bind(&issued)
    .execute(&pool)
    .await
    .unwrap();
    refused("an expired challenge")(
        rotate(
            &router,
            &mac.account,
            valid_request(&mac, &new_key, &issued),
        )
        .await,
    );
    let replaced = nonce(&router, &mac).await;
    let _current = nonce(&router, &mac).await;
    refused("a replaced challenge")(
        rotate(
            &router,
            &mac.account,
            valid_request(&mac, &new_key, &replaced),
        )
        .await,
    );
    refused("an unissued challenge")(
        rotate(
            &router,
            &mac.account,
            valid_request(&mac, &new_key, "unissued"),
        )
        .await,
    );
    assert_eq!(registered_key(&pool, &mac).await, original);

    let issued = nonce(&router, &mac).await;
    let (status, body) = rotate(
        &router,
        &mac.account,
        valid_request(&mac, &other.key, &issued),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["errorCode"], "device_key_in_use");
    let issued = nonce(&router, &mac).await;
    let mut malformed = valid_request(&mac, &new_key, &issued);
    malformed["publicKey"] = json!("placeholder-device-key");
    let (status, body) = rotate(&router, &mac.account, malformed).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["errorCode"], "invalid_device_public_key");
    assert_eq!(registered_key(&pool, &mac).await, original);

    // A device that registered no key at sign-in has nothing to rotate.
    let keyless = signup(&router, "key-rotation-keyless", "Keyless").await;
    let (status, body) = challenge(&router, &keyless).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["errorCode"], "device_key_required");
}
