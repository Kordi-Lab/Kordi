use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{DateTime, Duration, Utc};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use uuid::Uuid;
use x25519_dalek::{PublicKey, StaticSecret};

const NONCE_LEN: usize = 12;
const DEVICE_RESTORE_SALT_LEN: usize = 32;
const DEVICE_RESTORE_KEY_LEN: usize = 32;
const DEVICE_RESTORE_MAX_SNAPSHOTS: i64 = 32;
const DEVICE_RESTORE_MAX_PLAINTEXT_BYTES: usize = 1024 * 1024;
const DEVICE_RESTORE_SESSION_MAX_AGE_MINUTES: i64 = 15;
const DEVICE_RESTORE_ALGORITHM: &str = "x25519-hkdf-sha256-aes-256-gcm-v1";
const DEVICE_RESTORE_HKDF_INFO: &[u8] = b"kordi-provider-auth-device-restore-v1";

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

#[derive(Debug, Deserialize)]
pub struct RestoreProviderAuthSnapshotsRequest {
    #[serde(rename = "devicePublicKey")]
    pub device_public_key: String,
    #[serde(rename = "knownRevision")]
    pub known_revision: Option<String>,
}

impl RestoreProviderAuthSnapshotsRequest {
    pub fn decoded_device_public_key(&self) -> Option<[u8; 32]> {
        let decoded = URL_SAFE_NO_PAD.decode(self.device_public_key.trim()).ok()?;
        decoded.try_into().ok()
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProviderAuthDeviceRestoreEnvelope {
    pub algorithm: String,
    #[serde(rename = "serverPublicKey")]
    pub server_public_key: String,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Serialize)]
pub struct RestoreProviderAuthSnapshotsResponse {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "snapshotCount")]
    pub snapshot_count: usize,
    #[serde(rename = "syncRevision")]
    pub sync_revision: String,
    pub changed: bool,
    pub envelope: Option<ProviderAuthDeviceRestoreEnvelope>,
}

#[derive(Debug, Serialize)]
pub struct ProviderAuthSnapshotManifestResponse {
    #[serde(rename = "syncRevision")]
    pub sync_revision: String,
    pub snapshots: Vec<ProviderAuthSnapshotResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestorableProviderAuthSnapshot {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub payload: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProviderAuthDeviceRestoreBundle {
    pub version: u32,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    #[serde(rename = "syncRevision")]
    pub sync_revision: String,
    pub snapshots: Vec<RestorableProviderAuthSnapshot>,
}

#[derive(Debug, Serialize)]
pub struct RunnerProviderAuthMaterialEnvelope {
    #[serde(rename = "providerAuth")]
    pub provider_auth: RunnerProviderAuthMaterial,
}

#[derive(Debug, Serialize)]
pub struct RunnerProviderAuthMaterial {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub provider: String,
    #[serde(rename = "authChoice")]
    pub auth_choice: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
pub struct RefreshRunnerProviderAuthRequest {
    #[serde(rename = "runnerId")]
    pub runner_id: String,
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    pub payload: Value,
}

#[derive(Debug)]
pub enum ProviderAuthForRunResult {
    Found(RunnerProviderAuthMaterial),
    RunNotFound,
    ProviderAuthNotFound,
}

#[derive(Debug)]
pub enum RefreshProviderAuthForRunResult {
    Refreshed(RunnerProviderAuthMaterial),
    RunNotFound,
    SnapshotNotFound,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceRestoreKeyAuthorization {
    Allowed,
    ReauthenticationRequired,
    KeyMismatch,
    DeviceNotFound,
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
    let current: Option<(
        String,
        String,
        String,
        String,
        Option<String>,
        Vec<u8>,
        String,
    )> = query_as(
        "SELECT snapshot_id, provider, auth_choice, created_at, revoked_at, \
                encrypted_payload, encryption_key_id \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND provider = $2 AND auth_choice = $3 \
           AND revoked_at IS NULL \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(account_id)
    .bind(&input.provider)
    .bind(&input.auth_choice)
    .fetch_optional(pool)
    .await?;
    if let Some((snapshot_id, provider, auth_choice, created_at, revoked_at, encrypted, key_id)) =
        current
    {
        if key_id == cipher.key_id()
            && cipher
                .decrypt(&encrypted)
                .ok()
                .and_then(|plaintext| serde_json::from_slice::<Value>(&plaintext).ok())
                .as_ref()
                == Some(&input.payload)
        {
            return Ok(ProviderAuthSnapshotResponse {
                snapshot_id,
                provider,
                auth_choice,
                created_at,
                revoked_at,
            });
        }
    }

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

pub async fn snapshot_manifest(
    pool: &PgPool,
    account_id: &str,
) -> Result<ProviderAuthSnapshotManifestResponse, sqlx_core::Error> {
    let rows: Vec<(String, String, String, String, Option<String>)> = query_as(
        "SELECT snapshot_id, provider, auth_choice, created_at, revoked_at \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND revoked_at IS NULL \
         ORDER BY provider ASC, auth_choice ASC, snapshot_id ASC",
    )
    .bind(account_id)
    .fetch_all(pool)
    .await?;
    let sync_revision =
        provider_auth_sync_revision(rows.iter().map(|row| (&row.0, &row.1, &row.2, &row.3)));
    Ok(ProviderAuthSnapshotManifestResponse {
        sync_revision,
        snapshots: rows.into_iter().map(snapshot_response_from_row).collect(),
    })
}

fn provider_auth_sync_revision<'a>(
    rows: impl IntoIterator<Item = (&'a String, &'a String, &'a String, &'a String)>,
) -> String {
    let mut digest = Sha256::new();
    digest.update(b"kordi-provider-auth-sync-v1\0");
    for (snapshot_id, provider, auth_choice, created_at) in rows {
        for value in [snapshot_id, provider, auth_choice, created_at] {
            digest.update((value.len() as u64).to_be_bytes());
            digest.update(value.as_bytes());
        }
    }
    hex::encode(digest.finalize())
}

pub async fn session_is_recent_enough_for_provider_auth_restore(
    pool: &PgPool,
    token_id: &str,
    account_id: &str,
    device_id: &str,
) -> Result<bool, sqlx_core::Error> {
    let row: Option<(String,)> = query_as(
        "SELECT created_at FROM cloud_refresh_tokens \
         WHERE token_id = $1 AND account_id = $2 AND device_id = $3 \
           AND revoked_at IS NULL",
    )
    .bind(token_id)
    .bind(account_id)
    .bind(device_id)
    .fetch_optional(pool)
    .await?;
    let Some((created_at,)) = row else {
        return Ok(false);
    };
    let Ok(created_at) = DateTime::parse_from_rfc3339(&created_at) else {
        return Ok(false);
    };
    let created_at = created_at.with_timezone(&Utc);
    let now = Utc::now();
    Ok(created_at <= now + Duration::minutes(1)
        && created_at >= now - Duration::minutes(DEVICE_RESTORE_SESSION_MAX_AGE_MINUTES))
}

pub async fn authorize_device_restore_key(
    pool: &PgPool,
    token_id: &str,
    account_id: &str,
    device_id: &str,
    device_public_key: &[u8; 32],
) -> Result<DeviceRestoreKeyAuthorization, sqlx_core::Error> {
    let current: Option<(String,)> = query_as(
        "SELECT device_public_key FROM cloud_devices \
         WHERE device_id = $1 AND account_id = $2 AND revoked_at IS NULL",
    )
    .bind(device_id)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    let Some((current_key,)) = current else {
        return Ok(DeviceRestoreKeyAuthorization::DeviceNotFound);
    };
    let registered = format!("x25519:v1:{}", URL_SAFE_NO_PAD.encode(device_public_key));
    if current_key == registered {
        return Ok(DeviceRestoreKeyAuthorization::Allowed);
    }
    if current_key.starts_with("x25519:v1:") {
        return Ok(DeviceRestoreKeyAuthorization::KeyMismatch);
    }
    if !session_is_recent_enough_for_provider_auth_restore(pool, token_id, account_id, device_id)
        .await?
    {
        return Ok(DeviceRestoreKeyAuthorization::ReauthenticationRequired);
    }
    let updated = query(
        "UPDATE cloud_devices SET device_public_key = $3, last_seen_at = $4 \
         WHERE device_id = $1 AND account_id = $2 AND revoked_at IS NULL \
           AND device_public_key = $5",
    )
    .bind(device_id)
    .bind(account_id)
    .bind(&registered)
    .bind(Utc::now().to_rfc3339())
    .bind(&current_key)
    .execute(pool)
    .await?;
    Ok(if updated.rows_affected() == 1 {
        DeviceRestoreKeyAuthorization::Allowed
    } else {
        DeviceRestoreKeyAuthorization::KeyMismatch
    })
}

pub async fn restore_snapshots_for_device(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    account_id: &str,
    device_id: &str,
    device_public_key: [u8; 32],
    known_revision: Option<&str>,
) -> Result<RestoreProviderAuthSnapshotsResponse, sqlx_core::Error> {
    let rows: Vec<(String, String, String, String, Vec<u8>)> = query_as(
        "SELECT snapshot_id, provider, auth_choice, created_at, encrypted_payload \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND encryption_key_id = $2 AND revoked_at IS NULL \
         ORDER BY created_at DESC LIMIT $3",
    )
    .bind(account_id)
    .bind(cipher.key_id())
    .bind(DEVICE_RESTORE_MAX_SNAPSHOTS)
    .fetch_all(pool)
    .await?;

    let mut snapshots = Vec::new();
    for (snapshot_id, provider, auth_choice, created_at, encrypted_payload) in rows {
        let plaintext = cipher
            .decrypt(&encrypted_payload)
            .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;
        let payload: Value = serde_json::from_slice(&plaintext)
            .map_err(|err| sqlx_core::Error::Decode(Box::new(err)))?;
        if !is_restorable_provider_auth_payload(&payload) {
            continue;
        }
        snapshots.push(RestorableProviderAuthSnapshot {
            snapshot_id,
            provider,
            auth_choice,
            created_at,
            payload,
        });
    }

    let sync_revision = provider_auth_sync_revision(snapshots.iter().map(|snapshot| {
        (
            &snapshot.snapshot_id,
            &snapshot.provider,
            &snapshot.auth_choice,
            &snapshot.created_at,
        )
    }));
    let changed = known_revision.map(str::trim) != Some(sync_revision.as_str());
    if !changed || snapshots.is_empty() {
        return Ok(RestoreProviderAuthSnapshotsResponse {
            device_id: device_id.to_string(),
            snapshot_count: snapshots.len(),
            sync_revision,
            changed,
            envelope: None,
        });
    }

    let snapshot_count = snapshots.len();
    let bundle = ProviderAuthDeviceRestoreBundle {
        version: 2,
        account_id: account_id.to_string(),
        device_id: device_id.to_string(),
        sync_revision: sync_revision.clone(),
        snapshots,
    };
    let plaintext =
        serde_json::to_vec(&bundle).map_err(|err| sqlx_core::Error::Encode(Box::new(err)))?;
    if plaintext.len() > DEVICE_RESTORE_MAX_PLAINTEXT_BYTES {
        return Err(sqlx_core::Error::Protocol(
            "provider auth restore bundle is too large".to_string(),
        ));
    }
    let envelope =
        encrypt_device_restore_bundle(account_id, device_id, &device_public_key, &plaintext)
            .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;

    let restored_at = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    for snapshot in &bundle.snapshots {
        insert_audit_in_tx(
            &mut tx,
            &snapshot.snapshot_id,
            account_id,
            None,
            "restored",
            &restored_at,
        )
        .await?;
    }
    tx.commit().await?;

    Ok(RestoreProviderAuthSnapshotsResponse {
        device_id: device_id.to_string(),
        snapshot_count,
        sync_revision,
        changed: true,
        envelope: Some(envelope),
    })
}

fn is_restorable_provider_auth_payload(payload: &Value) -> bool {
    payload
        .get("apiKey")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
        || matches!(
            payload.get("apiMode").and_then(Value::as_str),
            Some("openai-codex-oauth" | "anthropic-oauth" | "github-copilot-oauth")
        )
}

fn device_restore_aad(account_id: &str, device_id: &str) -> Vec<u8> {
    format!("kordi-provider-auth-device-restore-v1\0{account_id}\0{device_id}").into_bytes()
}

fn encrypt_device_restore_bundle(
    account_id: &str,
    device_id: &str,
    device_public_key: &[u8; 32],
    plaintext: &[u8],
) -> Result<ProviderAuthDeviceRestoreEnvelope, ProviderAuthCipherError> {
    let device_public_key = PublicKey::from(*device_public_key);
    let server_secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
    let server_public_key = PublicKey::from(&server_secret);
    let shared_secret = server_secret.diffie_hellman(&device_public_key);
    if !shared_secret.was_contributory() {
        return Err(ProviderAuthCipherError::Encrypt);
    }
    let mut salt = [0_u8; DEVICE_RESTORE_SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let mut key_bytes = [0_u8; DEVICE_RESTORE_KEY_LEN];
    Hkdf::<Sha256>::new(Some(&salt), shared_secret.as_bytes())
        .expand(DEVICE_RESTORE_HKDF_INFO, &mut key_bytes)
        .map_err(|_| ProviderAuthCipherError::Encrypt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
    let mut nonce_bytes = [0_u8; NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let ciphertext = cipher.encrypt(
        Nonce::from_slice(&nonce_bytes),
        Payload {
            msg: plaintext,
            aad: &device_restore_aad(account_id, device_id),
        },
    );
    key_bytes.fill(0);
    let ciphertext = ciphertext.map_err(|_| ProviderAuthCipherError::Encrypt)?;

    Ok(ProviderAuthDeviceRestoreEnvelope {
        algorithm: DEVICE_RESTORE_ALGORITHM.to_string(),
        server_public_key: URL_SAFE_NO_PAD.encode(server_public_key.as_bytes()),
        salt: URL_SAFE_NO_PAD.encode(salt),
        nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
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
    cipher: &dyn ProviderAuthCipher,
    run_id: &str,
    runner_id: &str,
) -> Result<ProviderAuthForRunResult, sqlx_core::Error> {
    let run: Option<(String, Option<String>)> = query_as(
        "SELECT owner_account_id, target_agent_id FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(pool)
    .await?;
    let Some((owner_account_id, target_agent_id)) = run else {
        return Ok(ProviderAuthForRunResult::RunNotFound);
    };

    let agent_route: Option<(Option<String>, Option<String>, Option<String>)> =
        match target_agent_id.as_deref() {
            Some(agent_id) => {
                query_as(
                    "SELECT NULLIF(BTRIM(model_routing_json->>'defaultAuthProvider'), ''), \
                        NULLIF(BTRIM(model_routing_json->>'defaultAuthChoice'), ''), \
                        NULLIF(BTRIM(model_routing_json->>'defaultModel'), '') \
                 FROM cloud_agent_definitions \
                 WHERE agent_id = $1 AND owner_account_id = $2 AND status = 'active'",
                )
                .bind(agent_id)
                .bind(&owner_account_id)
                .fetch_optional(pool)
                .await?
            }
            None => None,
        };
    let (route_provider, route_auth_choice, route_model) =
        agent_route.unwrap_or((None, None, None));
    let route_provider = route_provider
        .as_deref()
        .map(normalize_snapshot_provider)
        .map(ToString::to_string);

    let mut row: Option<(String, String, String, Vec<u8>)> = query_as(
        "SELECT snapshot_id, provider, auth_choice, encrypted_payload \
         FROM cloud_agent_provider_auth_snapshots \
         WHERE account_id = $1 AND encryption_key_id = $2 AND revoked_at IS NULL \
           AND ($3::TEXT IS NULL OR provider = $3 \
                OR ($3 = 'openai' AND provider = 'openai-codex')) \
           AND ($4::TEXT IS NULL OR auth_choice = $4) \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(&owner_account_id)
    .bind(cipher.key_id())
    .bind(route_provider.as_deref())
    .bind(route_auth_choice.as_deref())
    .fetch_optional(pool)
    .await?;
    if row.is_none() && route_provider.is_some() && route_auth_choice.is_some() {
        let candidates: Vec<(String, String, String, Vec<u8>)> = query_as(
            "SELECT snapshot_id, provider, auth_choice, encrypted_payload \
             FROM cloud_agent_provider_auth_snapshots \
             WHERE account_id = $1 AND encryption_key_id = $2 AND revoked_at IS NULL \
               AND (provider = $3 OR ($3 = 'openai' AND provider = 'openai-codex')) \
             ORDER BY created_at DESC LIMIT 2",
        )
        .bind(&owner_account_id)
        .bind(cipher.key_id())
        .bind(route_provider.as_deref())
        .fetch_all(pool)
        .await?;
        if candidates.len() == 1 {
            row = candidates.into_iter().next();
        }
    }
    let Some((snapshot_id, provider, auth_choice, encrypted_payload)) = row else {
        return Ok(ProviderAuthForRunResult::ProviderAuthNotFound);
    };

    let plaintext = cipher
        .decrypt(&encrypted_payload)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;
    let mut payload: Value = serde_json::from_slice(&plaintext)
        .map_err(|err| sqlx_core::Error::Decode(Box::new(err)))?;
    if let Some(model) = route_model {
        if let Some(object) = payload.as_object_mut() {
            object.insert("model".to_string(), Value::String(model));
        }
    }
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

pub async fn refresh_provider_auth_for_run(
    pool: &PgPool,
    cipher: &dyn ProviderAuthCipher,
    run_id: &str,
    runner_id: &str,
    snapshot_id: &str,
    payload: Value,
) -> Result<RefreshProviderAuthForRunResult, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let run: Option<(String,)> = query_as(
        "SELECT owner_account_id FROM cloud_agent_fallback_runs \
         WHERE run_id = $1 AND claimed_by = $2 AND status IN ('leased', 'running')",
    )
    .bind(run_id)
    .bind(runner_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((owner_account_id,)) = run else {
        return Ok(RefreshProviderAuthForRunResult::RunNotFound);
    };

    let payload_bytes =
        serde_json::to_vec(&payload).map_err(|err| sqlx_core::Error::Encode(Box::new(err)))?;
    let encrypted_payload = cipher
        .encrypt(&payload_bytes)
        .map_err(|err| sqlx_core::Error::Protocol(err.to_string()))?;
    let row: Option<(String, String)> = query_as(
        "UPDATE cloud_agent_provider_auth_snapshots \
         SET encrypted_payload = $4 \
         WHERE snapshot_id = $1 AND account_id = $2 AND encryption_key_id = $3 \
           AND revoked_at IS NULL \
         RETURNING provider, auth_choice",
    )
    .bind(snapshot_id)
    .bind(&owner_account_id)
    .bind(cipher.key_id())
    .bind(encrypted_payload)
    .fetch_optional(&mut *tx)
    .await?;
    let Some((provider, auth_choice)) = row else {
        return Ok(RefreshProviderAuthForRunResult::SnapshotNotFound);
    };
    insert_audit_in_tx(
        &mut tx,
        snapshot_id,
        &owner_account_id,
        Some(run_id),
        "refreshed",
        &Utc::now().to_rfc3339(),
    )
    .await?;
    tx.commit().await?;

    Ok(RefreshProviderAuthForRunResult::Refreshed(
        RunnerProviderAuthMaterial {
            snapshot_id: snapshot_id.to_string(),
            provider,
            auth_choice,
            payload,
        },
    ))
}

fn normalize_snapshot_provider(provider: &str) -> &str {
    match provider.trim() {
        "openai-codex" => "openai",
        "anthropic-oauth" => "anthropic",
        value => value,
    }
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
    fn agent_route_provider_aliases_match_account_snapshots() {
        assert_eq!(normalize_snapshot_provider("openai-codex"), "openai");
        assert_eq!(normalize_snapshot_provider("anthropic-oauth"), "anthropic");
        assert_eq!(
            normalize_snapshot_provider("github-copilot"),
            "github-copilot"
        );
    }

    #[test]
    fn device_restore_envelope_round_trips_only_for_target_account_and_key() {
        let device_secret = StaticSecret::random_from_rng(rand::rngs::OsRng);
        let device_public = PublicKey::from(&device_secret);
        let plaintext = br#"{"version":1,"accessToken":"secret"}"#;
        let envelope = encrypt_device_restore_bundle(
            "acct_owner",
            "dev_target",
            device_public.as_bytes(),
            plaintext,
        )
        .unwrap();
        assert_eq!(envelope.algorithm, DEVICE_RESTORE_ALGORITHM);
        assert!(!envelope.ciphertext.contains("secret"));

        let server_public_bytes: [u8; 32] = URL_SAFE_NO_PAD
            .decode(&envelope.server_public_key)
            .unwrap()
            .try_into()
            .unwrap();
        let server_public = PublicKey::from(server_public_bytes);
        let shared_secret = device_secret.diffie_hellman(&server_public);
        let salt = URL_SAFE_NO_PAD.decode(&envelope.salt).unwrap();
        let mut key_bytes = [0_u8; DEVICE_RESTORE_KEY_LEN];
        Hkdf::<Sha256>::new(Some(&salt), shared_secret.as_bytes())
            .expand(DEVICE_RESTORE_HKDF_INFO, &mut key_bytes)
            .unwrap();
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
        let nonce = URL_SAFE_NO_PAD.decode(&envelope.nonce).unwrap();
        let ciphertext = URL_SAFE_NO_PAD.decode(&envelope.ciphertext).unwrap();
        let decrypted = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &device_restore_aad("acct_owner", "dev_target"),
                },
            )
            .unwrap();
        assert_eq!(decrypted, plaintext);
        assert!(cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &device_restore_aad("acct_other", "dev_target"),
                },
            )
            .is_err());
    }

    #[test]
    fn restore_request_rejects_malformed_device_keys() {
        assert!(RestoreProviderAuthSnapshotsRequest {
            device_public_key: "not-a-key".to_string(),
            known_revision: None,
        }
        .decoded_device_public_key()
        .is_none());
    }
}
