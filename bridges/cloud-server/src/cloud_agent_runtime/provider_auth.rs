use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use std::fmt;
use uuid::Uuid;

const NONCE_LEN: usize = 12;

#[derive(Debug, thiserror::Error)]
pub enum ProviderAuthCipherError {
    #[error("provider auth encryption key is not configured")]
    MissingKey,
    #[error("provider auth ciphertext is invalid")]
    InvalidCiphertext,
    #[error("provider auth encryption failed")]
    Encrypt,
    #[error("provider auth decryption failed")]
    Decrypt,
}

pub trait ProviderAuthCipher: Send + Sync {
    fn key_id(&self) -> &str;
    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError>;
    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError>;
}

pub struct EnvProviderAuthCipher {
    key_id: String,
    cipher: Aes256Gcm,
}

impl EnvProviderAuthCipher {
    pub fn from_env() -> Result<Self, ProviderAuthCipherError> {
        let raw_key = std::env::var("KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY")
            .map_err(|_| ProviderAuthCipherError::MissingKey)?;
        if raw_key.trim().len() < 24 {
            return Err(ProviderAuthCipherError::MissingKey);
        }
        let key_id = std::env::var("KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY_ID")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "env:v1".to_string());
        let digest = Sha256::digest(raw_key.as_bytes());
        let key = Key::<Aes256Gcm>::from_slice(&digest);
        Ok(Self {
            key_id,
            cipher: Aes256Gcm::new(key),
        })
    }
}

impl ProviderAuthCipher for EnvProviderAuthCipher {
    fn key_id(&self) -> &str {
        &self.key_id
    }

    fn encrypt(&self, plaintext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError> {
        let mut nonce_bytes = [0_u8; NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext)
            .map_err(|_| ProviderAuthCipherError::Encrypt)?;
        let mut output = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        output.extend_from_slice(&nonce_bytes);
        output.extend_from_slice(&ciphertext);
        Ok(output)
    }

    fn decrypt(&self, ciphertext: &[u8]) -> Result<Vec<u8>, ProviderAuthCipherError> {
        if ciphertext.len() <= NONCE_LEN {
            return Err(ProviderAuthCipherError::InvalidCiphertext);
        }
        let (nonce_bytes, payload) = ciphertext.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);
        self.cipher
            .decrypt(nonce, payload)
            .map_err(|_| ProviderAuthCipherError::Decrypt)
    }
}

#[derive(Debug, Deserialize)]
pub struct PublishProviderAuthSnapshotRequest {
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    pub payload: Value,
}

impl PublishProviderAuthSnapshotRequest {
    pub fn normalized(&self) -> Option<NormalizedProviderAuthSnapshotInput> {
        let provider = self.provider.trim().to_ascii_lowercase();
        let auth_choice = self.auth_choice.trim().to_string();
        if provider.is_empty() || auth_choice.is_empty() || self.payload.is_null() {
            return None;
        }
        Some(NormalizedProviderAuthSnapshotInput {
            provider,
            auth_choice,
            payload: self.payload.clone(),
        })
    }
}

#[derive(Debug, Clone)]
pub struct NormalizedProviderAuthSnapshotInput {
    pub provider: String,
    pub auth_choice: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderAuthSnapshotResponse {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "revokedAt")]
    pub revoked_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CurrentProviderAuthSnapshotResponse {
    pub snapshot: Option<ProviderAuthSnapshotResponse>,
}

#[derive(Debug, Serialize)]
pub struct RunnerProviderAuthMaterialEnvelope {
    #[serde(rename = "providerAuth")]
    pub provider_auth: RunnerProviderAuthMaterial,
}

#[derive(Serialize)]
pub struct RunnerProviderAuthMaterial {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    pub payload: Value,
}

impl fmt::Debug for RunnerProviderAuthMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerProviderAuthMaterial")
            .field("snapshot_id", &self.snapshot_id)
            .field("provider", &self.provider)
            .field("auth_choice", &self.auth_choice)
            .field("payload", &"[REDACTED]")
            .finish()
    }
}

pub struct ServiceProviderAuth<'a> {
    pub owner_account_id: &'a str,
    pub snapshot_id: &'a str,
    pub provider: &'a str,
    pub auth_choice: &'a str,
    pub api_key: &'a str,
    pub base_url: &'a str,
    pub model: &'a str,
}

#[derive(Debug)]
pub enum ProviderAuthForRunResult {
    Found(RunnerProviderAuthMaterial),
    RunNotFound,
    ProviderAuthNotFound,
    ProviderAuthCipherUnavailable,
}

#[derive(Debug, Deserialize)]
pub struct CurrentProviderAuthSnapshotQuery {
    pub provider: Option<String>,
    #[serde(rename = "authChoice")]
    pub auth_choice: Option<String>,
}

pub async fn publish_snapshot(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    account_id: &str,
    device_id: &str,
    input: NormalizedProviderAuthSnapshotInput,
) -> Result<ProviderAuthSnapshotResponse, sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let snapshot_id = format!("snap_{}", Uuid::new_v4().simple());
    let payload_bytes = serde_json::to_vec(&input.payload)
        .map_err(|err| sqlx_core::Error::Encode(Box::new(err)))?;
    let encrypted_payload = cipher
        .encrypt(&payload_bytes)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;

    let mut tx = pool.begin().await?;
    let revoked_rows: Vec<(String,)> = query_as(
        "UPDATE cloud_agent_provider_auth_snapshots \
         SET revoked_at = $4 \
         WHERE account_id = $1 AND provider = $2 AND auth_choice = $3 AND revoked_at IS NULL \
         RETURNING snapshot_id",
    )
    .bind(account_id)
    .bind(&input.provider)
    .bind(&input.auth_choice)
    .bind(&now)
    .fetch_all(&mut *tx)
    .await?;
    for (revoked_snapshot_id,) in revoked_rows {
        insert_audit_in_tx(
            &mut tx,
            &revoked_snapshot_id,
            account_id,
            None,
            "revoked",
            &now,
        )
        .await?;
    }

    let row: (String, String, String, String, Option<String>) = query_as(
        "INSERT INTO cloud_agent_provider_auth_snapshots (
            snapshot_id, account_id, device_id, provider, auth_choice, encrypted_payload,
            encryption_key_id, created_at, revoked_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL)
         RETURNING snapshot_id, provider, auth_choice, created_at, revoked_at",
    )
    .bind(&snapshot_id)
    .bind(account_id)
    .bind(device_id)
    .bind(&input.provider)
    .bind(&input.auth_choice)
    .bind(encrypted_payload)
    .bind(cipher.key_id())
    .bind(&now)
    .fetch_one(&mut *tx)
    .await?;
    insert_audit_in_tx(&mut tx, &snapshot_id, account_id, None, "created", &now).await?;
    tx.commit().await?;

    Ok(snapshot_response_from_row(row))
}

pub async fn current_snapshot(
    pool: &PgPool,
    account_id: &str,
    query: &CurrentProviderAuthSnapshotQuery,
) -> Result<Option<ProviderAuthSnapshotResponse>, sqlx_core::Error> {
    let provider = query
        .provider
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    let auth_choice = query
        .auth_choice
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let row: Option<(String, String, String, String, Option<String>)> = query_as(
        "SELECT snapshot_id, provider, auth_choice, created_at, revoked_at \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL \
           AND ($2::TEXT IS NULL OR provider = $2) \
           AND ($3::TEXT IS NULL OR auth_choice = $3) \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(account_id)
    .bind(provider.as_deref())
    .bind(auth_choice.as_deref())
    .fetch_optional(pool)
    .await?;
    Ok(row.map(snapshot_response_from_row))
}

pub async fn revoke_snapshot(
    pool: &PgPool,
    account_id: &str,
    snapshot_id: &str,
) -> Result<Option<ProviderAuthSnapshotResponse>, sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    let row: Option<(String, String, String, String, Option<String>)> = query_as(
        "UPDATE cloud_agent_provider_auth_snapshots \
         SET revoked_at = COALESCE(revoked_at, $3) \
         WHERE account_id = $1 AND snapshot_id = $2 \
         RETURNING snapshot_id, provider, auth_choice, created_at, revoked_at",
    )
    .bind(account_id)
    .bind(snapshot_id)
    .bind(&now)
    .fetch_optional(&mut *tx)
    .await?;
    if row.is_some() {
        insert_audit_in_tx(&mut tx, snapshot_id, account_id, None, "revoked", &now).await?;
    }
    tx.commit().await?;
    Ok(row.map(snapshot_response_from_row))
}

pub async fn provider_auth_for_run(
    pool: &PgPool,
    cipher: Option<&dyn ProviderAuthCipher>,
    service_auth: Option<ServiceProviderAuth<'_>>,
    run_id: &str,
    runner_id: &str,
) -> Result<ProviderAuthForRunResult, sqlx_core::Error> {
    let run: Option<(String, String)> = query_as(
        "SELECT owner_account_id, provider_auth_source FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((owner_account_id, provider_auth_source)) = run else {
        return Ok(ProviderAuthForRunResult::RunNotFound);
    };

    if provider_auth_source == "support_service" {
        let Some(service_auth) =
            service_auth.filter(|service_auth| service_auth.owner_account_id == owner_account_id)
        else {
            return Ok(ProviderAuthForRunResult::ProviderAuthNotFound);
        };
        return Ok(ProviderAuthForRunResult::Found(
            RunnerProviderAuthMaterial {
                snapshot_id: service_auth.snapshot_id.to_string(),
                provider: service_auth.provider.to_string(),
                auth_choice: service_auth.auth_choice.to_string(),
                payload: serde_json::json!({
                    "apiKey": service_auth.api_key,
                    "baseUrl": service_auth.base_url,
                    "model": service_auth.model,
                }),
            },
        ));
    }
    if provider_auth_source != "owner_snapshot" {
        return Ok(ProviderAuthForRunResult::ProviderAuthNotFound);
    }
    let Some(cipher) = cipher else {
        return Ok(ProviderAuthForRunResult::ProviderAuthCipherUnavailable);
    };

    let row: Option<(String, String, String, Vec<u8>)> = query_as(
        "SELECT snapshot_id, provider, auth_choice, encrypted_payload \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&owner_account_id)
    .fetch_optional(pool)
    .await?;
    let Some((snapshot_id, provider, auth_choice, encrypted_payload)) = row else {
        return Ok(ProviderAuthForRunResult::ProviderAuthNotFound);
    };

    let plaintext = cipher
        .decrypt(&encrypted_payload)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;
    let payload: Value = serde_json::from_slice(&plaintext)
        .map_err(|err| sqlx_core::Error::Decode(Box::new(err)))?;
    record_snapshot_used(pool, &snapshot_id, &owner_account_id, Some(run_id)).await?;

    Ok(ProviderAuthForRunResult::Found(
        RunnerProviderAuthMaterial {
            snapshot_id,
            provider,
            auth_choice,
            payload,
        },
    ))
}

pub async fn record_snapshot_used(
    pool: &PgPool,
    snapshot_id: &str,
    account_id: &str,
    run_id: Option<&str>,
) -> Result<(), sqlx_core::Error> {
    let now = Utc::now().to_rfc3339();
    query(
        "INSERT INTO cloud_agent_provider_auth_snapshot_audit \
         (audit_id, snapshot_id, account_id, run_id, action, created_at) \
         VALUES ($1, $2, $3, $4, 'used', $5)",
    )
    .bind(format!("audit_{}", Uuid::new_v4().simple()))
    .bind(snapshot_id)
    .bind(account_id)
    .bind(run_id)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(())
}

async fn insert_audit_in_tx(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    snapshot_id: &str,
    account_id: &str,
    run_id: Option<&str>,
    action: &str,
    now: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_agent_provider_auth_snapshot_audit \
         (audit_id, snapshot_id, account_id, run_id, action, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(format!("audit_{}", Uuid::new_v4().simple()))
    .bind(snapshot_id)
    .bind(account_id)
    .bind(run_id)
    .bind(action)
    .bind(now)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn snapshot_response_from_row(
    row: (String, String, String, String, Option<String>),
) -> ProviderAuthSnapshotResponse {
    ProviderAuthSnapshotResponse {
        snapshot_id: row.0,
        provider: row.1,
        auth_choice: row.2,
        created_at: row.3,
        revoked_at: row.4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_cipher_round_trips_without_plaintext_ciphertext() {
        std::env::set_var(
            "KORDI_CLOUD_PROVIDER_AUTH_ENCRYPTION_KEY",
            "unit-test-provider-auth-key-that-is-long-enough",
        );
        let cipher = EnvProviderAuthCipher::from_env().unwrap();
        let plaintext = br#"{"accessToken":"secret"}"#;
        let encrypted = cipher.encrypt(plaintext).unwrap();

        assert_ne!(encrypted, plaintext);
        assert!(!String::from_utf8_lossy(&encrypted).contains("secret"));
        assert_eq!(cipher.decrypt(&encrypted).unwrap(), plaintext);
    }

    #[test]
    fn publish_request_rejects_empty_fields() {
        let request = PublishProviderAuthSnapshotRequest {
            provider: " ".to_string(),
            auth_choice: "default".to_string(),
            payload: serde_json::json!({"token":"x"}),
        };
        assert!(request.normalized().is_none());
    }

    #[test]
    fn runner_provider_auth_debug_redacts_secret_payloads() {
        let material = RunnerProviderAuthMaterial {
            snapshot_id: "support-service-openai".to_string(),
            provider: "openai".to_string(),
            auth_choice: "support-service-api-key".to_string(),
            payload: serde_json::json!({"apiKey":"secret-support-key"}),
        };

        let debug = format!("{material:?}");
        assert!(debug.contains("[REDACTED]"));
        assert!(!debug.contains("secret-support-key"));
    }
}
