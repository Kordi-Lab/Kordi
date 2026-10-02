use super::super::tests::with_isolated_app_data_dir;
use super::super::{
    cloud_device_identity_load, cloud_device_identity_store, CloudDeviceIdentityEntry,
    KEYCHAIN_SERVICE, KEYCHAIN_USERNAME,
};
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::Verifier, Signature, SigningKey, VerifyingKey};
use p256::pkcs8::{DecodePublicKey, EncodePrivateKey, EncodePublicKey};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// An identity in the format earlier releases stored, without the native
/// marker.
fn store_legacy_identity(seed: u8) -> SigningKey {
    let key = SigningKey::from_slice(&[seed; 32]).unwrap();
    cloud_device_identity_store(CloudDeviceIdentityEntry {
        private_key_pkcs8: URL_SAFE_NO_PAD.encode(key.to_pkcs8_der().unwrap().as_bytes()),
        public_key_spki: spki(&key),
        key_algorithm: "p256".to_string(),
        ..CloudDeviceIdentityEntry::default()
    })
    .unwrap();
    key
}

fn spki(key: &SigningKey) -> String {
    URL_SAFE_NO_PAD.encode(key.verifying_key().to_public_key_der().unwrap().as_bytes())
}

fn verifying(spki: &str) -> VerifyingKey {
    VerifyingKey::from_public_key_der(&URL_SAFE_NO_PAD.decode(spki).unwrap()).unwrap()
}

fn verifies(key: &VerifyingKey, message: &str, signature: &str) -> bool {
    let signature = Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature).unwrap()).unwrap();
    key.verify(message.as_bytes(), &signature).is_ok()
}

/// Whether the stored key signs proofs that `spki` verifies.
fn signs_as(spki: &str) -> bool {
    let signature = crate::cloud_session::sign_with_device_key(b"proof").unwrap();
    verifies(&verifying(spki), "proof", &signature)
}

fn identity() -> CloudDeviceIdentityEntry {
    cloud_device_identity_load().unwrap().unwrap()
}

fn store_session(device_id: Option<&str>) {
    let session = CloudSessionEntry {
        token: "fixture-session-token".to_string(),
        account_id: "acct_fixture".to_string(),
        expires_at: "2026-12-31T00:00:00Z".to_string(),
        device_id: device_id.map(str::to_owned),
    };
    crate::cloud_session::secret_store(
        KEYCHAIN_SERVICE,
        KEYCHAIN_USERNAME,
        &serde_json::to_string(&session).unwrap(),
    )
    .unwrap();
}

#[test]
fn new_keys_are_native_and_only_earlier_keys_need_rotation() {
    with_isolated_app_data_dir(|_| {
        assert!(!device_identity::has_legacy_identity().unwrap());
        device_identity::cloud_device_identity_public().unwrap();
        assert!(identity().native_only);
        assert!(!device_identity::has_legacy_identity().unwrap());
        store_legacy_identity(3);
        assert!(device_identity::has_legacy_identity().unwrap());
    });
}

#[test]
fn a_prepared_key_waits_for_the_server_and_then_replaces_the_old_key() {
    with_isolated_app_data_dir(|_| {
        let old = store_legacy_identity(4);
        let prepared = device_identity::prepare_rotation().unwrap().unwrap();
        assert_eq!(spki(&prepared.old), spki(&old));
        assert_eq!(spki(&prepared.new), prepared.new_public_key_spki);
        // Until the server registers the new key, proofs use the old one, and
        // a retry offers the same new key.
        assert!(signs_as(&spki(&old)));
        let again = device_identity::prepare_rotation().unwrap().unwrap();
        assert_eq!(again.new_public_key_spki, prepared.new_public_key_spki);

        device_identity::complete_rotation(&prepared.new_public_key_spki).unwrap();
        let rotated = identity();
        assert!(rotated.native_only && rotated.pending_key.is_none());
        assert_eq!(rotated.public_key_spki, prepared.new_public_key_spki);
        assert!(signs_as(&prepared.new_public_key_spki));
        assert!(device_identity::prepare_rotation().unwrap().is_none());
        assert!(device_identity::complete_rotation(&spki(&old)).is_err());
    });
}

#[test]
fn a_discarded_pending_key_is_not_offered_again() {
    with_isolated_app_data_dir(|_| {
        store_legacy_identity(5);
        let first = device_identity::prepare_rotation().unwrap().unwrap();
        device_identity::discard_pending_key().unwrap();
        let second = device_identity::prepare_rotation().unwrap().unwrap();
        assert_ne!(first.new_public_key_spki, second.new_public_key_spki);
        assert!(device_identity::complete_rotation(&first.new_public_key_spki).is_err());
    });
}

#[test]
fn an_unusable_earlier_key_is_replaced_at_once() {
    with_isolated_app_data_dir(|_| {
        let mut broken = CloudDeviceIdentityEntry {
            key_algorithm: "p256".to_string(),
            ..CloudDeviceIdentityEntry::default()
        };
        broken.private_key_pkcs8 = "not-a-key".to_string();
        broken.public_key_spki = "not-a-key".to_string();
        cloud_device_identity_store(broken).unwrap();
        assert!(device_identity::prepare_rotation().unwrap().is_none());
        assert!(identity().native_only);
        assert!(!device_identity::has_legacy_identity().unwrap());
    });
}

/// A server that answers each connection with the next response and returns
/// the requests it received, as (head, JSON body).
async fn serve(
    responses: Vec<(u16, Value)>,
) -> (String, tokio::task::JoinHandle<Vec<(String, Value)>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, response) in responses {
            let (mut socket, _) =
                tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let mut bytes = Vec::new();
            let (head, body) = loop {
                let mut chunk = [0; 4096];
                let count = socket.read(&mut chunk).await.unwrap();
                assert!(count > 0);
                bytes.extend_from_slice(&chunk[..count]);
                let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") else {
                    continue;
                };
                let head = String::from_utf8_lossy(&bytes[..end]).to_string();
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + length {
                    let body = serde_json::from_slice(&bytes[end + 4..end + 4 + length])
                        .unwrap_or(Value::Null);
                    break (head, body);
                }
            };
            requests.push((head, body));
            let response = response.to_string();
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n{response}",
                        response.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
        }
        requests
    });
    (base, server)
}

fn challenge(device_id: &str) -> (u16, Value) {
    (
        200,
        json!({"nonce":"fixture-nonce","expiresAt":"2026-12-31T00:00:00Z","algorithm":ALGORITHM,
            "purpose":PURPOSE,"version":2,"deviceId":device_id}),
    )
}

/// Runs a rotation against a server answering with `responses`, with the
/// desktop's API origin set to that server.
fn rotate_with(responses: Vec<(u16, Value)>) -> (Outcome, String, Vec<(String, Value)>) {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let (base, server) = serve(responses).await;
        let previous = std::env::var_os("VITE_KORDI_CLOUD_API_BASE");
        std::env::set_var("VITE_KORDI_CLOUD_API_BASE", &base);
        let outcome = rotate_legacy_key().await;
        match previous {
            Some(value) => std::env::set_var("VITE_KORDI_CLOUD_API_BASE", value),
            None => std::env::remove_var("VITE_KORDI_CLOUD_API_BASE"),
        }
        let requests = server.await.unwrap();
        (outcome, base, requests)
    })
}

#[test]
fn a_signed_in_earlier_key_is_registered_with_both_signatures_then_replaced() {
    with_isolated_app_data_dir(|_| {
        let old = store_legacy_identity(6);
        store_session(Some("dev_fixture"));
        let (outcome, base, requests) = rotate_with(vec![
            challenge("dev_fixture"),
            (200, json!({"deviceId":"dev_fixture"})),
        ]);
        assert_eq!(outcome, Outcome::Rotated);

        let (head, _) = &requests[0];
        assert!(head.starts_with(&format!("POST {CHALLENGE_PATH} ")));
        assert!(head.contains("Bearer fixture-session-token"));
        let (head, rotation) = &requests[1];
        assert!(head.starts_with(&format!("POST {ROTATION_PATH} ")));
        let new_key = rotation["publicKey"].as_str().unwrap();
        let text = format!(
            "kordi-device-proof-v2\npurpose:device-key-rotation\naudience:{base}\n\
             account:acct_fixture\ndevice:dev_fixture\nkey:{new_key}\nnonce:fixture-nonce"
        );
        assert_eq!(rotation["audience"], base.as_str());
        assert_eq!(rotation["nonce"], "fixture-nonce");
        assert_eq!(rotation["keyAlgorithm"], "p256");
        assert!(verifies(
            old.verifying_key(),
            &text,
            rotation["signature"].as_str().unwrap()
        ));
        assert!(verifies(
            &verifying(new_key),
            &text,
            rotation["newKeySignature"].as_str().unwrap()
        ));

        let rotated = identity();
        assert!(rotated.native_only && rotated.pending_key.is_none());
        assert_eq!(rotated.public_key_spki, new_key);
        assert!(signs_as(new_key));
        assert!(!signs_as(&spki(&old)));
        assert_eq!(rotate_with(vec![]).0, Outcome::NotNeeded);
    });
}

#[test]
fn a_server_without_rotation_keeps_the_old_key_until_a_later_attempt() {
    with_isolated_app_data_dir(|_| {
        let old = store_legacy_identity(7);
        store_session(None);
        let (outcome, _, requests) = rotate_with(vec![(404, json!({}))]);
        assert_eq!(outcome, Outcome::Deferred("rotation_unsupported"));
        assert_eq!(requests.len(), 1);
        assert!(signs_as(&spki(&old)));
        let pending = identity().pending_key.unwrap().public_key_spki;

        // A session stored before the device was recorded signs for the
        // device the challenge names, and the same new key is offered.
        let (outcome, _, requests) = rotate_with(vec![challenge("dev_fixture"), (200, json!({}))]);
        assert_eq!(outcome, Outcome::Rotated);
        assert_eq!(requests[1].1["publicKey"], pending.as_str());
        assert!(signs_as(&pending));
    });
}

#[test]
fn a_challenge_for_another_device_is_not_signed() {
    with_isolated_app_data_dir(|_| {
        let old = store_legacy_identity(8);
        store_session(Some("dev_fixture"));
        let (outcome, _, requests) = rotate_with(vec![challenge("dev_other")]);
        assert_eq!(outcome, Outcome::Deferred("device_mismatch"));
        assert_eq!(requests.len(), 1);
        assert!(signs_as(&spki(&old)));
        assert!(identity().pending_key.is_some());
    });
}

#[test]
fn refusals_keep_or_replace_the_old_key_as_the_server_answers() {
    with_isolated_app_data_dir(|_| {
        let old = store_legacy_identity(9);
        store_session(Some("dev_fixture"));
        let (outcome, _, _) = rotate_with(vec![
            challenge("dev_fixture"),
            (403, json!({"errorCode":"device_key_rotation_invalid"})),
        ]);
        assert_eq!(outcome, Outcome::Deferred("rotation_refused"));
        assert!(signs_as(&spki(&old)));

        let pending = identity().pending_key.unwrap().public_key_spki;
        let (outcome, _, _) = rotate_with(vec![
            challenge("dev_fixture"),
            (409, json!({"errorCode":"device_key_in_use"})),
        ]);
        assert_eq!(outcome, Outcome::Deferred("device_key_in_use"));
        assert!(
            identity().pending_key.is_none(),
            "{pending} is not offered again"
        );
        assert!(signs_as(&spki(&old)));

        // A device the server holds no key for has nothing to replace there,
        // so the new key is kept and the next sign-in registers it.
        let (outcome, _, _) = rotate_with(vec![(409, json!({"errorCode":"device_key_required"}))]);
        assert_eq!(outcome, Outcome::ReplacedLocally);
        assert!(identity().native_only);
        assert!(!signs_as(&spki(&old)));
    });
}

#[test]
fn without_a_session_the_earlier_key_is_replaced_without_a_request() {
    with_isolated_app_data_dir(|_| {
        let old = store_legacy_identity(10);
        let (outcome, _, requests) = rotate_with(vec![]);
        assert_eq!(outcome, Outcome::ReplacedLocally);
        assert!(requests.is_empty());
        assert!(identity().native_only);
        assert!(!signs_as(&spki(&old)));
        assert_eq!(rotate_with(vec![]).0, Outcome::NotNeeded);
    });
}
