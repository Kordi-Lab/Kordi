//! The Kordi app's secret storage, read and written the same way the app
//! does (`app/desktop/src-tauri/src/cloud_session.rs`): the session and the
//! installation key are JSON in the OS keychain, under services scoped by
//! `APP_INSTANCE_ID`, or files under `APP_DATA_DIR` for isolated
//! development instances. Keep the names and formats in step with that file.

use std::path::PathBuf;

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use p256::pkcs8::{EncodePrivateKey, EncodePublicKey};
use serde::{Deserialize, Serialize};

const SESSION_SERVICE: &str = "com.kordi.cloud-session";
const DEVICE_IDENTITY_SERVICE: &str = "com.kordi.cloud-device-identity";
const USERNAME: &str = "default";
const DEV_FILE_SECRETS_DIR_NAME: &str = "cloud-secrets";

/// The app's stored session. Field names match the app's keychain JSON.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CloudSessionEntry {
    pub token: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "expiresAt")]
    pub expires_at: String,
    #[serde(rename = "deviceId", default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(
        rename = "refreshToken",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub refresh_token: Option<String>,
    #[serde(rename = "clientId", default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(
        rename = "tokenEndpoint",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub token_endpoint: Option<String>,
}

/// The app's installation key pair: base64url PKCS#8 and SPKI DER.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct InstallationIdentity {
    #[serde(rename = "privateKeyPkcs8")]
    pub private_key_pkcs8: String,
    #[serde(rename = "publicKeySpki")]
    pub public_key_spki: String,
    #[serde(rename = "keyAlgorithm")]
    pub key_algorithm: String,
}

fn scoped_service(base: &str, instance: Option<&str>) -> String {
    match instance.map(str::trim).filter(|value| !value.is_empty()) {
        Some(instance) => format!("{base}.{instance}"),
        None => base.to_string(),
    }
}

fn instance() -> Option<String> {
    std::env::var("APP_INSTANCE_ID").ok()
}

fn dev_file_path(data_dir: &std::path::Path, scoped: &str) -> PathBuf {
    let encoded = URL_SAFE_NO_PAD.encode(format!("{scoped}:{USERNAME}"));
    data_dir
        .join("kordi")
        .join(DEV_FILE_SECRETS_DIR_NAME)
        .join(format!("{encoded}.secret"))
}

fn store(service: &str, value: &str) -> Result<(), String> {
    let scoped = scoped_service(service, instance().as_deref());
    if let Some(data_dir) = std::env::var_os("APP_DATA_DIR") {
        let path = dev_file_path(std::path::Path::new(&data_dir), &scoped);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        return std::fs::write(path, value).map_err(|error| error.to_string());
    }
    keyring::Entry::new(&scoped, USERNAME)
        .and_then(|entry| entry.set_password(value))
        .map_err(|error| error.to_string())
}

fn load(service: &str) -> Result<Option<String>, String> {
    let scoped = scoped_service(service, instance().as_deref());
    if let Some(data_dir) = std::env::var_os("APP_DATA_DIR") {
        return match std::fs::read_to_string(dev_file_path(
            std::path::Path::new(&data_dir),
            &scoped,
        )) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        };
    }
    match keyring::Entry::new(&scoped, USERNAME).and_then(|entry| entry.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// Save the session where the app reads it.
pub fn store_session(entry: &CloudSessionEntry) -> Result<(), String> {
    let json = serde_json::to_string(entry).map_err(|error| error.to_string())?;
    store(SESSION_SERVICE, &json)
}

fn new_identity() -> Result<InstallationIdentity, String> {
    let secret = p256::SecretKey::random(&mut rand::rngs::OsRng);
    let private = secret.to_pkcs8_der().map_err(|error| error.to_string())?;
    let public = secret
        .public_key()
        .to_public_key_der()
        .map_err(|error| error.to_string())?;
    Ok(InstallationIdentity {
        private_key_pkcs8: URL_SAFE_NO_PAD.encode(private.as_bytes()),
        public_key_spki: URL_SAFE_NO_PAD.encode(public.as_bytes()),
        key_algorithm: "p256".to_string(),
    })
}

/// The app's installation key on this host, created and saved when there is
/// none yet, so the app later uses the same key.
pub fn installation_identity() -> Result<InstallationIdentity, String> {
    if let Some(value) = load(DEVICE_IDENTITY_SERVICE)?
        && let Ok(identity) = serde_json::from_str::<InstallationIdentity>(&value)
        && identity.key_algorithm == "p256"
    {
        return Ok(identity);
    }
    let identity = new_identity()?;
    let json = serde_json::to_string(&identity).map_err(|error| error.to_string())?;
    store(DEVICE_IDENTITY_SERVICE, &json)?;
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::pkcs8::{DecodePrivateKey, DecodePublicKey};

    #[test]
    fn session_json_matches_the_app() {
        let entry = CloudSessionEntry {
            token: "kordi_cs_synthetic".into(),
            account_id: "acct_synthetic".into(),
            expires_at: "2099-01-01T00:00:00Z".into(),
            device_id: Some("dev_synthetic".into()),
            refresh_token: Some("kordi_rt_synthetic".into()),
            client_id: Some("kordi-desktop".into()),
            token_endpoint: Some("https://example.test/v1/cloud/auth/app/token".into()),
        };
        let json: serde_json::Value = serde_json::to_value(&entry).unwrap();
        for key in [
            "token",
            "accountId",
            "expiresAt",
            "deviceId",
            "refreshToken",
            "clientId",
            "tokenEndpoint",
        ] {
            assert!(json.get(key).is_some(), "{key}");
        }
    }

    #[test]
    fn services_and_dev_files_match_the_app() {
        assert_eq!(
            scoped_service(SESSION_SERVICE, None),
            "com.kordi.cloud-session"
        );
        assert_eq!(
            scoped_service(SESSION_SERVICE, Some(" user2 ")),
            "com.kordi.cloud-session.user2"
        );
        let path = dev_file_path(std::path::Path::new("/data"), "com.kordi.cloud-session");
        let expected = URL_SAFE_NO_PAD.encode("com.kordi.cloud-session:default");
        assert_eq!(
            path,
            PathBuf::from(format!("/data/kordi/cloud-secrets/{expected}.secret"))
        );
    }

    #[test]
    fn new_identities_are_p256_pkcs8_and_spki() {
        let identity = new_identity().unwrap();
        assert_eq!(identity.key_algorithm, "p256");
        let private = URL_SAFE_NO_PAD.decode(&identity.private_key_pkcs8).unwrap();
        let public = URL_SAFE_NO_PAD.decode(&identity.public_key_spki).unwrap();
        let secret = p256::SecretKey::from_pkcs8_der(&private).unwrap();
        assert_eq!(
            secret.public_key(),
            p256::PublicKey::from_public_key_der(&public).unwrap()
        );
    }
}
