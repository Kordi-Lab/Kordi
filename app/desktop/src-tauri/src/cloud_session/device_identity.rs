//! The installation's P-256 device key. Native code generates, stores, and
//! signs with the private key; the webview only ever receives the public key.
//!
//! Identities that earlier releases generated with WebCrypto use the same
//! stored format (base64url PKCS#8 and SubjectPublicKeyInfo documents) and
//! keep working until `device_key_rotation` replaces them with a native key.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey};
use p256::PublicKey;
use serde::Serialize;
use std::sync::Mutex;

use super::{
    cloud_device_identity_load, cloud_device_identity_store, CloudDeviceIdentityEntry,
    PendingDeviceKey,
};

const KEY_ALGORITHM: &str = "p256";
/// The version of the text this installation signs with its device key. It
/// names the server and the device a signature is for.
pub(crate) const DEVICE_PROOF_VERSION: u32 = 2;

/// Serializes creating an identity, so concurrent callers share one keypair.
static IDENTITY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CloudDevicePublicIdentity {
    #[serde(rename = "publicKeySpki")]
    pub public_key_spki: String,
    #[serde(rename = "keyAlgorithm")]
    pub key_algorithm: String,
}

fn identity_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    IDENTITY_LOCK
        .lock()
        .map_err(|_| "device_identity_unavailable".to_string())
}

/// The signing key of a stored key pair, accepted only when the stored public
/// key belongs to the stored private key.
fn key_pair(private_key_pkcs8: &str, public_key_spki: &str) -> Option<SigningKey> {
    let private = URL_SAFE_NO_PAD.decode(private_key_pkcs8.trim()).ok()?;
    let key = SigningKey::from_pkcs8_der(&private).ok()?;
    let public = URL_SAFE_NO_PAD.decode(public_key_spki.trim()).ok()?;
    let stored = PublicKey::from_public_key_der(&public).ok()?;
    (PublicKey::from(key.verifying_key()) == stored).then_some(key)
}

fn signing_key(identity: &CloudDeviceIdentityEntry) -> Option<SigningKey> {
    if identity.key_algorithm != KEY_ALGORITHM {
        return None;
    }
    key_pair(&identity.private_key_pkcs8, &identity.public_key_spki)
}

/// A new native key as base64url PKCS#8 and SubjectPublicKeyInfo documents.
fn generate_key_pair() -> Result<(SigningKey, PendingDeviceKey), String> {
    let key = SigningKey::random(&mut rand::rngs::OsRng);
    let private = key
        .to_pkcs8_der()
        .map_err(|_| "device_identity_unavailable".to_string())?;
    let public = key
        .verifying_key()
        .to_public_key_der()
        .map_err(|_| "device_identity_unavailable".to_string())?;
    let encoded = PendingDeviceKey {
        private_key_pkcs8: URL_SAFE_NO_PAD.encode(private.as_bytes()),
        public_key_spki: URL_SAFE_NO_PAD.encode(public.as_bytes()),
    };
    Ok((key, encoded))
}

fn native_identity(key: PendingDeviceKey) -> CloudDeviceIdentityEntry {
    CloudDeviceIdentityEntry {
        private_key_pkcs8: key.private_key_pkcs8,
        public_key_spki: key.public_key_spki,
        key_algorithm: KEY_ALGORITHM.to_string(),
        native_only: true,
        pending_key: None,
    }
}

fn generate_identity() -> Result<CloudDeviceIdentityEntry, String> {
    generate_key_pair().map(|(_, key)| native_identity(key))
}

/// The stored identity, replaced by a new keypair when none is stored or the
/// stored one is unusable. A storage failure is returned, not replaced.
fn load_or_create_identity() -> Result<CloudDeviceIdentityEntry, String> {
    let _guard = identity_lock()?;
    if let Some(identity) = cloud_device_identity_load()? {
        if signing_key(&identity).is_some() {
            return Ok(identity);
        }
    }
    let identity = generate_identity()?;
    cloud_device_identity_store(identity.clone())?;
    Ok(identity)
}

/// The public half of the installation key that sign-in registers.
#[tauri::command]
pub fn cloud_device_identity_public() -> Result<CloudDevicePublicIdentity, String> {
    let identity = load_or_create_identity()?;
    Ok(CloudDevicePublicIdentity {
        public_key_spki: identity.public_key_spki,
        key_algorithm: identity.key_algorithm,
    })
}

/// The exact text a device proof signs, as the server rebuilds it: the
/// version and purpose, the server's origin, account, and device, then one
/// `name:value` field per line, ending with the server's nonce. Every value
/// must be a non-empty single line, so no value can add a field.
pub(crate) fn device_proof_message(
    purpose: &str,
    audience: &str,
    account_id: &str,
    device_id: &str,
    fields: &[(&str, &str)],
    nonce: &str,
) -> Result<String, String> {
    let values = [purpose, audience, account_id, device_id, nonce];
    if values
        .iter()
        .chain(fields.iter().map(|(_, value)| value))
        .any(|value| value.is_empty() || value.contains(['\n', '\r']))
    {
        return Err("device_proof_field_invalid".to_string());
    }
    let mut message = format!(
        "kordi-device-proof-v{DEVICE_PROOF_VERSION}\npurpose:{purpose}\naudience:{audience}\n\
         account:{account_id}\ndevice:{device_id}\n"
    );
    for (name, value) in fields {
        message.push_str(&format!("{name}:{value}\n"));
    }
    message.push_str(&format!("nonce:{nonce}"));
    Ok(message)
}

/// Signs `message` with the stored installation key and returns the
/// base64url fixed-size (r || s) ECDSA P-256 SHA-256 signature. It never
/// creates a key: a proof is only useful with the key sign-in registered.
pub(crate) fn sign_with_device_key(message: &[u8]) -> Result<String, String> {
    let key = cloud_device_identity_load()?
        .as_ref()
        .and_then(signing_key)
        .ok_or_else(|| "device_identity_missing".to_string())?;
    Ok(sign_with(&key, message))
}

/// Signs `message` with `key`, in the form [`sign_with_device_key`] returns.
pub(crate) fn sign_with(key: &SigningKey, message: &[u8]) -> String {
    let signature: Signature = key.sign(message);
    URL_SAFE_NO_PAD.encode(signature.to_bytes())
}

/// Whether the stored identity is one an earlier release created, whose
/// private key page script could read.
pub(crate) fn has_legacy_identity() -> Result<bool, String> {
    Ok(cloud_device_identity_load()?.is_some_and(|identity| !identity.native_only))
}

/// The registered key and the native key that replaces it.
pub(crate) struct PreparedRotation {
    pub old: SigningKey,
    pub new: SigningKey,
    pub new_public_key_spki: String,
}

/// Prepares replacing an identity an earlier release created. The new key is
/// stored as pending before it is offered to the server, so a retry after an
/// interrupted rotation offers the same key. An unusable legacy identity,
/// which could not sign the request, is replaced at once.
pub(crate) fn prepare_rotation() -> Result<Option<PreparedRotation>, String> {
    let _guard = identity_lock()?;
    let Some(mut identity) = cloud_device_identity_load()? else {
        return Ok(None);
    };
    if identity.native_only {
        return Ok(None);
    }
    let Some(old) = signing_key(&identity) else {
        cloud_device_identity_store(generate_identity()?)?;
        return Ok(None);
    };
    let pending = identity.pending_key.as_ref().and_then(|pending| {
        key_pair(&pending.private_key_pkcs8, &pending.public_key_spki)
            .map(|key| (key, pending.public_key_spki.clone()))
    });
    let (new, new_public_key_spki) = match pending {
        Some(pending) => pending,
        None => {
            let (key, encoded) = generate_key_pair()?;
            let public = encoded.public_key_spki.clone();
            identity.pending_key = Some(encoded);
            cloud_device_identity_store(identity)?;
            (key, public)
        }
    };
    Ok(Some(PreparedRotation {
        old,
        new,
        new_public_key_spki,
    }))
}

/// Makes the pending key the installation key once the server registered it,
/// discarding the key it replaces.
pub(crate) fn complete_rotation(new_public_key_spki: &str) -> Result<(), String> {
    let _guard = identity_lock()?;
    let pending = cloud_device_identity_load()?
        .and_then(|identity| identity.pending_key)
        .filter(|pending| pending.public_key_spki == new_public_key_spki)
        .ok_or_else(|| "device_identity_changed".to_string())?;
    cloud_device_identity_store(native_identity(pending))
}

/// Drops a pending key the server would not register, so the next attempt
/// offers a new one.
pub(crate) fn discard_pending_key() -> Result<(), String> {
    let _guard = identity_lock()?;
    match cloud_device_identity_load()? {
        Some(mut identity) if identity.pending_key.is_some() => {
            identity.pending_key = None;
            cloud_device_identity_store(identity)
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::with_isolated_app_data_dir;
    use super::*;
    use p256::ecdsa::{signature::Verifier, VerifyingKey};

    fn verifying_key(identity: &CloudDevicePublicIdentity) -> VerifyingKey {
        let der = URL_SAFE_NO_PAD.decode(&identity.public_key_spki).unwrap();
        VerifyingKey::from_public_key_der(&der).unwrap()
    }

    #[test]
    fn public_identity_is_created_once_and_signs_without_exposing_the_private_key() {
        with_isolated_app_data_dir(|_| {
            let first = cloud_device_identity_public().unwrap();
            assert_eq!(first.key_algorithm, "p256");
            assert_eq!(cloud_device_identity_public().unwrap(), first);
            let serialized = serde_json::to_string(&first).unwrap();
            assert!(!serialized.contains("privateKey"));

            let message = b"kordi-device-proof-v1\npurpose:test";
            let signature = sign_with_device_key(message).unwrap();
            let signature =
                Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature).unwrap()).unwrap();
            let key = verifying_key(&first);
            assert!(key.verify(message, &signature).is_ok());
            assert!(key.verify(b"another message", &signature).is_err());
        });
    }

    #[test]
    fn proof_text_names_the_server_and_device_and_keeps_each_field_on_one_line() {
        assert_eq!(
            device_proof_message(
                "purpose-a",
                "https://kordi.ai",
                "acct_b",
                "dev_c",
                &[("key", "key-d")],
                "nonce-e"
            )
            .unwrap(),
            "kordi-device-proof-v2\npurpose:purpose-a\naudience:https://kordi.ai\n\
             account:acct_b\ndevice:dev_c\nkey:key-d\nnonce:nonce-e"
        );
        let message = |audience: &str, field: &str| {
            device_proof_message("p", audience, "acct", "dev", &[("key", field)], "nonce")
        };
        assert!(message("https://kordi.ai", "key\nnonce:other").is_err());
        assert!(message("https://kordi.ai", "").is_err());
        assert!(message("https://kordi.ai\r", "key").is_err());
    }

    #[test]
    fn signing_requires_a_stored_key_and_never_creates_one() {
        with_isolated_app_data_dir(|_| {
            assert_eq!(
                sign_with_device_key(b"message").unwrap_err(),
                "device_identity_missing"
            );
            assert!(cloud_device_identity_load().unwrap().is_none());
        });
    }

    #[test]
    fn a_mismatched_or_malformed_identity_is_replaced() {
        with_isolated_app_data_dir(|_| {
            let mut identity = generate_identity().unwrap();
            identity.public_key_spki = generate_identity().unwrap().public_key_spki;
            cloud_device_identity_store(identity.clone()).unwrap();
            assert_eq!(
                sign_with_device_key(b"message").unwrap_err(),
                "device_identity_missing"
            );
            let replaced = cloud_device_identity_public().unwrap();
            assert_ne!(replaced.public_key_spki, identity.public_key_spki);
            assert!(sign_with_device_key(b"message").is_ok());
        });
    }

    #[test]
    fn identities_in_the_stored_webcrypto_format_keep_their_key() {
        with_isolated_app_data_dir(|_| {
            // WebCrypto exports PKCS#8 and SPKI DER documents, base64url
            // encoded by the earlier desktop identity code.
            let key = SigningKey::from_slice(&[9_u8; 32]).unwrap();
            let identity = CloudDeviceIdentityEntry {
                private_key_pkcs8: URL_SAFE_NO_PAD.encode(key.to_pkcs8_der().unwrap().as_bytes()),
                public_key_spki: URL_SAFE_NO_PAD
                    .encode(key.verifying_key().to_public_key_der().unwrap().as_bytes()),
                key_algorithm: "p256".to_string(),
                ..CloudDeviceIdentityEntry::default()
            };
            cloud_device_identity_store(identity.clone()).unwrap();
            let public = cloud_device_identity_public().unwrap();
            assert_eq!(public.public_key_spki, identity.public_key_spki);
            let signature = sign_with_device_key(b"message").unwrap();
            let signature =
                Signature::from_slice(&URL_SAFE_NO_PAD.decode(signature).unwrap()).unwrap();
            assert!(verifying_key(&public)
                .verify(b"message", &signature)
                .is_ok());
        });
    }
}
