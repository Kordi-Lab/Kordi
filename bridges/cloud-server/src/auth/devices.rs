use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::Utc;
use p256::pkcs8::DecodePublicKey;
use p256::PublicKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::Postgres;

use crate::auth::session::session_inactivity_cutoff;
use crate::chat_sync::store::{append_user_sync_events_in_transaction, StoreError};

const MAX_DEVICE_NAME_CHARS: usize = 80;
const MAX_PLATFORM_CHARS: usize = 32;
const MAX_VERSION_CHARS: usize = 64;
const MAX_LOCATION_CHARS: usize = 120;
const MAX_PUBLIC_KEY_CHARS: usize = 1_024;

#[derive(Clone, Debug, Deserialize)]
pub struct DeviceRegistrationRequest {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub platform: Option<String>,
    #[serde(rename = "osVersion")]
    pub os_version: Option<String>,
    #[serde(rename = "appVersion")]
    pub app_version: Option<String>,
    #[serde(rename = "approximateLocation")]
    pub approximate_location: Option<String>,
    #[serde(rename = "publicKey")]
    pub public_key: String,
    #[serde(rename = "keyAlgorithm")]
    pub key_algorithm: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DeviceMetadataUpdateRequest {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    pub platform: Option<String>,
    #[serde(rename = "osVersion")]
    pub os_version: Option<String>,
    #[serde(rename = "appVersion")]
    pub app_version: Option<String>,
    #[serde(rename = "approximateLocation")]
    pub approximate_location: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizedDeviceMetadata {
    pub display_name: Option<String>,
    pub platform: Option<String>,
    pub os_version: Option<String>,
    pub app_version: Option<String>,
    pub approximate_location: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizedDeviceRegistration {
    pub display_name: Option<String>,
    pub platform: Option<String>,
    pub os_version: Option<String>,
    pub app_version: Option<String>,
    pub approximate_location: Option<String>,
    pub public_key: String,
    pub key_algorithm: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizedDevice {
    pub device_id: String,
    pub is_new_authorization: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceInputError {
    InvalidPublicKey,
    UnsupportedKeyAlgorithm,
}

impl DeviceInputError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidPublicKey => "invalid_device_public_key",
            Self::UnsupportedKeyAlgorithm => "unsupported_device_key_algorithm",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidPublicKey => "The installation public key is invalid.",
            Self::UnsupportedKeyAlgorithm => {
                "This Kordi version uses an unsupported installation key algorithm."
            }
        }
    }
}

fn clean_optional(value: Option<&str>, max_chars: usize) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(max_chars).collect())
}

pub fn normalize_device_metadata(value: DeviceMetadataUpdateRequest) -> NormalizedDeviceMetadata {
    NormalizedDeviceMetadata {
        display_name: clean_optional(value.display_name.as_deref(), MAX_DEVICE_NAME_CHARS),
        platform: clean_optional(value.platform.as_deref(), MAX_PLATFORM_CHARS)
            .map(|value| value.to_ascii_lowercase()),
        os_version: clean_optional(value.os_version.as_deref(), MAX_VERSION_CHARS),
        app_version: clean_optional(value.app_version.as_deref(), MAX_VERSION_CHARS),
        approximate_location: clean_optional(
            value.approximate_location.as_deref(),
            MAX_LOCATION_CHARS,
        ),
    }
}

pub fn normalize_device_registration(
    value: DeviceRegistrationRequest,
) -> Result<NormalizedDeviceRegistration, DeviceInputError> {
    let key_algorithm = value.key_algorithm.trim().to_ascii_lowercase();
    if key_algorithm != "p256" {
        return Err(DeviceInputError::UnsupportedKeyAlgorithm);
    }
    let public_key = value.public_key.trim();
    if public_key.is_empty() || public_key.len() > MAX_PUBLIC_KEY_CHARS {
        return Err(DeviceInputError::InvalidPublicKey);
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(public_key)
        .map_err(|_| DeviceInputError::InvalidPublicKey)?;
    let valid_x963 = PublicKey::from_sec1_bytes(&decoded).is_ok();
    let valid_spki = PublicKey::from_public_key_der(&decoded).is_ok();
    if !valid_x963 && !valid_spki {
        return Err(DeviceInputError::InvalidPublicKey);
    }

    Ok(NormalizedDeviceRegistration {
        display_name: clean_optional(value.display_name.as_deref(), MAX_DEVICE_NAME_CHARS),
        platform: clean_optional(value.platform.as_deref(), MAX_PLATFORM_CHARS)
            .map(|value| value.to_ascii_lowercase()),
        os_version: clean_optional(value.os_version.as_deref(), MAX_VERSION_CHARS),
        app_version: clean_optional(value.app_version.as_deref(), MAX_VERSION_CHARS),
        approximate_location: clean_optional(
            value.approximate_location.as_deref(),
            MAX_LOCATION_CHARS,
        ),
        public_key: public_key.to_string(),
        key_algorithm,
    })
}

pub fn legacy_device_registration(default_name: &str) -> NormalizedDeviceRegistration {
    NormalizedDeviceRegistration {
        display_name: clean_optional(Some(default_name), MAX_DEVICE_NAME_CHARS),
        platform: None,
        os_version: None,
        app_version: None,
        approximate_location: None,
        public_key: format!("legacy:{}", uuid::Uuid::new_v4().simple()),
        key_algorithm: "legacy".to_string(),
    }
}

pub async fn authorize_device(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    registration: &NormalizedDeviceRegistration,
    initial_authorization_state: &str,
) -> Result<AuthorizedDevice, sqlx_core::Error> {
    let lock_key = format!(
        "device-authorization:{account_id}:{}",
        registration.public_key
    );
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(lock_key)
        .execute(&mut **transaction)
        .await?;

    let now = Utc::now();
    let existing: Option<(String, Option<String>, String, bool)> = query_as(
        "SELECT device_id, revoked_at, authorization_state, last_seen_at <= $3 \
         FROM cloud_devices \
         WHERE account_id = $1 AND device_public_key = $2 FOR UPDATE",
    )
    .bind(account_id)
    .bind(&registration.public_key)
    .bind(session_inactivity_cutoff(now).to_rfc3339())
    .fetch_optional(&mut **transaction)
    .await?;
    let now = now.to_rfc3339();

    if let Some((device_id, revoked_at, authorization_state, was_inactive)) = existing {
        if was_inactive {
            query(
                "UPDATE cloud_refresh_tokens SET revoked_at = $1 \
                 WHERE account_id = $2 AND device_id = $3 AND revoked_at IS NULL",
            )
            .bind(&now)
            .bind(account_id)
            .bind(&device_id)
            .execute(&mut **transaction)
            .await?;
        }
        let next_authorization_state = if revoked_at.is_some() {
            initial_authorization_state
        } else {
            &authorization_state
        };
        query(
            "UPDATE cloud_devices SET \
               device_name = CASE \
                 WHEN $1 IS NULL THEN device_name \
                 WHEN device_name IS NULL OR device_name LIKE 'oauth-%-device' \
                   OR device_name = 'cloud-email-password-device' THEN $1 \
                 ELSE device_name \
               END, \
               device_key_algorithm = $2, device_platform = COALESCE($3, device_platform), \
               os_version = COALESCE($4, os_version), app_version = COALESCE($5, app_version), \
               approximate_location = COALESCE($6, approximate_location), \
               authorization_state = $7, \
               confirmed_at = CASE WHEN $7 = 'confirmed' THEN COALESCE(confirmed_at, $8) ELSE NULL END, \
               last_seen_at = $8, revoked_at = NULL \
             WHERE account_id = $9 AND device_id = $10",
        )
        .bind(registration.display_name.as_deref())
        .bind(&registration.key_algorithm)
        .bind(registration.platform.as_deref())
        .bind(registration.os_version.as_deref())
        .bind(registration.app_version.as_deref())
        .bind(registration.approximate_location.as_deref())
        .bind(next_authorization_state)
        .bind(&now)
        .bind(account_id)
        .bind(&device_id)
        .execute(&mut **transaction)
        .await?;
        return Ok(AuthorizedDevice {
            device_id,
            is_new_authorization: revoked_at.is_some(),
        });
    }

    let device_id = format!("dev_{}", uuid::Uuid::new_v4().simple());
    query(
        "INSERT INTO cloud_devices \
         (device_id, account_id, device_name, device_public_key, device_key_algorithm, \
          device_platform, os_version, app_version, approximate_location, authorization_state, confirmed_at, \
          created_at, last_seen_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, \
                 CASE WHEN $10 = 'confirmed' THEN $11 ELSE NULL END, $11, $11)",
    )
    .bind(&device_id)
    .bind(account_id)
    .bind(registration.display_name.as_deref())
    .bind(&registration.public_key)
    .bind(&registration.key_algorithm)
    .bind(registration.platform.as_deref())
    .bind(registration.os_version.as_deref())
    .bind(registration.app_version.as_deref())
    .bind(registration.approximate_location.as_deref())
    .bind(initial_authorization_state)
    .bind(&now)
    .execute(&mut **transaction)
    .await?;

    Ok(AuthorizedDevice {
        device_id,
        is_new_authorization: true,
    })
}

pub async fn append_device_sync_event(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    event_type: &str,
    device_id: &str,
    display_name: Option<&str>,
    authorization_state: &str,
) -> Result<(), StoreError> {
    append_user_sync_events_in_transaction(
        transaction,
        &[account_id.to_string()],
        event_type,
        None,
        &json!({
            "schemaVersion": 1,
            "deviceId": device_id,
            "displayName": display_name,
            "authorizationState": authorization_state,
        }),
    )
    .await
}

pub fn operation_fingerprint(value: &Value) -> String {
    let encoded = serde_json::to_vec(value).unwrap_or_default();
    hex::encode(Sha256::digest(encoded))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StoredDeviceOperation {
    pub operation_kind: String,
    pub request_fingerprint: String,
    pub result: Value,
}

pub async fn lock_device_operation(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    operation_id: uuid::Uuid,
) -> Result<(), sqlx_core::Error> {
    let lock_key = format!("device-operation:{account_id}:{operation_id}");
    query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(lock_key)
        .execute(&mut **transaction)
        .await?;
    Ok(())
}

pub async fn existing_device_operation(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    operation_id: uuid::Uuid,
) -> Result<Option<StoredDeviceOperation>, sqlx_core::Error> {
    let row: Option<(String, String, Value)> = query_as(
        "SELECT operation_kind, request_fingerprint, result \
         FROM cloud_device_operations WHERE account_id = $1 AND client_operation_id = $2",
    )
    .bind(account_id)
    .bind(operation_id)
    .fetch_optional(&mut **transaction)
    .await?;
    Ok(row.map(
        |(operation_kind, request_fingerprint, result)| StoredDeviceOperation {
            operation_kind,
            request_fingerprint,
            result,
        },
    ))
}

pub async fn record_device_operation(
    transaction: &mut Transaction<'_, Postgres>,
    account_id: &str,
    operation_id: uuid::Uuid,
    operation_kind: &str,
    request_fingerprint: &str,
    result: &Value,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_device_operations \
         (account_id, client_operation_id, operation_kind, request_fingerprint, result) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(account_id)
    .bind(operation_id)
    .bind(operation_kind)
    .bind(request_fingerprint)
    .bind(result)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_public_key() -> String {
        let secret = p256::SecretKey::from_slice(&[7_u8; 32]).unwrap();
        URL_SAFE_NO_PAD.encode(secret.public_key().to_sec1_bytes())
    }

    #[test]
    fn normalizes_real_p256_installation_metadata() {
        let normalized = normalize_device_registration(DeviceRegistrationRequest {
            display_name: Some("  Ada's iPhone  ".to_string()),
            platform: Some("iOS".to_string()),
            os_version: Some("19.0".to_string()),
            app_version: Some("1.2.3".to_string()),
            approximate_location: Some("Riyadh, Saudi Arabia".to_string()),
            public_key: valid_public_key(),
            key_algorithm: "P256".to_string(),
        })
        .unwrap();

        assert_eq!(normalized.display_name.as_deref(), Some("Ada's iPhone"));
        assert_eq!(normalized.platform.as_deref(), Some("ios"));
        assert_eq!(normalized.key_algorithm, "p256");
    }

    #[test]
    fn rejects_placeholder_or_malformed_public_keys() {
        let request = DeviceRegistrationRequest {
            display_name: None,
            platform: None,
            os_version: None,
            app_version: None,
            approximate_location: None,
            public_key: "placeholder-device-key".to_string(),
            key_algorithm: "p256".to_string(),
        };
        assert_eq!(
            normalize_device_registration(request).unwrap_err(),
            DeviceInputError::InvalidPublicKey
        );
    }
}
