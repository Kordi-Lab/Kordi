use super::*;

const RESTORE_SALT_LEN: usize = 32;
const RESTORE_KEY_LEN: usize = 32;
const RESTORE_MAX_SNAPSHOTS: i64 = 32;
const RESTORE_MAX_PLAINTEXT_BYTES: usize = 1024 * 1024;
const RESTORE_SESSION_MAX_AGE_MINUTES: i64 = 15;
const RESTORE_ALGORITHM: &str = "x25519-hkdf-sha256-aes-256-gcm-v1";
const RESTORE_HKDF_INFO: &[u8] = b"kordi-provider-auth-device-restore-v1";

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceRestoreKeyAuthorization {
    Allowed,
    ReauthenticationRequired,
    KeyMismatch,
    DeviceNotFound,
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
        && created_at >= now - Duration::minutes(RESTORE_SESSION_MAX_AGE_MINUTES))
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
    .bind(RESTORE_MAX_SNAPSHOTS)
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
    if plaintext.len() > RESTORE_MAX_PLAINTEXT_BYTES {
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
    let mut salt = [0_u8; RESTORE_SALT_LEN];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let mut key_bytes = [0_u8; RESTORE_KEY_LEN];
    Hkdf::<Sha256>::new(Some(&salt), shared_secret.as_bytes())
        .expand(RESTORE_HKDF_INFO, &mut key_bytes)
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
        algorithm: RESTORE_ALGORITHM.to_string(),
        server_public_key: URL_SAFE_NO_PAD.encode(server_public_key.as_bytes()),
        salt: URL_SAFE_NO_PAD.encode(salt),
        nonce: URL_SAFE_NO_PAD.encode(nonce_bytes),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_round_trips_only_for_target_account_and_key() {
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
        assert_eq!(envelope.algorithm, RESTORE_ALGORITHM);
        assert!(!envelope.ciphertext.contains("secret"));

        let server_public_bytes: [u8; 32] = URL_SAFE_NO_PAD
            .decode(&envelope.server_public_key)
            .unwrap()
            .try_into()
            .unwrap();
        let shared_secret = device_secret.diffie_hellman(&PublicKey::from(server_public_bytes));
        let salt = URL_SAFE_NO_PAD.decode(&envelope.salt).unwrap();
        let mut key_bytes = [0_u8; RESTORE_KEY_LEN];
        Hkdf::<Sha256>::new(Some(&salt), shared_secret.as_bytes())
            .expand(RESTORE_HKDF_INFO, &mut key_bytes)
            .unwrap();
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));
        let nonce = URL_SAFE_NO_PAD.decode(&envelope.nonce).unwrap();
        let ciphertext = URL_SAFE_NO_PAD.decode(&envelope.ciphertext).unwrap();
        let decrypt = |account| {
            cipher.decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &ciphertext,
                    aad: &device_restore_aad(account, "dev_target"),
                },
            )
        };
        assert_eq!(decrypt("acct_owner").unwrap(), plaintext);
        assert!(decrypt("acct_other").is_err());
    }

    #[test]
    fn request_rejects_malformed_device_keys() {
        assert!(RestoreProviderAuthSnapshotsRequest {
            device_public_key: "not-a-key".to_string(),
            known_revision: None,
        }
        .decoded_device_public_key()
        .is_none());
    }
}
