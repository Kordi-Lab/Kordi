use chrono::{Local, TimeZone};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use super::{
    DesktopBridgeConversationStore, DesktopBridgeHostConfig, DesktopBridgeIdentity,
    DesktopBridgeSecretsStore, DesktopBridgeStore, LegacyBridgeClientConfig,
};

pub(super) fn default_bridge_api_style() -> String {
    "registry".to_string()
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

pub(super) fn format_time_label(timestamp_ms: i64) -> String {
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|value| value.format("%H:%M").to_string())
        .unwrap_or_else(|| "--:--".to_string())
}

pub(super) fn format_time_label_with_seconds(timestamp_ms: i64) -> String {
    Local
        .timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|value| value.format("%H:%M:%S").to_string())
        .unwrap_or_else(|| "--:--:--".to_string())
}

pub(super) fn korde_dir() -> Result<PathBuf, String> {
    let home =
        std::env::var("HOME").map_err(|_| "Unable to determine home directory".to_string())?;
    Ok(PathBuf::from(home).join(".korde"))
}

pub(super) fn desktop_bridge_config_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join("desktop-bridges.json"))
}

pub(super) fn desktop_bridge_conversations_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join("desktop-bridge-conversations.json"))
}

pub(super) fn desktop_bridge_secrets_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join("desktop-bridge-secrets.json"))
}

pub(super) fn legacy_bridge_config_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join("config.json"))
}

pub(super) fn desktop_bridge_identity_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join("desktop-bridge-identity.json"))
}

pub(super) fn hosted_bridge_dir() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join("hosted-bridge"))
}

pub(super) fn load_legacy_bridge_config() -> Option<LegacyBridgeClientConfig> {
    let path = legacy_bridge_config_path().ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(super) fn load_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

pub(super) fn load_desktop_bridge_store() -> Option<DesktopBridgeStore> {
    let path = desktop_bridge_config_path().ok()?;
    let store = load_json_file(&path);
    let _ = ensure_owner_only_permissions(&path);
    store
}

pub(super) fn load_desktop_bridge_secrets_store() -> DesktopBridgeSecretsStore {
    let Some(path) = desktop_bridge_secrets_path().ok() else {
        return DesktopBridgeSecretsStore::default();
    };
    let store = load_json_file(&path).unwrap_or_default();
    let _ = ensure_owner_only_permissions(&path);
    store
}

pub(super) fn collect_bridge_secrets(store: &DesktopBridgeStore) -> DesktopBridgeSecretsStore {
    let mut secrets = DesktopBridgeSecretsStore::default();
    for host in &store.hosts {
        if !host.api_key.trim().is_empty() {
            secrets
                .host_api_keys
                .insert(host.id.clone(), host.api_key.clone());
        }
    }
    secrets
}

pub(super) fn hydrate_bridge_store_secrets(
    store: &mut DesktopBridgeStore,
    secrets: &DesktopBridgeSecretsStore,
) -> bool {
    let mut needs_migration = false;

    for host in &mut store.hosts {
        if host.api_key.trim().is_empty() {
            if let Some(api_key) = secrets.host_api_keys.get(&host.id) {
                host.api_key = api_key.clone();
            }
        } else {
            needs_migration = true;
        }
    }

    needs_migration
}

pub(super) fn ensure_owner_only_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let permissions = std::fs::Permissions::from_mode(0o600);
        std::fs::set_permissions(path, permissions).map_err(|err| err.to_string())?;
    }
    Ok(())
}

pub(super) fn write_owner_only_json_file<T: Serialize>(
    path: &Path,
    value: &T,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|err| err.to_string())?;
    std::fs::write(path, raw).map_err(|err| err.to_string())?;
    ensure_owner_only_permissions(path)
}

pub(super) fn save_bridge_secrets_store(store: &DesktopBridgeSecretsStore) -> Result<(), String> {
    let path = desktop_bridge_secrets_path()?;
    write_owner_only_json_file(&path, store)
}

pub(super) fn load_bridge_store() -> DesktopBridgeStore {
    if let Some(mut store) = load_desktop_bridge_store() {
        let needs_secret_migration =
            hydrate_bridge_store_secrets(&mut store, &load_desktop_bridge_secrets_store());
        if needs_secret_migration {
            let _ = save_bridge_store(&store);
        }
        return store;
    }

    if let Some(legacy) = load_legacy_bridge_config() {
        let host = DesktopBridgeHostConfig {
            id: format!("bridge_{}", Uuid::new_v4().simple()),
            coordination: legacy.coordination,
            node_id: legacy.node_id,
            api_key: legacy.api_key,
            display_name: legacy.display_name,
            owner: legacy.owner,
            api_style: default_bridge_api_style(),
        };
        let store = DesktopBridgeStore {
            active_host_id: Some(host.id.clone()),
            hosts: vec![host],
        };
        let _ = save_bridge_store(&store);
        return store;
    }

    DesktopBridgeStore::default()
}

pub(super) fn save_bridge_store(store: &DesktopBridgeStore) -> Result<(), String> {
    let path = desktop_bridge_config_path()?;
    save_bridge_secrets_store(&collect_bridge_secrets(store))?;
    write_owner_only_json_file(&path, store)
}

pub(super) fn load_conversation_store() -> DesktopBridgeConversationStore {
    let Some(path) = desktop_bridge_conversations_path().ok() else {
        return DesktopBridgeConversationStore::default();
    };
    let store = load_json_file(&path).unwrap_or_default();
    let _ = ensure_owner_only_permissions(&path);
    store
}

pub(super) fn save_conversation_store(
    store: &DesktopBridgeConversationStore,
) -> Result<(), String> {
    let path = desktop_bridge_conversations_path()?;
    write_owner_only_json_file(&path, store)
}

pub(super) fn normalize_server_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Bridge server URL cannot be empty".to_string());
    }
    let parsed =
        reqwest::Url::parse(trimmed).map_err(|err| format!("Invalid bridge server URL: {err}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.to_string()),
        _ => Err("Bridge server URL must use http or https".to_string()),
    }
}

pub(super) fn default_display_name() -> String {
    std::env::var("HOSTNAME")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!("Kordi on {value}"))
        .unwrap_or_else(|| "Kordi Desktop".to_string())
}

pub(super) fn default_owner_name() -> String {
    std::env::var("USER")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Kordi User".to_string())
}

pub(super) fn default_endpoint() -> String {
    "http://127.0.0.1:39221/kordi-desktop".to_string()
}

pub(super) fn generate_registry_node_id() -> String {
    let raw = Uuid::new_v4().simple().to_string();
    format!("kd_{}", &raw[..12])
}

pub(super) fn generate_host_id() -> String {
    format!("bridge_{}", Uuid::new_v4().simple())
}

pub(super) fn bridge_conversation_id(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
) -> String {
    match project_id.filter(|value| !value.trim().is_empty()) {
        Some(project_id) => format!("bridge:{host_id}:{peer_node_id}:{project_id}"),
        None => format!("bridge:{host_id}:{peer_node_id}"),
    }
}

pub(super) fn derive_node_id(public_key: &VerifyingKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(public_key.as_bytes());
    let hash = hasher.finalize();
    format!("kd_{}", bs58::encode(&hash[..20]).into_string())
}

pub(super) fn ed25519_to_x25519_public(ed_pub: &[u8; 32]) -> Result<[u8; 32], String> {
    let point = curve25519_dalek::edwards::CompressedEdwardsY(*ed_pub)
        .decompress()
        .ok_or_else(|| "invalid Ed25519 public key".to_string())?;
    Ok(point.to_montgomery().to_bytes())
}

pub(super) fn load_or_create_bridge_identity() -> Result<(SigningKey, VerifyingKey), String> {
    let path = desktop_bridge_identity_path()?;
    if let Some(existing) = load_json_file::<DesktopBridgeIdentity>(&path) {
        let _ = ensure_owner_only_permissions(&path);
        let secret = bs58::decode(existing.secret_key)
            .into_vec()
            .map_err(|err| err.to_string())?;
        let secret_bytes: [u8; 32] = secret.try_into().map_err(|bytes: Vec<u8>| {
            format!("Invalid bridge identity secret key length: {}", bytes.len())
        })?;
        let signing = SigningKey::from_bytes(&secret_bytes);
        let verifying = signing.verifying_key();
        return Ok((signing, verifying));
    }

    let signing = SigningKey::generate(&mut OsRng);
    let verifying = signing.verifying_key();
    let stored = DesktopBridgeIdentity {
        public_key: bs58::encode(verifying.as_bytes()).into_string(),
        secret_key: bs58::encode(signing.to_bytes()).into_string(),
    };
    write_owner_only_json_file(&path, &stored)?;
    Ok((signing, verifying))
}
