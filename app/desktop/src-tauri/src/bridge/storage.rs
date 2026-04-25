use chrono::{Local, TimeZone};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::constants::{
    BRIDGE_CONVERSATION_ID_PREFIX, BRIDGE_KEYCHAIN_AGENT_ACCOUNT_PREFIX,
    BRIDGE_KEYCHAIN_HOST_ACCOUNT_PREFIX, BRIDGE_KEYCHAIN_SERVICE_NAME, BRIDGE_NODE_ID_PREFIX,
    DESKTOP_BRIDGE_AGENT_IDENTITIES_DIR_NAME, DESKTOP_BRIDGE_CONFIG_FILE_NAME,
    DESKTOP_BRIDGE_CONVERSATIONS_FILE_NAME, DESKTOP_BRIDGE_IDENTITY_FILE_NAME,
    DESKTOP_BRIDGE_SECRETS_FILE_NAME, HOSTED_BRIDGE_DIR_NAME, KORDE_DIR_NAME,
    LEGACY_BRIDGE_CONFIG_FILE_NAME,
};
use super::{
    DesktopBridgeConversationMessageRecord, DesktopBridgeConversationRecord,
    DesktopBridgeConversationStore, DesktopBridgeHostConfig, DesktopBridgeStore,
    LegacyBridgeClientConfig, default_bridge_api_style, default_display_name, default_owner_name,
    ensure_host_bootstrap, stable_host_id,
};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DesktopBridgeSecretsStore {
    #[serde(rename = "hostApiKeys", default)]
    host_api_keys: std::collections::HashMap<String, String>,
    #[serde(rename = "agentApiKeys", default)]
    agent_api_keys: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBridgeStoreExport {
    active_host_id: Option<String>,
    hosts: Vec<DesktopBridgeHostConfig>,
    credentials_redacted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DesktopBridgeIdentity {
    public_key: String,
    secret_key: String,
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

fn bridge_instance_id() -> Option<String> {
    std::env::var("APP_INSTANCE_ID")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::env::var_os("APP_DATA_DIR").map(|value| {
                let mut hasher = Sha256::new();
                hasher.update(value.to_string_lossy().as_bytes());
                hasher.finalize()[..8]
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            })
        })
}

fn bridge_keychain_service_name() -> String {
    bridge_instance_id()
        .map(|instance_id| format!("{BRIDGE_KEYCHAIN_SERVICE_NAME}.{instance_id}"))
        .unwrap_or_else(|| BRIDGE_KEYCHAIN_SERVICE_NAME.to_string())
}

pub(super) fn korde_dir() -> Result<PathBuf, String> {
    if let Some(data_dir) = std::env::var_os("APP_DATA_DIR") {
        return Ok(PathBuf::from(data_dir).join(KORDE_DIR_NAME.trim_start_matches('.')));
    }

    let home =
        std::env::var("HOME").map_err(|_| "Unable to determine home directory".to_string())?;
    Ok(PathBuf::from(home).join(KORDE_DIR_NAME))
}

pub(super) fn desktop_bridge_config_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join(DESKTOP_BRIDGE_CONFIG_FILE_NAME))
}

pub(super) fn desktop_bridge_conversations_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join(DESKTOP_BRIDGE_CONVERSATIONS_FILE_NAME))
}

pub(super) fn desktop_bridge_secrets_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join(DESKTOP_BRIDGE_SECRETS_FILE_NAME))
}

pub(super) fn legacy_bridge_config_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join(LEGACY_BRIDGE_CONFIG_FILE_NAME))
}

pub(super) fn desktop_bridge_identity_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join(DESKTOP_BRIDGE_IDENTITY_FILE_NAME))
}

pub(super) fn desktop_bridge_agent_identity_path(agent_id: &str) -> Result<PathBuf, String> {
    Ok(korde_dir()?
        .join(DESKTOP_BRIDGE_AGENT_IDENTITIES_DIR_NAME)
        .join(format!("{agent_id}.json")))
}

pub(super) fn hosted_bridge_dir() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join(HOSTED_BRIDGE_DIR_NAME))
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

pub(super) fn load_desktop_bridge_store() -> Option<DesktopBridgeStore> {
    let path = desktop_bridge_config_path().ok()?;
    let store = load_json_file(&path);
    let _ = ensure_owner_only_permissions(&path);
    store
}

fn load_legacy_desktop_bridge_secrets_store() -> DesktopBridgeSecretsStore {
    let Some(path) = desktop_bridge_secrets_path().ok() else {
        return DesktopBridgeSecretsStore::default();
    };
    let store = load_json_file(&path).unwrap_or_default();
    let _ = ensure_owner_only_permissions(&path);
    store
}

#[cfg(target_os = "macos")]
fn keychain_account(prefix: &str, id: &str) -> String {
    bridge_instance_id()
        .map(|instance_id| format!("{instance_id}:{prefix}{id}"))
        .unwrap_or_else(|| format!("{prefix}{id}"))
}

#[cfg(target_os = "macos")]
fn command_output_error(prefix: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("exit status {}", output.status)
    };
    format!("{prefix}: {detail}")
}

#[cfg(target_os = "macos")]
fn macos_keychain_set_secret(account: &str, secret: &str) -> Result<(), String> {
    let service_name = bridge_keychain_service_name();
    let output = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            account,
            "-s",
            &service_name,
            "-w",
            secret,
        ])
        .output()
        .map_err(|err| format!("Unable to store bridge secret in macOS Keychain: {err}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(command_output_error(
            "Unable to store bridge secret in macOS Keychain",
            &output,
        ))
    }
}

#[cfg(target_os = "macos")]
fn macos_keychain_get_secret(account: &str) -> Result<Option<String>, String> {
    let service_name = bridge_keychain_service_name();
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            account,
            "-s",
            &service_name,
            "-w",
        ])
        .output()
        .map_err(|err| format!("Unable to read bridge secret from macOS Keychain: {err}"))?;
    if output.status.success() {
        return Ok(Some(
            String::from_utf8_lossy(&output.stdout)
                .trim_end_matches(['\r', '\n'])
                .to_string(),
        ));
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not be found")
        || stderr.contains("The specified item could not be found")
    {
        Ok(None)
    } else {
        Err(command_output_error(
            "Unable to read bridge secret from macOS Keychain",
            &output,
        ))
    }
}

#[cfg(target_os = "macos")]
fn macos_keychain_delete_secret(account: &str) -> Result<(), String> {
    let service_name = bridge_keychain_service_name();
    let output = std::process::Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            account,
            "-s",
            &service_name,
        ])
        .output()
        .map_err(|err| format!("Unable to delete bridge secret from macOS Keychain: {err}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not be found")
        || stderr.contains("The specified item could not be found")
    {
        Ok(())
    } else {
        Err(command_output_error(
            "Unable to delete bridge secret from macOS Keychain",
            &output,
        ))
    }
}

fn load_desktop_bridge_secrets_store(
    store: &DesktopBridgeStore,
) -> Result<DesktopBridgeSecretsStore, String> {
    let mut secrets = load_legacy_desktop_bridge_secrets_store();

    #[cfg(target_os = "macos")]
    {
        for host in &store.hosts {
            if let Some(api_key) = macos_keychain_get_secret(&keychain_account(
                BRIDGE_KEYCHAIN_HOST_ACCOUNT_PREFIX,
                &host.id,
            ))? {
                secrets.host_api_keys.insert(host.id.clone(), api_key);
            }
            for agent in &host.agents {
                if let Some(api_key) = macos_keychain_get_secret(&keychain_account(
                    BRIDGE_KEYCHAIN_AGENT_ACCOUNT_PREFIX,
                    &agent.id,
                ))? {
                    secrets.agent_api_keys.insert(agent.id.clone(), api_key);
                }
            }
        }
    }

    Ok(secrets)
}

fn collect_bridge_secrets(store: &DesktopBridgeStore) -> DesktopBridgeSecretsStore {
    let mut secrets = DesktopBridgeSecretsStore::default();

    for host in &store.hosts {
        if !host.api_key.trim().is_empty() {
            secrets
                .host_api_keys
                .insert(host.id.clone(), host.api_key.clone());
        }
        for agent in &host.agents {
            if !agent.api_key.trim().is_empty() {
                secrets
                    .agent_api_keys
                    .insert(agent.id.clone(), agent.api_key.clone());
            }
        }
    }

    secrets
}

fn hydrate_bridge_store_secrets(
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

        for agent in &mut host.agents {
            if agent.api_key.trim().is_empty() {
                if let Some(api_key) = secrets.agent_api_keys.get(&agent.id) {
                    agent.api_key = api_key.clone();
                }
            } else {
                needs_migration = true;
            }
        }
    }

    needs_migration
}

fn save_bridge_secrets_store(store: &DesktopBridgeSecretsStore) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        for (host_id, api_key) in &store.host_api_keys {
            macos_keychain_set_secret(
                &keychain_account(BRIDGE_KEYCHAIN_HOST_ACCOUNT_PREFIX, host_id),
                api_key,
            )?;
        }
        for (agent_id, api_key) in &store.agent_api_keys {
            macos_keychain_set_secret(
                &keychain_account(BRIDGE_KEYCHAIN_AGENT_ACCOUNT_PREFIX, agent_id),
                api_key,
            )?;
        }

        if let Ok(path) = desktop_bridge_secrets_path() {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let path = desktop_bridge_secrets_path()?;
        write_owner_only_json_file(&path, store)
    }
}

pub(super) fn delete_bridge_host_secrets(host: &DesktopBridgeHostConfig) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos_keychain_delete_secret(&keychain_account(
            BRIDGE_KEYCHAIN_HOST_ACCOUNT_PREFIX,
            &host.id,
        ))?;
        for agent in &host.agents {
            macos_keychain_delete_secret(&keychain_account(
                BRIDGE_KEYCHAIN_AGENT_ACCOUNT_PREFIX,
                &agent.id,
            ))?;
        }
    }

    Ok(())
}

#[cfg(test)]
fn bridge_store_export(store: &DesktopBridgeStore) -> serde_json::Value {
    serde_json::to_value(DesktopBridgeStoreExport {
        active_host_id: store.active_host_id.clone(),
        hosts: store.hosts.clone(),
        credentials_redacted: true,
    })
    .expect("bridge store export should serialize")
}

pub(super) fn write_bridge_store_export(
    path: &Path,
    store: &DesktopBridgeStore,
) -> Result<(), String> {
    write_owner_only_json_file(
        path,
        &DesktopBridgeStoreExport {
            active_host_id: store.active_host_id.clone(),
            hosts: store.hosts.clone(),
            credentials_redacted: true,
        },
    )
}

pub(super) fn imported_legacy_host(legacy: LegacyBridgeClientConfig) -> DesktopBridgeHostConfig {
    let legacy_host_seed = if !legacy.node_id.trim().is_empty() {
        legacy.node_id.clone()
    } else if !legacy.coordination.trim().is_empty() {
        legacy.coordination.clone()
    } else {
        legacy.api_key.clone()
    };

    DesktopBridgeHostConfig {
        id: stable_host_id(&legacy_host_seed),
        coordination: legacy.coordination,
        node_id: legacy.node_id,
        api_key: legacy.api_key,
        display_name: legacy.display_name,
        owner: legacy.owner,
        human_id: None,
        discovery_mode: super::default_discovery_mode(),
        active_agent_id: None,
        agents: Vec::new(),
        api_style: default_bridge_api_style(),
    }
}

pub(super) fn parse_imported_bridge_store(raw: &str) -> Result<DesktopBridgeStore, String> {
    if let Ok(store) = serde_json::from_str::<DesktopBridgeStore>(raw) {
        return Ok(store);
    }
    if let Ok(host) = serde_json::from_str::<DesktopBridgeHostConfig>(raw) {
        return Ok(DesktopBridgeStore {
            active_host_id: Some(host.id.clone()),
            hosts: vec![host],
        });
    }
    if let Ok(hosts) = serde_json::from_str::<Vec<DesktopBridgeHostConfig>>(raw) {
        let active_host_id = hosts.first().map(|host| host.id.clone());
        return Ok(DesktopBridgeStore {
            active_host_id,
            hosts,
        });
    }
    if let Ok(legacy) = serde_json::from_str::<LegacyBridgeClientConfig>(raw) {
        let host = imported_legacy_host(legacy);
        return Ok(DesktopBridgeStore {
            active_host_id: Some(host.id.clone()),
            hosts: vec![host],
        });
    }
    Err("Invalid bridge host config file. Expected Kordi bridge JSON.".to_string())
}

pub(super) fn normalize_imported_bridge_host(
    host: DesktopBridgeHostConfig,
) -> DesktopBridgeHostConfig {
    let display_name = host
        .display_name
        .clone()
        .unwrap_or_else(default_display_name);
    let owner_name = host.owner.clone().unwrap_or_else(default_owner_name);
    ensure_host_bootstrap(Some(&host), &display_name, &owner_name)
}

pub(super) fn bridge_hosts_match(
    existing: &DesktopBridgeHostConfig,
    imported: &DesktopBridgeHostConfig,
) -> bool {
    existing.id == imported.id
        || (!existing.coordination.trim().is_empty()
            && existing.coordination == imported.coordination)
        || (!existing.node_id.trim().is_empty() && existing.node_id == imported.node_id)
}

fn is_local_http_host(parsed: &reqwest::Url) -> bool {
    matches!(
        parsed.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

pub(super) fn normalize_server_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Bridge server URL cannot be empty".to_string());
    }
    let parsed =
        reqwest::Url::parse(trimmed).map_err(|err| format!("Invalid bridge server URL: {err}"))?;
    match parsed.scheme() {
        "https" => Ok(trimmed.to_string()),
        "http" if is_local_http_host(&parsed) => Ok(trimmed.to_string()),
        "http" => Err("Use https:// for remote bridge hosts. Plain http:// is only allowed for localhost during local development.".to_string()),
        _ => Err("Bridge server URL must use http or https".to_string()),
    }
}

pub(super) fn load_bridge_store() -> DesktopBridgeStore {
    if let Some(mut store) = load_desktop_bridge_store() {
        let needs_secret_migration = load_desktop_bridge_secrets_store(&store)
            .map(|secrets| hydrate_bridge_store_secrets(&mut store, &secrets))
            .unwrap_or(false);
        if needs_secret_migration {
            let _ = save_bridge_store(&store);
        }
        store.hosts = store
            .hosts
            .into_iter()
            .map(|host| {
                let display_name = host
                    .display_name
                    .clone()
                    .unwrap_or_else(default_display_name);
                let owner_name = host.owner.clone().unwrap_or_else(default_owner_name);
                ensure_host_bootstrap(Some(&host), &display_name, &owner_name)
            })
            .collect();
        return store;
    }

    if let Some(legacy) = load_legacy_bridge_config() {
        let host = imported_legacy_host(legacy);
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

fn delivery_state_rank(value: Option<&str>) -> i32 {
    match value.unwrap_or_default().trim().to_lowercase().as_str() {
        "sending" | "pending_send" => 0,
        "sent" => 1,
        "delivered" => 2,
        "processing" | "handed_off_direct" | "handed_off_mailbox" => 3,
        "read" => 4,
        "responded" | "processing_failed" => 5,
        _ => 0,
    }
}

fn merge_conversation_message_records(
    existing: &DesktopBridgeConversationMessageRecord,
    incoming: &DesktopBridgeConversationMessageRecord,
) -> DesktopBridgeConversationMessageRecord {
    let newer = if incoming.timestamp_ms >= existing.timestamp_ms {
        incoming
    } else {
        existing
    };
    let older = if std::ptr::eq(newer, incoming) { existing } else { incoming };

    DesktopBridgeConversationMessageRecord {
        id: newer.id.clone(),
        direction: newer.direction.clone(),
        sender: newer.sender.clone().or_else(|| older.sender.clone()),
        text: if newer.text.trim().is_empty() {
            older.text.clone()
        } else {
            newer.text.clone()
        },
        timestamp_ms: newer.timestamp_ms.max(older.timestamp_ms),
        request_id: newer.request_id.clone().or_else(|| older.request_id.clone()),
        delivery_state: if delivery_state_rank(newer.delivery_state.as_deref())
            >= delivery_state_rank(older.delivery_state.as_deref())
        {
            newer.delivery_state.clone().or_else(|| older.delivery_state.clone())
        } else {
            older.delivery_state.clone().or_else(|| newer.delivery_state.clone())
        },
    }
}

fn merge_conversation_records(
    existing: &DesktopBridgeConversationRecord,
    incoming: &DesktopBridgeConversationRecord,
) -> DesktopBridgeConversationRecord {
    let newer = if incoming.updated_at_ms >= existing.updated_at_ms {
        incoming
    } else {
        existing
    };
    let older = if std::ptr::eq(newer, incoming) { existing } else { incoming };

    let mut messages_by_key = std::collections::BTreeMap::<String, DesktopBridgeConversationMessageRecord>::new();
    for message in existing.messages.iter().chain(incoming.messages.iter()) {
        let key = message
            .request_id
            .as_ref()
            .map(|request_id| format!("{}:{request_id}", message.direction))
            .unwrap_or_else(|| format!("id:{}", message.id));
        messages_by_key
            .entry(key)
            .and_modify(|current| {
                *current = merge_conversation_message_records(current, message);
            })
            .or_insert_with(|| message.clone());
    }
    let mut messages: Vec<_> = messages_by_key.into_values().collect();
    messages.sort_by(|a, b| {
        a.timestamp_ms
            .cmp(&b.timestamp_ms)
            .then_with(|| a.id.cmp(&b.id))
    });

    DesktopBridgeConversationRecord {
        id: newer.id.clone(),
        host_id: newer.host_id.clone(),
        peer_node_id: newer.peer_node_id.clone(),
        peer_display_name: newer
            .peer_display_name
            .clone()
            .or_else(|| older.peer_display_name.clone()),
        peer_owner_name: newer
            .peer_owner_name
            .clone()
            .or_else(|| older.peer_owner_name.clone()),
        peer_runtime: if newer.peer_runtime.trim().is_empty() {
            older.peer_runtime.clone()
        } else {
            newer.peer_runtime.clone()
        },
        project_id: newer.project_id.clone().or_else(|| older.project_id.clone()),
        project_name: newer
            .project_name
            .clone()
            .or_else(|| older.project_name.clone()),
        unread_count: newer.unread_count,
        updated_at_ms: newer.updated_at_ms.max(older.updated_at_ms),
        peer_last_typing_at_ms: newer
            .peer_last_typing_at_ms
            .or(older.peer_last_typing_at_ms),
        peer_last_heartbeat_at_ms: newer
            .peer_last_heartbeat_at_ms
            .or(older.peer_last_heartbeat_at_ms),
        messages,
    }
}

fn merge_conversation_stores(
    existing: DesktopBridgeConversationStore,
    incoming: &DesktopBridgeConversationStore,
) -> DesktopBridgeConversationStore {
    let mut records_by_id = std::collections::BTreeMap::<String, DesktopBridgeConversationRecord>::new();

    for record in existing.conversations {
        records_by_id.insert(record.id.clone(), record);
    }

    for record in &incoming.conversations {
        records_by_id
            .entry(record.id.clone())
            .and_modify(|current| {
                *current = merge_conversation_records(current, record);
            })
            .or_insert_with(|| record.clone());
    }

    let mut conversations: Vec<_> = records_by_id.into_values().collect();
    conversations.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    DesktopBridgeConversationStore { conversations }
}

pub(super) fn save_conversation_store(
    store: &DesktopBridgeConversationStore,
) -> Result<(), String> {
    let path = desktop_bridge_conversations_path()?;
    let merged = load_json_file::<DesktopBridgeConversationStore>(&path)
        .map(|existing| merge_conversation_stores(existing, store))
        .unwrap_or_else(|| store.clone());
    write_owner_only_json_file(&path, &merged)
}

pub(super) fn bridge_conversation_id(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
) -> String {
    match project_id.filter(|value| !value.trim().is_empty()) {
        Some(project_id) => {
            format!("{BRIDGE_CONVERSATION_ID_PREFIX}{host_id}:{peer_node_id}:{project_id}")
        }
        None => format!("{BRIDGE_CONVERSATION_ID_PREFIX}{host_id}:{peer_node_id}"),
    }
}

pub(super) fn derive_node_id(public_key: &VerifyingKey) -> String {
    let mut hasher = Sha256::new();
    hasher.update(public_key.as_bytes());
    let hash = hasher.finalize();
    format!(
        "{}{}",
        BRIDGE_NODE_ID_PREFIX,
        bs58::encode(&hash[..20]).into_string()
    )
}

pub(super) fn ed25519_to_x25519_public(ed_pub: &[u8; 32]) -> Result<[u8; 32], String> {
    let point = curve25519_dalek::edwards::CompressedEdwardsY(*ed_pub)
        .decompress()
        .ok_or_else(|| "invalid Ed25519 public key".to_string())?;
    Ok(point.to_montgomery().to_bytes())
}

fn decode_bridge_identity(
    existing: DesktopBridgeIdentity,
) -> Result<(SigningKey, VerifyingKey), String> {
    let secret = bs58::decode(existing.secret_key)
        .into_vec()
        .map_err(|err| err.to_string())?;
    let secret_bytes: [u8; 32] = secret.try_into().map_err(|bytes: Vec<u8>| {
        format!("Invalid bridge identity secret key length: {}", bytes.len())
    })?;
    let signing = SigningKey::from_bytes(&secret_bytes);
    let verifying = signing.verifying_key();
    Ok((signing, verifying))
}

fn write_bridge_identity(
    path: &Path,
    signing: &SigningKey,
    verifying: &VerifyingKey,
) -> Result<(), String> {
    let stored = DesktopBridgeIdentity {
        public_key: bs58::encode(verifying.as_bytes()).into_string(),
        secret_key: bs58::encode(signing.to_bytes()).into_string(),
    };
    write_owner_only_json_file(path, &stored)
}

pub(super) fn load_or_create_bridge_identity_for_agent(
    agent_id: &str,
) -> Result<(SigningKey, VerifyingKey), String> {
    let path = desktop_bridge_agent_identity_path(agent_id)?;
    if let Some(existing) = load_json_file::<DesktopBridgeIdentity>(&path) {
        let _ = ensure_owner_only_permissions(&path);
        return decode_bridge_identity(existing);
    }

    let legacy_identity_path = desktop_bridge_identity_path()?;
    if let Some(existing) = load_json_file::<DesktopBridgeIdentity>(&legacy_identity_path) {
        let _ = ensure_owner_only_permissions(&legacy_identity_path);
        let decoded = decode_bridge_identity(existing)?;
        write_bridge_identity(&path, &decoded.0, &decoded.1)?;
        return Ok(decoded);
    }

    let signing = SigningKey::generate(&mut OsRng);
    let verifying = signing.verifying_key();
    write_bridge_identity(&path, &signing, &verifying)?;
    Ok((signing, verifying))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_store_export_redacts_api_keys() {
        let store = DesktopBridgeStore {
            active_host_id: Some("host-1".to_string()),
            hosts: vec![DesktopBridgeHostConfig {
                id: "host-1".to_string(),
                coordination: "https://bridge.example.com".to_string(),
                node_id: "node-1".to_string(),
                api_key: "secret-host-key".to_string(),
                display_name: Some("Kordi".to_string()),
                owner: Some("User".to_string()),
                human_id: Some("kh_123".to_string()),
                discovery_mode: "contacts".to_string(),
                active_agent_id: Some("agent-1".to_string()),
                agents: vec![super::DesktopBridgeAgentConfig {
                    id: "agent-1".to_string(),
                    label: "Kordi".to_string(),
                    node_id: "node-1".to_string(),
                    api_key: "secret-agent-key".to_string(),
                    runtime: super::default_bridge_agent_runtime(),
                    is_default: true,
                }],
                api_style: "serve".to_string(),
            }],
        };

        let exported = bridge_store_export(&store);
        let host = exported["hosts"]
            .as_array()
            .and_then(|hosts| hosts.first())
            .expect("host entry");
        let agent = host["agents"]
            .as_array()
            .and_then(|agents| agents.first())
            .expect("agent entry");

        assert_eq!(exported["credentialsRedacted"], serde_json::json!(true));
        assert!(host.get("apiKey").is_none());
        assert!(agent.get("apiKey").is_none());
    }

    #[test]
    fn hydrate_bridge_store_secrets_restores_redacted_config() {
        let mut store = DesktopBridgeStore {
            active_host_id: Some("host-1".to_string()),
            hosts: vec![DesktopBridgeHostConfig {
                id: "host-1".to_string(),
                coordination: "https://bridge.example.com".to_string(),
                node_id: "node-1".to_string(),
                api_key: String::new(),
                display_name: Some("Kordi".to_string()),
                owner: Some("User".to_string()),
                human_id: Some("kh_123".to_string()),
                discovery_mode: "contacts".to_string(),
                active_agent_id: Some("agent-1".to_string()),
                agents: vec![super::DesktopBridgeAgentConfig {
                    id: "agent-1".to_string(),
                    label: "Kordi".to_string(),
                    node_id: "node-1".to_string(),
                    api_key: String::new(),
                    runtime: super::default_bridge_agent_runtime(),
                    is_default: true,
                }],
                api_style: "serve".to_string(),
            }],
        };
        let secrets = DesktopBridgeSecretsStore {
            host_api_keys: std::collections::HashMap::from([(
                "host-1".to_string(),
                "secret-host-key".to_string(),
            )]),
            agent_api_keys: std::collections::HashMap::from([(
                "agent-1".to_string(),
                "secret-agent-key".to_string(),
            )]),
        };

        assert!(!hydrate_bridge_store_secrets(&mut store, &secrets));
        assert_eq!(store.hosts[0].api_key, "secret-host-key");
        assert_eq!(store.hosts[0].agents[0].api_key, "secret-agent-key");
    }
}
