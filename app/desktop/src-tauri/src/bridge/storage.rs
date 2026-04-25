use chrono::{Local, TimeZone};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::rngs::OsRng;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

use super::constants::{
    is_inbound_message_direction, BRIDGE_CONVERSATION_ID_PREFIX,
    BRIDGE_KEYCHAIN_AGENT_ACCOUNT_PREFIX, BRIDGE_KEYCHAIN_HOST_ACCOUNT_PREFIX,
    BRIDGE_KEYCHAIN_SERVICE_NAME, BRIDGE_MESSAGE_ID_PREFIX, BRIDGE_NODE_ID_PREFIX,
    DEFAULT_BRIDGE_RUNTIME, DESKTOP_BRIDGE_AGENT_IDENTITIES_DIR_NAME,
    DESKTOP_BRIDGE_CONFIG_FILE_NAME, DESKTOP_BRIDGE_CONVERSATIONS_FILE_NAME,
    DESKTOP_BRIDGE_IDENTITY_FILE_NAME, DESKTOP_BRIDGE_SECRETS_FILE_NAME, HOSTED_BRIDGE_DIR_NAME,
    KORDE_DIR_NAME, LEGACY_BRIDGE_CONFIG_FILE_NAME, LEGACY_DESKTOP_BRIDGE_CONVERSATIONS_FILE_NAME,
};
use super::{
    default_bridge_api_style, default_display_name, default_owner_name, ensure_host_bootstrap,
    stable_host_id, DesktopBridgeConversationMessageRecord, DesktopBridgeConversationRecord,
    DesktopBridgeConversationStore, DesktopBridgeHostConfig, DesktopBridgeStore,
    LegacyBridgeClientConfig,
};

#[cfg(test)]
use super::{default_bridge_agent_runtime, DesktopBridgeAgentConfig};

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

fn legacy_desktop_bridge_conversations_path() -> Result<PathBuf, String> {
    Ok(korde_dir()?.join(LEGACY_DESKTOP_BRIDGE_CONVERSATIONS_FILE_NAME))
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

const BRIDGE_CONVERSATION_SCHEMA_VERSION: i64 = 1;
const BRIDGE_CONVERSATION_JSON_MIGRATION_KEY: &str = "legacy_json_migrated";

fn sqlite_error(err: rusqlite::Error) -> String {
    err.to_string()
}

fn open_conversation_db() -> Result<Connection, String> {
    let path = desktop_bridge_conversations_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let conn = Connection::open(&path).map_err(sqlite_error)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(sqlite_error)?;
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;\n         PRAGMA journal_mode = WAL;\n         PRAGMA synchronous = NORMAL;",
    )
    .map_err(sqlite_error)?;
    init_conversation_schema(&conn)?;
    let _ = ensure_owner_only_permissions(&path);
    Ok(conn)
}

fn init_conversation_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS bridge_schema_meta (\n            key TEXT PRIMARY KEY,\n            value TEXT NOT NULL\n        );\n        CREATE TABLE IF NOT EXISTS bridge_conversations (\n            id TEXT PRIMARY KEY,\n            host_id TEXT NOT NULL,\n            peer_node_id TEXT NOT NULL,\n            peer_display_name TEXT,\n            peer_owner_name TEXT,\n            peer_runtime TEXT NOT NULL,\n            project_id TEXT,\n            project_name TEXT,\n            unread_count INTEGER NOT NULL DEFAULT 0,\n            updated_at_ms INTEGER NOT NULL,\n            peer_last_typing_at_ms INTEGER,\n            peer_last_heartbeat_at_ms INTEGER\n        );\n        CREATE TABLE IF NOT EXISTS bridge_messages (\n            id TEXT PRIMARY KEY,\n            conversation_id TEXT NOT NULL REFERENCES bridge_conversations(id) ON DELETE CASCADE,\n            direction TEXT NOT NULL,\n            sender TEXT,\n            text TEXT NOT NULL,\n            timestamp_ms INTEGER NOT NULL,\n            request_id TEXT,\n            delivery_state TEXT\n        );\n        CREATE INDEX IF NOT EXISTS idx_bridge_conversations_updated\n            ON bridge_conversations(updated_at_ms DESC);\n        CREATE INDEX IF NOT EXISTS idx_bridge_messages_conversation\n            ON bridge_messages(conversation_id, timestamp_ms ASC, id ASC);\n        CREATE INDEX IF NOT EXISTS idx_bridge_messages_request\n            ON bridge_messages(request_id) WHERE request_id IS NOT NULL;\n        CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_messages_stream_key\n            ON bridge_messages(conversation_id, direction, request_id)\n            WHERE request_id IS NOT NULL;",
    )
    .map_err(sqlite_error)?;
    conn.execute(
        "INSERT INTO bridge_schema_meta(key, value) VALUES ('schema_version', ?1)\n         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![BRIDGE_CONVERSATION_SCHEMA_VERSION.to_string()],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

fn conversation_json_migrated(conn: &Connection) -> Result<bool, String> {
    let migrated = conn
        .query_row(
            "SELECT value FROM bridge_schema_meta WHERE key = ?1",
            params![BRIDGE_CONVERSATION_JSON_MIGRATION_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sqlite_error)?
        .is_some_and(|value| value == "1");
    Ok(migrated)
}

fn mark_conversation_json_migrated(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "INSERT INTO bridge_schema_meta(key, value) VALUES (?1, '1')\n         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![BRIDGE_CONVERSATION_JSON_MIGRATION_KEY],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

fn migrate_legacy_conversation_json(conn: &mut Connection) -> Result<(), String> {
    if conversation_json_migrated(conn)? {
        return Ok(());
    }

    let legacy_path = legacy_desktop_bridge_conversations_path()?;
    let legacy_store = if legacy_path.exists() {
        let raw = std::fs::read_to_string(&legacy_path).map_err(|err| err.to_string())?;
        Some(
            serde_json::from_str::<DesktopBridgeConversationStore>(&raw)
                .map_err(|err| err.to_string())?,
        )
    } else {
        None
    };

    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    if let Some(store) = legacy_store {
        for conversation in &store.conversations {
            upsert_conversation_record(&tx, conversation)?;
        }
    }
    mark_conversation_json_migrated(&tx)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(())
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
    let older = if std::ptr::eq(newer, incoming) {
        existing
    } else {
        incoming
    };

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
        request_id: newer
            .request_id
            .clone()
            .or_else(|| older.request_id.clone()),
        delivery_state: if delivery_state_rank(newer.delivery_state.as_deref())
            >= delivery_state_rank(older.delivery_state.as_deref())
        {
            newer
                .delivery_state
                .clone()
                .or_else(|| older.delivery_state.clone())
        } else {
            older
                .delivery_state
                .clone()
                .or_else(|| newer.delivery_state.clone())
        },
    }
}

fn merge_conversation_records(
    existing: &DesktopBridgeConversationRecord,
    incoming: &DesktopBridgeConversationRecord,
) -> DesktopBridgeConversationRecord {
    let incoming_is_newer = incoming.updated_at_ms >= existing.updated_at_ms;
    let newer = if incoming_is_newer {
        incoming
    } else {
        existing
    };
    let older = if incoming_is_newer {
        existing
    } else {
        incoming
    };

    let mut messages_by_key =
        std::collections::BTreeMap::<String, DesktopBridgeConversationMessageRecord>::new();
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
        project_id: newer
            .project_id
            .clone()
            .or_else(|| older.project_id.clone()),
        project_name: newer
            .project_name
            .clone()
            .or_else(|| older.project_name.clone()),
        unread_count: if incoming_is_newer {
            incoming.unread_count
        } else {
            existing.unread_count
        },
        updated_at_ms: newer.updated_at_ms.max(older.updated_at_ms),
        peer_last_typing_at_ms: if incoming_is_newer {
            incoming.peer_last_typing_at_ms
        } else {
            existing.peer_last_typing_at_ms
        },
        peer_last_heartbeat_at_ms: newer
            .peer_last_heartbeat_at_ms
            .or(older.peer_last_heartbeat_at_ms),
        messages,
    }
}

fn load_conversation_messages(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Vec<DesktopBridgeConversationMessageRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, direction, sender, text, timestamp_ms, request_id, delivery_state\n             FROM bridge_messages\n             WHERE conversation_id = ?1\n             ORDER BY timestamp_ms ASC, id ASC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![conversation_id], |row| {
            Ok(DesktopBridgeConversationMessageRecord {
                id: row.get(0)?,
                direction: row.get(1)?,
                sender: row.get(2)?,
                text: row.get(3)?,
                timestamp_ms: row.get(4)?,
                request_id: row.get(5)?,
                delivery_state: row.get(6)?,
            })
        })
        .map_err(sqlite_error)?;

    let mut messages = Vec::new();
    for row in rows {
        messages.push(row.map_err(sqlite_error)?);
    }
    Ok(messages)
}

fn load_conversation_record(
    conn: &Connection,
    conversation_id: &str,
) -> Result<Option<DesktopBridgeConversationRecord>, String> {
    let record = conn
        .query_row(
            "SELECT id, host_id, peer_node_id, peer_display_name, peer_owner_name,\n                    peer_runtime, project_id, project_name, unread_count, updated_at_ms,\n                    peer_last_typing_at_ms, peer_last_heartbeat_at_ms\n             FROM bridge_conversations\n             WHERE id = ?1",
            params![conversation_id],
            |row| {
                let unread_count: i64 = row.get(8)?;
                Ok(DesktopBridgeConversationRecord {
                    id: row.get(0)?,
                    host_id: row.get(1)?,
                    peer_node_id: row.get(2)?,
                    peer_display_name: row.get(3)?,
                    peer_owner_name: row.get(4)?,
                    peer_runtime: row.get(5)?,
                    project_id: row.get(6)?,
                    project_name: row.get(7)?,
                    unread_count: unread_count.max(0) as usize,
                    updated_at_ms: row.get(9)?,
                    peer_last_typing_at_ms: row.get(10)?,
                    peer_last_heartbeat_at_ms: row.get(11)?,
                    messages: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(sqlite_error)?;

    match record {
        Some(mut record) => {
            record.messages = load_conversation_messages(conn, conversation_id)?;
            Ok(Some(record))
        }
        None => Ok(None),
    }
}

fn load_conversation_store_from_db(
    conn: &Connection,
) -> Result<DesktopBridgeConversationStore, String> {
    let mut statement = conn
        .prepare("SELECT id FROM bridge_conversations ORDER BY updated_at_ms DESC, id ASC")
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;

    let mut conversations = Vec::new();
    for row in rows {
        let id = row.map_err(sqlite_error)?;
        if let Some(record) = load_conversation_record(conn, &id)? {
            conversations.push(record);
        }
    }
    Ok(DesktopBridgeConversationStore { conversations })
}

fn store_conversation_record(
    conn: &Connection,
    record: &DesktopBridgeConversationRecord,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO bridge_conversations(\n             id, host_id, peer_node_id, peer_display_name, peer_owner_name, peer_runtime,\n             project_id, project_name, unread_count, updated_at_ms, peer_last_typing_at_ms,\n             peer_last_heartbeat_at_ms\n         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)\n         ON CONFLICT(id) DO UPDATE SET\n             host_id = excluded.host_id,\n             peer_node_id = excluded.peer_node_id,\n             peer_display_name = excluded.peer_display_name,\n             peer_owner_name = excluded.peer_owner_name,\n             peer_runtime = excluded.peer_runtime,\n             project_id = excluded.project_id,\n             project_name = excluded.project_name,\n             unread_count = excluded.unread_count,\n             updated_at_ms = excluded.updated_at_ms,\n             peer_last_typing_at_ms = excluded.peer_last_typing_at_ms,\n             peer_last_heartbeat_at_ms = excluded.peer_last_heartbeat_at_ms",
        params![
            record.id,
            record.host_id,
            record.peer_node_id,
            record.peer_display_name,
            record.peer_owner_name,
            record.peer_runtime,
            record.project_id,
            record.project_name,
            record.unread_count as i64,
            record.updated_at_ms,
            record.peer_last_typing_at_ms,
            record.peer_last_heartbeat_at_ms,
        ],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

fn find_existing_message_for_merge(
    conn: &Connection,
    conversation_id: &str,
    message: &DesktopBridgeConversationMessageRecord,
) -> Result<Option<DesktopBridgeConversationMessageRecord>, String> {
    let mut statement = if message.request_id.is_some() {
        conn.prepare(
            "SELECT id, direction, sender, text, timestamp_ms, request_id, delivery_state\n             FROM bridge_messages\n             WHERE conversation_id = ?1 AND direction = ?2 AND request_id = ?3\n             LIMIT 1",
        )
    } else {
        conn.prepare(
            "SELECT id, direction, sender, text, timestamp_ms, request_id, delivery_state\n             FROM bridge_messages\n             WHERE conversation_id = ?1 AND id = ?2\n             LIMIT 1",
        )
    }
    .map_err(sqlite_error)?;

    let mapper = |row: &rusqlite::Row<'_>| {
        Ok(DesktopBridgeConversationMessageRecord {
            id: row.get(0)?,
            direction: row.get(1)?,
            sender: row.get(2)?,
            text: row.get(3)?,
            timestamp_ms: row.get(4)?,
            request_id: row.get(5)?,
            delivery_state: row.get(6)?,
        })
    };

    if let Some(request_id) = message.request_id.as_deref() {
        statement
            .query_row(
                params![conversation_id, message.direction, request_id],
                mapper,
            )
            .optional()
            .map_err(sqlite_error)
    } else {
        statement
            .query_row(params![conversation_id, message.id], mapper)
            .optional()
            .map_err(sqlite_error)
    }
}

fn store_message_record(
    conn: &Connection,
    conversation_id: &str,
    message: &DesktopBridgeConversationMessageRecord,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO bridge_messages(\n             id, conversation_id, direction, sender, text, timestamp_ms, request_id, delivery_state\n         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)\n         ON CONFLICT(id) DO UPDATE SET\n             conversation_id = excluded.conversation_id,\n             direction = excluded.direction,\n             sender = excluded.sender,\n             text = excluded.text,\n             timestamp_ms = excluded.timestamp_ms,\n             request_id = excluded.request_id,\n             delivery_state = excluded.delivery_state",
        params![
            message.id,
            conversation_id,
            message.direction,
            message.sender,
            message.text,
            message.timestamp_ms,
            message.request_id,
            message.delivery_state,
        ],
    )
    .map_err(sqlite_error)?;
    Ok(())
}

fn upsert_message_record(
    conn: &Connection,
    conversation_id: &str,
    message: &DesktopBridgeConversationMessageRecord,
) -> Result<(), String> {
    let merged =
        if let Some(existing) = find_existing_message_for_merge(conn, conversation_id, message)? {
            let mut merged = merge_conversation_message_records(&existing, message);
            merged.id = existing.id;
            merged
        } else {
            message.clone()
        };
    store_message_record(conn, conversation_id, &merged)
}

fn upsert_conversation_record(
    conn: &Connection,
    incoming: &DesktopBridgeConversationRecord,
) -> Result<(), String> {
    let merged = load_conversation_record(conn, &incoming.id)?
        .map(|existing| merge_conversation_records(&existing, incoming))
        .unwrap_or_else(|| incoming.clone());
    store_conversation_record(conn, &merged)?;
    for message in &merged.messages {
        upsert_message_record(conn, &merged.id, message)?;
    }
    Ok(())
}

fn is_person_runtime(runtime: &str) -> bool {
    runtime.trim().eq_ignore_ascii_case("person")
}

fn scoped_conversation_id(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
    peer_runtime: &str,
) -> String {
    let base = bridge_conversation_id(host_id, peer_node_id, project_id);
    if is_person_runtime(peer_runtime) {
        format!("{base}:person")
    } else {
        base
    }
}

fn conversation_matches_runtime(existing_runtime: &str, peer_runtime: &str) -> bool {
    is_person_runtime(existing_runtime) == is_person_runtime(peer_runtime)
}

fn find_conversation_for_peer(
    conn: &Connection,
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<&str>,
    peer_runtime: &str,
) -> Result<Option<DesktopBridgeConversationRecord>, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, peer_runtime FROM bridge_conversations\n             WHERE host_id = ?1\n               AND peer_node_id = ?2\n               AND ((project_id IS NULL AND ?3 IS NULL) OR project_id = ?3)\n             ORDER BY updated_at_ms DESC, id ASC",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![host_id, peer_node_id, project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?;

    for row in rows {
        let (id, existing_runtime) = row.map_err(sqlite_error)?;
        if conversation_matches_runtime(&existing_runtime, peer_runtime) {
            return load_conversation_record(conn, &id);
        }
    }

    Ok(None)
}

fn apply_conversation_metadata(
    conversation: &mut DesktopBridgeConversationRecord,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    project_id: Option<String>,
    project_name: Option<String>,
) {
    if peer_display_name.is_some() {
        conversation.peer_display_name = peer_display_name;
    }
    if peer_owner_name.is_some() {
        conversation.peer_owner_name = peer_owner_name;
    }
    if !peer_runtime.trim().is_empty() {
        conversation.peer_runtime = peer_runtime;
    }
    if project_id.is_some() {
        conversation.project_id = project_id;
    }
    if project_name.is_some() {
        conversation.project_name = project_name;
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn append_conversation_message_to_storage(
    host_id: &str,
    peer_node_id: &str,
    peer_display_name: Option<String>,
    peer_owner_name: Option<String>,
    peer_runtime: String,
    project_id: Option<String>,
    project_name: Option<String>,
    direction: &str,
    sender: Option<String>,
    text: String,
    request_id: Option<String>,
    delivery_state: Option<String>,
    increment_unread: bool,
) -> Result<DesktopBridgeConversationStore, String> {
    let timestamp_ms = now_ms();
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;

    let mut conversation = find_conversation_for_peer(
        &tx,
        host_id,
        peer_node_id,
        project_id.as_deref(),
        &peer_runtime,
    )?
    .unwrap_or_else(|| DesktopBridgeConversationRecord {
        id: scoped_conversation_id(host_id, peer_node_id, project_id.as_deref(), &peer_runtime),
        host_id: host_id.to_string(),
        peer_node_id: peer_node_id.to_string(),
        peer_display_name: peer_display_name.clone(),
        peer_owner_name: peer_owner_name.clone(),
        peer_runtime: peer_runtime.clone(),
        project_id: project_id.clone(),
        project_name: project_name.clone(),
        unread_count: 0,
        updated_at_ms: timestamp_ms,
        peer_last_typing_at_ms: None,
        peer_last_heartbeat_at_ms: None,
        messages: Vec::new(),
    });

    apply_conversation_metadata(
        &mut conversation,
        peer_display_name,
        peer_owner_name,
        peer_runtime,
        project_id,
        project_name,
    );
    conversation.updated_at_ms = timestamp_ms;
    if is_inbound_message_direction(direction) {
        conversation.peer_last_typing_at_ms = None;
    }

    let existing_message = request_id.as_deref().and_then(|existing_request_id| {
        conversation.messages.iter().position(|message| {
            message.request_id.as_deref() == Some(existing_request_id)
                && message.direction == direction
        })
    });

    if let Some(index) = existing_message {
        let message = &mut conversation.messages[index];
        let should_apply_update = delivery_state
            .as_deref()
            .map(|next| {
                delivery_state_rank(Some(next))
                    >= delivery_state_rank(message.delivery_state.as_deref())
            })
            .unwrap_or(true);
        if should_apply_update {
            message.sender = sender.or_else(|| message.sender.clone());
            message.text = text;
            message.timestamp_ms = timestamp_ms;
            if delivery_state.is_some() {
                message.delivery_state = delivery_state;
            }
        }
    } else {
        if increment_unread {
            conversation.unread_count += 1;
        }
        conversation
            .messages
            .push(DesktopBridgeConversationMessageRecord {
                id: format!("{}{}", BRIDGE_MESSAGE_ID_PREFIX, Uuid::new_v4().simple()),
                direction: direction.to_string(),
                sender,
                text,
                timestamp_ms,
                request_id,
                delivery_state,
            });
    }

    upsert_conversation_record(&tx, &conversation)?;
    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(&conn)
}

pub(super) fn update_message_delivery_state_in_storage(
    request_id: &str,
    delivery_state: &str,
) -> Result<DesktopBridgeConversationStore, String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let now = now_ms();

    let mut statement = tx
        .prepare(
            "SELECT id, conversation_id, delivery_state FROM bridge_messages\n             WHERE request_id = ?1",
        )
        .map_err(sqlite_error)?;
    let rows = statement
        .query_map(params![request_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(sqlite_error)?;

    let mut updates = Vec::new();
    for row in rows {
        let (message_id, conversation_id, current_state) = row.map_err(sqlite_error)?;
        if delivery_state_rank(Some(delivery_state))
            >= delivery_state_rank(current_state.as_deref())
        {
            updates.push((message_id, conversation_id));
        }
    }
    drop(statement);

    for (message_id, conversation_id) in updates {
        tx.execute(
            "UPDATE bridge_messages SET delivery_state = ?1 WHERE id = ?2",
            params![delivery_state, message_id],
        )
        .map_err(sqlite_error)?;
        let peer_last_typing_at_ms = match delivery_state {
            "processing" => Some(now),
            "responded" | "processing_failed" => None,
            _ => load_conversation_record(&tx, &conversation_id)?
                .and_then(|conversation| conversation.peer_last_typing_at_ms),
        };
        tx.execute(
            "UPDATE bridge_conversations\n             SET updated_at_ms = ?1, peer_last_typing_at_ms = ?2\n             WHERE id = ?3",
            params![now, peer_last_typing_at_ms, conversation_id],
        )
        .map_err(sqlite_error)?;
    }

    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(&conn)
}

fn update_peer_presence_metadata_in_storage(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<String>,
    project_name: Option<String>,
    typing_at_ms: Option<Option<i64>>,
    heartbeat_at_ms: Option<i64>,
) -> Result<DesktopBridgeConversationStore, String> {
    let timestamp_ms = now_ms();
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let mut conversation = find_conversation_for_peer(
        &tx,
        host_id,
        peer_node_id,
        project_id.as_deref(),
        DEFAULT_BRIDGE_RUNTIME,
    )?
    .unwrap_or_else(|| DesktopBridgeConversationRecord {
        id: scoped_conversation_id(
            host_id,
            peer_node_id,
            project_id.as_deref(),
            DEFAULT_BRIDGE_RUNTIME,
        ),
        host_id: host_id.to_string(),
        peer_node_id: peer_node_id.to_string(),
        peer_display_name: None,
        peer_owner_name: None,
        peer_runtime: DEFAULT_BRIDGE_RUNTIME.to_string(),
        project_id: project_id.clone(),
        project_name: project_name.clone(),
        unread_count: 0,
        updated_at_ms: timestamp_ms,
        peer_last_typing_at_ms: None,
        peer_last_heartbeat_at_ms: None,
        messages: Vec::new(),
    });
    if project_id.is_some() {
        conversation.project_id = project_id;
    }
    if project_name.is_some() {
        conversation.project_name = project_name;
    }
    if let Some(typing_at_ms) = typing_at_ms {
        conversation.peer_last_typing_at_ms = typing_at_ms;
    }
    if let Some(heartbeat_at_ms) = heartbeat_at_ms {
        conversation.peer_last_heartbeat_at_ms = Some(heartbeat_at_ms);
    }
    conversation.updated_at_ms = timestamp_ms;
    store_conversation_record(&tx, &conversation)?;
    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(&conn)
}

pub(super) fn note_peer_typing_in_storage(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<DesktopBridgeConversationStore, String> {
    update_peer_presence_metadata_in_storage(
        host_id,
        peer_node_id,
        project_id,
        project_name,
        Some(Some(now_ms())),
        None,
    )
}

pub(super) fn note_peer_heartbeat_in_storage(
    host_id: &str,
    peer_node_id: &str,
    project_id: Option<String>,
    project_name: Option<String>,
) -> Result<DesktopBridgeConversationStore, String> {
    update_peer_presence_metadata_in_storage(
        host_id,
        peer_node_id,
        project_id,
        project_name,
        None,
        Some(now_ms()),
    )
}

pub(super) fn mark_bridge_conversation_read_in_storage(
    conversation_id: &str,
) -> Result<DesktopBridgeConversationStore, String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    tx.execute(
        "UPDATE bridge_conversations SET unread_count = 0, updated_at_ms = ?1 WHERE id = ?2",
        params![now_ms(), conversation_id],
    )
    .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)?;
    load_conversation_store_from_db(&conn)
}

pub(super) fn load_conversation_store() -> DesktopBridgeConversationStore {
    let mut conn = match open_conversation_db() {
        Ok(conn) => conn,
        Err(error) => {
            eprintln!("Unable to open desktop bridge conversation SQLite store: {error}");
            return DesktopBridgeConversationStore::default();
        }
    };
    if let Err(error) = migrate_legacy_conversation_json(&mut conn) {
        eprintln!("Unable to migrate desktop bridge conversation JSON store: {error}");
    }
    load_conversation_store_from_db(&conn).unwrap_or_else(|error| {
        eprintln!("Unable to load desktop bridge conversations from SQLite: {error}");
        DesktopBridgeConversationStore::default()
    })
}

pub(super) fn save_conversation_store(
    store: &DesktopBridgeConversationStore,
) -> Result<(), String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    for conversation in &store.conversations {
        upsert_conversation_record(&tx, conversation)?;
    }
    tx.commit().map_err(sqlite_error)?;
    Ok(())
}

pub(super) fn delete_conversations_for_host(host_id: &str) -> Result<(), String> {
    let mut conn = open_conversation_db()?;
    migrate_legacy_conversation_json(&mut conn)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    tx.execute(
        "DELETE FROM bridge_conversations WHERE host_id = ?1",
        params![host_id],
    )
    .map_err(sqlite_error)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(())
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

    fn memory_conversation_db() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory bridge conversation db");
        init_conversation_schema(&conn).expect("init bridge conversation schema");
        conn
    }

    fn test_conversation(
        messages: Vec<DesktopBridgeConversationMessageRecord>,
    ) -> DesktopBridgeConversationRecord {
        DesktopBridgeConversationRecord {
            id: "bridge:host-1:peer-1".to_string(),
            host_id: "host-1".to_string(),
            peer_node_id: "peer-1".to_string(),
            peer_display_name: Some("Peer".to_string()),
            peer_owner_name: Some("Owner".to_string()),
            peer_runtime: "person".to_string(),
            project_id: None,
            project_name: None,
            unread_count: 0,
            updated_at_ms: 1_000,
            peer_last_typing_at_ms: None,
            peer_last_heartbeat_at_ms: None,
            messages,
        }
    }

    fn test_message(
        id: &str,
        direction: &str,
        text: &str,
        timestamp_ms: i64,
        request_id: Option<&str>,
        delivery_state: Option<&str>,
    ) -> DesktopBridgeConversationMessageRecord {
        DesktopBridgeConversationMessageRecord {
            id: id.to_string(),
            direction: direction.to_string(),
            sender: Some("sender".to_string()),
            text: text.to_string(),
            timestamp_ms,
            request_id: request_id.map(ToString::to_string),
            delivery_state: delivery_state.map(ToString::to_string),
        }
    }

    #[test]
    fn targeted_append_keeps_person_and_agent_threads_separate_for_same_node() {
        let conn = memory_conversation_db();
        let mut person = test_conversation(vec![test_message(
            "msg-person",
            "inbound",
            "human hello",
            1_000,
            Some("req-person"),
            None,
        )]);
        person.id = "bridge:host-1:peer-1:person".to_string();
        upsert_conversation_record(&conn, &person).expect("insert person conversation");

        append_conversation_message_to_db_for_test(
            &conn,
            "host-1",
            "peer-1",
            "kordi-desktop".to_string(),
            "agent hello".to_string(),
        )
        .expect("append agent conversation");

        let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
        assert_eq!(loaded.conversations.len(), 2);
        assert!(loaded.conversations.iter().any(|conversation| {
            conversation.id.ends_with(":person")
                && conversation
                    .messages
                    .iter()
                    .any(|message| message.text == "human hello")
        }));
        assert!(loaded.conversations.iter().any(|conversation| {
            !conversation.id.ends_with(":person")
                && conversation.peer_runtime == "kordi-desktop"
                && conversation
                    .messages
                    .iter()
                    .any(|message| message.text == "agent hello")
        }));
    }

    fn append_conversation_message_to_db_for_test(
        conn: &Connection,
        host_id: &str,
        peer_node_id: &str,
        peer_runtime: String,
        text: String,
    ) -> Result<(), String> {
        let timestamp_ms = now_ms();
        let mut conversation =
            find_conversation_for_peer(conn, host_id, peer_node_id, None, &peer_runtime)?
                .unwrap_or_else(|| DesktopBridgeConversationRecord {
                    id: scoped_conversation_id(host_id, peer_node_id, None, &peer_runtime),
                    host_id: host_id.to_string(),
                    peer_node_id: peer_node_id.to_string(),
                    peer_display_name: None,
                    peer_owner_name: None,
                    peer_runtime,
                    project_id: None,
                    project_name: None,
                    unread_count: 0,
                    updated_at_ms: timestamp_ms,
                    peer_last_typing_at_ms: None,
                    peer_last_heartbeat_at_ms: None,
                    messages: Vec::new(),
                });
        conversation
            .messages
            .push(DesktopBridgeConversationMessageRecord {
                id: "msg-agent".to_string(),
                direction: "inbound-response".to_string(),
                sender: Some("agent".to_string()),
                text,
                timestamp_ms,
                request_id: Some("req-agent".to_string()),
                delivery_state: Some("responded".to_string()),
            });
        upsert_conversation_record(conn, &conversation)
    }

    #[test]
    fn sqlite_upsert_preserves_messages_from_independent_writes() {
        let conn = memory_conversation_db();
        let first = test_conversation(vec![test_message(
            "msg-1",
            "outbound",
            "hello",
            1_000,
            Some("req-1"),
            Some("sent"),
        )]);
        let mut second = test_conversation(vec![test_message(
            "msg-2",
            "inbound-response",
            "hi back",
            1_100,
            Some("req-2"),
            Some("responded"),
        )]);
        second.updated_at_ms = 1_100;

        upsert_conversation_record(&conn, &first).expect("insert first write");
        upsert_conversation_record(&conn, &second).expect("merge second write");

        let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
        let messages = &loaded.conversations[0].messages;
        assert_eq!(messages.len(), 2);
        assert!(messages.iter().any(|message| message.text == "hello"));
        assert!(messages.iter().any(|message| message.text == "hi back"));
    }

    #[test]
    fn sqlite_upsert_merges_streamed_response_by_request_and_direction() {
        let conn = memory_conversation_db();
        let partial = test_conversation(vec![test_message(
            "msg-partial",
            "outbound-response",
            "Hel",
            1_000,
            Some("req-stream"),
            Some("processing"),
        )]);
        let mut final_response = test_conversation(vec![test_message(
            "msg-final",
            "outbound-response",
            "Hello world",
            1_200,
            Some("req-stream"),
            Some("responded"),
        )]);
        final_response.updated_at_ms = 1_200;

        upsert_conversation_record(&conn, &partial).expect("insert partial response");
        upsert_conversation_record(&conn, &final_response).expect("upsert final response");

        let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
        let messages = &loaded.conversations[0].messages;
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].text, "Hello world");
        assert_eq!(messages[0].delivery_state.as_deref(), Some("responded"));
    }

    #[test]
    fn sqlite_upsert_keeps_delivery_state_monotonic() {
        let conn = memory_conversation_db();
        let responded = test_conversation(vec![test_message(
            "msg-1",
            "outbound",
            "hello",
            1_000,
            Some("req-1"),
            Some("responded"),
        )]);
        let mut later_read = test_conversation(vec![test_message(
            "msg-later",
            "outbound",
            "hello",
            1_100,
            Some("req-1"),
            Some("read"),
        )]);
        later_read.updated_at_ms = 1_100;

        upsert_conversation_record(&conn, &responded).expect("insert responded message");
        upsert_conversation_record(&conn, &later_read).expect("merge lower-ranked read state");

        let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
        let message = &loaded.conversations[0].messages[0];
        assert_eq!(message.delivery_state.as_deref(), Some("responded"));
    }

    #[test]
    fn sqlite_upsert_allows_newer_final_response_to_clear_typing() {
        let conn = memory_conversation_db();
        let mut processing = test_conversation(vec![test_message(
            "msg-1",
            "inbound-response",
            "Working",
            1_000,
            Some("req-1"),
            Some("processing"),
        )]);
        processing.peer_last_typing_at_ms = Some(1_000);
        let mut responded = test_conversation(vec![test_message(
            "msg-final",
            "inbound-response",
            "Done",
            1_200,
            Some("req-1"),
            Some("responded"),
        )]);
        responded.updated_at_ms = 1_200;
        responded.peer_last_typing_at_ms = None;

        upsert_conversation_record(&conn, &processing).expect("insert processing state");
        upsert_conversation_record(&conn, &responded).expect("merge final state");

        let loaded = load_conversation_store_from_db(&conn).expect("load conversations");
        let conversation = &loaded.conversations[0];
        assert_eq!(conversation.peer_last_typing_at_ms, None);
        assert_eq!(
            conversation.messages[0].delivery_state.as_deref(),
            Some("responded")
        );
    }

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
