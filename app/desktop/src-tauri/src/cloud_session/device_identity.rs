//! The installation's P-256 device key. Native code generates, stores, and
//! signs with the private key; the webview only ever receives the public key.
//!
//! Identities that earlier releases generated with WebCrypto use the same
//! stored format (base64url PKCS#8 and SubjectPublicKeyInfo documents) and
//! keep working.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use p256::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey};
use p256::PublicKey;
use serde::Serialize;
use std::sync::Mutex;

use super::{cloud_device_identity_load, cloud_device_identity_store, CloudDeviceIdentityEntry};

const KEY_ALGORITHM: &str = "p256";

/// Serializes creating an identity, so concurrent callers share one keypair.
static IDENTITY_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CloudDevicePublicIdentity {
    #[serde(rename = "publicKeySpki")]
    pub public_key_spki: String,
    #[serde(rename = "keyAlgorithm")]
    pub key_algorithm: String,
}

/// The signing key of a stored identity, accepted only when the stored public
/// key belongs to the stored private key.
fn signing_key(identity: &CloudDeviceIdentityEntry) -> Option<SigningKey> {
    if identity.key_algorithm != KEY_ALGORITHM {
        return None;
    }
    let private = URL_SAFE_NO_PAD
        .decode(identity.private_key_pkcs8.trim())
        .ok()?;
    let key = SigningKey::from_pkcs8_der(&private).ok()?;
    let public = URL_SAFE_NO_PAD
        .decode(identity.public_key_spki.trim())
        .ok()?;
    let stored = PublicKey::from_public_key_der(&public).ok()?;
    (PublicKey::from(key.verifying_key()) == stored).then_some(key)
}

fn generate_identity() -> Result<CloudDeviceIdentityEntry, String> {
    let key = SigningKey::random(&mut rand::rngs::OsRng);
    let private = key
        .to_pkcs8_der()
        .map_err(|_| "device_identity_unavailable".to_string())?;
    let public = key
        .verifying_key()
        .to_public_key_der()
        .map_err(|_| "device_identity_unavailable".to_string())?;
    Ok(CloudDeviceIdentityEntry {
        private_key_pkcs8: URL_SAFE_NO_PAD.encode(private.as_bytes()),
        public_key_spki: URL_SAFE_NO_PAD.encode(public.as_bytes()),
        key_algorithm: KEY_ALGORITHM.to_string(),
    })
}

/// The stored identity, replaced by a new keypair when none is stored or the
/// stored one is unusable. A storage failure is returned, not replaced.
fn load_or_create_identity() -> Result<CloudDeviceIdentityEntry, String> {
    let _guard = IDENTITY_LOCK
        .lock()
        .map_err(|_| "device_identity_unavailable".to_string())?;
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

/// Signs `message` with the stored installation key and returns the
/// base64url fixed-size (r || s) ECDSA P-256 SHA-256 signature. It never
/// creates a key: a proof is only useful with the key sign-in registered.
pub(crate) fn sign_with_device_key(message: &[u8]) -> Result<String, String> {
    let key = cloud_device_identity_load()?
        .as_ref()
        .and_then(signing_key)
        .ok_or_else(|| "device_identity_missing".to_string())?;
    let signature: Signature = key.sign(message);
    Ok(URL_SAFE_NO_PAD.encode(signature.to_bytes()))
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
