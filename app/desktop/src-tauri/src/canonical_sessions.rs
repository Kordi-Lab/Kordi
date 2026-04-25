use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const CANONICAL_SESSIONS_DB_FILENAME: &str = "canonical-sessions.sqlite3";
const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSessionState {
    pub storage_path: String,
    pub profile: CanonicalLocalProfile,
    pub identities: Vec<CanonicalIdentity>,
    pub sessions: Vec<CanonicalSession>,
    pub participants: Vec<CanonicalSessionParticipant>,
    pub messages: Vec<CanonicalSessionMessage>,
    pub delegated_exchanges: Vec<CanonicalDelegatedExchange>,
    pub presence: Vec<CanonicalPresence>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalLocalProfile {
    pub id: String,
    pub display_name: Option<String>,
    pub human_identity_id: Option<String>,
    pub active_agent_identity_id: Option<String>,
    pub storage_root: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalIdentity {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub owner_identity_id: Option<String>,
    pub source: String,
    pub source_host_id: Option<String>,
    pub bridge_node_id: Option<String>,
    pub human_id: Option<String>,
    pub agent_id: Option<String>,
    pub avatar_key: String,
    pub profile_image_url: Option<String>,
    pub metadata: Option<Value>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSession {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub created_by_identity_id: String,
    pub primary_identity_id: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub relationship_identity_id: Option<String>,
    pub metadata: Option<Value>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub last_message_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSessionParticipant {
    pub session_id: String,
    pub identity_id: String,
    pub role: String,
    pub state: String,
    pub added_by_identity_id: Option<String>,
    pub added_at_ms: i64,
    pub last_seen_at_ms: Option<i64>,
    pub last_read_message_id: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSessionMessage {
    pub id: String,
    pub session_id: String,
    pub sender_identity_id: String,
    pub sender_role: String,
    pub message_kind: String,
    pub content_text: String,
    pub content: Option<Value>,
    pub parent_message_id: Option<String>,
    pub delegated_exchange_id: Option<String>,
    pub status: String,
    pub sequence_num: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub content_hash: Option<String>,
    pub source_transport: Option<String>,
    pub source_event_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalDelegatedExchange {
    pub id: String,
    pub session_id: String,
    pub initiator_identity_id: String,
    pub target_identity_id: String,
    pub trigger_message_id: Option<String>,
    pub request_message_id: Option<String>,
    pub response_message_id: Option<String>,
    pub transport: String,
    pub bridge_host_id: Option<String>,
    pub bridge_conversation_id: Option<String>,
    pub bridge_request_id: Option<String>,
    pub context_policy: String,
    pub status: String,
    pub error: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalPresence {
    pub identity_id: String,
    pub status: String,
    pub session_id: Option<String>,
    pub detail: Option<String>,
    pub updated_at_ms: i64,
    pub expires_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertCanonicalIdentityRequest {
    pub id: Option<String>,
    pub kind: String,
    pub display_name: String,
    pub owner_identity_id: Option<String>,
    pub source: Option<String>,
    pub source_host_id: Option<String>,
    pub bridge_node_id: Option<String>,
    pub human_id: Option<String>,
    pub agent_id: Option<String>,
    pub avatar_key: Option<String>,
    pub profile_image_url: Option<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCanonicalSessionRequest {
    pub id: Option<String>,
    pub kind: String,
    pub title: Option<String>,
    pub status: Option<String>,
    pub created_by_identity_id: String,
    pub primary_identity_id: Option<String>,
    pub project_id: Option<String>,
    pub project_name: Option<String>,
    pub relationship_identity_id: Option<String>,
    pub participant_identity_ids: Vec<String>,
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendCanonicalMessageRequest {
    pub id: Option<String>,
    pub session_id: String,
    pub sender_identity_id: String,
    pub sender_role: String,
    pub message_kind: String,
    pub content_text: String,
    pub content: Option<Value>,
    pub parent_message_id: Option<String>,
    pub delegated_exchange_id: Option<String>,
    pub status: Option<String>,
    pub source_transport: Option<String>,
    pub source_event_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCanonicalDelegatedExchangeRequest {
    pub id: Option<String>,
    pub session_id: String,
    pub initiator_identity_id: String,
    pub target_identity_id: String,
    pub trigger_message_id: Option<String>,
    pub request_message_id: Option<String>,
    pub response_message_id: Option<String>,
    pub transport: Option<String>,
    pub bridge_host_id: Option<String>,
    pub bridge_conversation_id: Option<String>,
    pub bridge_request_id: Option<String>,
    pub context_policy: Option<String>,
    pub status: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCanonicalPresenceRequest {
    pub identity_id: String,
    pub status: String,
    pub session_id: Option<String>,
    pub detail: Option<String>,
    pub expires_at_ms: Option<i64>,
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn canonical_storage_root() -> PathBuf {
    kordi_core::config::preferred_global_settings_dir()
}

fn canonical_sessions_db_path() -> PathBuf {
    canonical_storage_root().join(CANONICAL_SESSIONS_DB_FILENAME)
}

fn hash_hex(value: &str, bytes: usize) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(&digest[..bytes.min(digest.len())])
}

fn stable_profile_id(storage_root: &Path) -> String {
    format!(
        "profile:{}",
        hash_hex(&storage_root.display().to_string(), 10)
    )
}

fn stable_session_id(request: &OpenCanonicalSessionRequest) -> String {
    let seed = [
        request.kind.trim(),
        request.created_by_identity_id.trim(),
        request
            .relationship_identity_id
            .as_deref()
            .unwrap_or_default()
            .trim(),
        request
            .primary_identity_id
            .as_deref()
            .unwrap_or_default()
            .trim(),
        request.project_id.as_deref().unwrap_or_default().trim(),
    ]
    .join("|");
    format!("session:{}", hash_hex(&seed, 16))
}

fn identity_display_name(conn: &Connection, identity_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT display_name FROM identities WHERE id = ?1",
        params![identity_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn receiver_identity_ids(request: &OpenCanonicalSessionRequest) -> Vec<String> {
    let mut receiver_ids = Vec::new();
    let mut push_receiver = |identity_id: Option<&String>| {
        let Some(identity_id) = identity_id.map(String::as_str).map(str::trim) else {
            return;
        };
        if identity_id.is_empty() || identity_id == request.created_by_identity_id.trim() {
            return;
        }
        if !receiver_ids.iter().any(|existing| existing == identity_id) {
            receiver_ids.push(identity_id.to_string());
        }
    };

    push_receiver(request.primary_identity_id.as_ref());
    push_receiver(request.relationship_identity_id.as_ref());
    for participant_id in &request.participant_identity_ids {
        push_receiver(Some(participant_id));
    }

    receiver_ids
}

fn default_session_title(
    conn: &Connection,
    request: &OpenCanonicalSessionRequest,
) -> Result<String, String> {
    if let Some(title) = request
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(title.to_string());
    }
    if let Some(project_name) = request
        .project_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Ok(project_name.to_string());
    }

    for identity_id in receiver_identity_ids(request) {
        if let Some(display_name) = identity_display_name(conn, &identity_id)?
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Ok(display_name);
        }
        return Ok(identity_id);
    }

    Ok("New session".to_string())
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn validate_identity_kind(kind: &str) -> Result<String, String> {
    let normalized = kind.trim().to_lowercase();
    if matches!(normalized.as_str(), "human" | "agent") {
        Ok(normalized)
    } else {
        Err("Identity kind must be human or agent".to_string())
    }
}

fn validate_session_kind(kind: &str) -> Result<String, String> {
    let normalized = kind.trim().to_lowercase();
    if matches!(
        normalized.as_str(),
        "self-agent" | "direct-person" | "direct-agent" | "relationship" | "group" | "project"
    ) {
        Ok(normalized)
    } else {
        Err("Unsupported canonical session kind".to_string())
    }
}

fn validate_status(value: Option<String>, fallback: &str) -> String {
    value
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn json_to_db(value: &Option<Value>) -> Result<Option<String>, String> {
    value
        .as_ref()
        .map(serde_json::to_string)
        .transpose()
        .map_err(|err| err.to_string())
}

fn json_from_db(value: Option<String>) -> Option<Value> {
    value.and_then(|raw| serde_json::from_str(&raw).ok())
}

fn canonical_identity_id(request: &UpsertCanonicalIdentityRequest, kind: &str) -> String {
    if let Some(id) = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
    {
        return id.to_string();
    }

    if kind == "human" {
        if let Some(human_id) = request
            .human_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return format!("human:{human_id}");
        }
        if let Some(node_id) = request
            .bridge_node_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return format!("human:bridge-node:{node_id}");
        }
        return format!("human:local:{}", hash_hex(&request.display_name, 8));
    }

    if let Some(agent_id) = request
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("agent:{agent_id}");
    }
    if let Some(node_id) = request
        .bridge_node_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return format!("agent:bridge-node:{node_id}");
    }
    format!("agent:local:{}", hash_hex(&request.display_name, 8))
}

fn canonical_avatar_key(request: &UpsertCanonicalIdentityRequest, kind: &str, id: &str) -> String {
    request
        .avatar_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            if kind == "human" {
                request
                    .human_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            } else {
                request
                    .agent_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
            }
        })
        .or_else(|| {
            request
                .bridge_node_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or(id)
        .to_string()
}

fn open_db() -> Result<Connection, String> {
    let path = canonical_sessions_db_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let conn = Connection::open(path).map_err(|err| err.to_string())?;
    initialize_schema(&conn)?;
    Ok(conn)
}

fn initialize_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS canonical_schema_meta (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS local_profile (
             id TEXT PRIMARY KEY,
             display_name TEXT,
             human_identity_id TEXT,
             active_agent_identity_id TEXT,
             storage_root TEXT NOT NULL,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS identities (
             id TEXT PRIMARY KEY,
             kind TEXT NOT NULL CHECK(kind IN ('human', 'agent')),
             display_name TEXT NOT NULL,
             owner_identity_id TEXT,
             source TEXT NOT NULL,
             source_host_id TEXT,
             bridge_node_id TEXT,
             human_id TEXT,
             agent_id TEXT,
             avatar_key TEXT NOT NULL,
             profile_image_url TEXT,
             metadata_json TEXT,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_identities_kind ON identities(kind);
         CREATE INDEX IF NOT EXISTS idx_identities_human_id ON identities(human_id);
         CREATE INDEX IF NOT EXISTS idx_identities_agent_id ON identities(agent_id);
         CREATE INDEX IF NOT EXISTS idx_identities_bridge_node ON identities(bridge_node_id);
         CREATE TABLE IF NOT EXISTS sessions (
             id TEXT PRIMARY KEY,
             kind TEXT NOT NULL,
             title TEXT NOT NULL,
             status TEXT NOT NULL DEFAULT 'active',
             created_by_identity_id TEXT NOT NULL,
             primary_identity_id TEXT,
             project_id TEXT,
             project_name TEXT,
             relationship_identity_id TEXT,
             metadata_json TEXT,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL,
             last_message_at_ms INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at_ms DESC);
         CREATE INDEX IF NOT EXISTS idx_sessions_primary_identity ON sessions(primary_identity_id);
         CREATE INDEX IF NOT EXISTS idx_sessions_relationship_identity ON sessions(relationship_identity_id);
         CREATE TABLE IF NOT EXISTS session_participants (
             session_id TEXT NOT NULL,
             identity_id TEXT NOT NULL,
             role TEXT NOT NULL,
             state TEXT NOT NULL DEFAULT 'active',
             added_by_identity_id TEXT,
             added_at_ms INTEGER NOT NULL,
             last_seen_at_ms INTEGER,
             last_read_message_id TEXT,
             metadata_json TEXT,
             PRIMARY KEY(session_id, identity_id)
         );
         CREATE INDEX IF NOT EXISTS idx_session_participants_identity ON session_participants(identity_id);
         CREATE TABLE IF NOT EXISTS session_messages (
             id TEXT PRIMARY KEY,
             session_id TEXT NOT NULL,
             sender_identity_id TEXT NOT NULL,
             sender_role TEXT NOT NULL,
             message_kind TEXT NOT NULL,
             content_text TEXT NOT NULL DEFAULT '',
             content_json TEXT,
             parent_message_id TEXT,
             delegated_exchange_id TEXT,
             status TEXT NOT NULL,
             sequence_num INTEGER NOT NULL,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL,
             content_hash TEXT,
             source_transport TEXT,
             source_event_id TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_session_messages_session_seq ON session_messages(session_id, sequence_num);
         CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_source_event
             ON session_messages(source_transport, source_event_id)
             WHERE source_transport IS NOT NULL AND source_event_id IS NOT NULL;
         CREATE TABLE IF NOT EXISTS delegated_exchanges (
             id TEXT PRIMARY KEY,
             session_id TEXT NOT NULL,
             initiator_identity_id TEXT NOT NULL,
             target_identity_id TEXT NOT NULL,
             trigger_message_id TEXT,
             request_message_id TEXT,
             response_message_id TEXT,
             transport TEXT NOT NULL,
             bridge_host_id TEXT,
             bridge_conversation_id TEXT,
             bridge_request_id TEXT,
             context_policy TEXT NOT NULL,
             status TEXT NOT NULL,
             error TEXT,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_delegated_exchanges_session ON delegated_exchanges(session_id);
         CREATE INDEX IF NOT EXISTS idx_delegated_exchanges_bridge_request ON delegated_exchanges(bridge_request_id);
         CREATE TABLE IF NOT EXISTS presence (
             identity_id TEXT PRIMARY KEY,
             status TEXT NOT NULL,
             session_id TEXT,
             detail TEXT,
             updated_at_ms INTEGER NOT NULL,
             expires_at_ms INTEGER
         );
         CREATE TABLE IF NOT EXISTS context_snapshots (
             id TEXT PRIMARY KEY,
             profile_id TEXT NOT NULL,
             session_id TEXT NOT NULL,
             agent_identity_id TEXT NOT NULL,
             provider TEXT NOT NULL,
             model TEXT NOT NULL,
             prompt_hash TEXT NOT NULL,
             project_context_hash TEXT,
             participant_hash TEXT NOT NULL,
             upto_message_id TEXT,
             message_range_hash TEXT NOT NULL,
             summary_text TEXT,
             summary_json TEXT,
             token_count INTEGER,
             created_at_ms INTEGER NOT NULL,
             invalidated_at_ms INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_context_snapshots_lookup
             ON context_snapshots(profile_id, session_id, agent_identity_id, provider, model, prompt_hash, participant_hash, message_range_hash);
         CREATE TABLE IF NOT EXISTS kv_cache_entries (
             key_hash TEXT PRIMARY KEY,
             profile_id TEXT NOT NULL,
             session_id TEXT,
             agent_identity_id TEXT,
             provider TEXT,
             model TEXT,
             value_json TEXT,
             value_blob_path TEXT,
             metadata_json TEXT,
             created_at_ms INTEGER NOT NULL,
             updated_at_ms INTEGER NOT NULL,
             expires_at_ms INTEGER
         );",
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "INSERT INTO canonical_schema_meta(key, value) VALUES('version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SCHEMA_VERSION.to_string()],
    )
    .map_err(|err| err.to_string())?;
    ensure_local_profile(conn)?;
    Ok(())
}

fn ensure_local_profile(conn: &Connection) -> Result<CanonicalLocalProfile, String> {
    let root = canonical_storage_root();
    let storage_root = root.display().to_string();
    let profile_id = stable_profile_id(&root);
    if let Some(profile) = select_local_profile(conn, &profile_id)? {
        return Ok(profile);
    }

    let now = now_ms();
    conn.execute(
        "INSERT INTO local_profile(id, display_name, human_identity_id, active_agent_identity_id, storage_root, created_at_ms, updated_at_ms)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![profile_id, "Local profile", Option::<String>::None, Option::<String>::None, storage_root, now, now],
    )
    .map_err(|err| err.to_string())?;
    select_local_profile(conn, &profile_id)?
        .ok_or_else(|| "Unable to create local profile".to_string())
}

fn select_local_profile(
    conn: &Connection,
    profile_id: &str,
) -> Result<Option<CanonicalLocalProfile>, String> {
    conn.query_row(
        "SELECT id, display_name, human_identity_id, active_agent_identity_id, storage_root, created_at_ms, updated_at_ms
         FROM local_profile WHERE id = ?1",
        params![profile_id],
        |row| {
            Ok(CanonicalLocalProfile {
                id: row.get(0)?,
                display_name: row.get(1)?,
                human_identity_id: row.get(2)?,
                active_agent_identity_id: row.get(3)?,
                storage_root: row.get(4)?,
                created_at_ms: row.get(5)?,
                updated_at_ms: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn upsert_identity_in_db(
    conn: &Connection,
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalIdentity, String> {
    let kind = validate_identity_kind(&request.kind)?;
    let display_name = request.display_name.trim();
    if display_name.is_empty() {
        return Err("Identity display name is required".to_string());
    }
    let id = canonical_identity_id(&request, &kind);
    let avatar_key = canonical_avatar_key(&request, &kind, &id);
    let source = request
        .source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("local")
        .to_string();
    let metadata = json_to_db(&request.metadata)?;
    let now = now_ms();

    conn.execute(
        "INSERT INTO identities(
             id, kind, display_name, owner_identity_id, source, source_host_id, bridge_node_id,
             human_id, agent_id, avatar_key, profile_image_url, metadata_json, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind,
             display_name = excluded.display_name,
             owner_identity_id = excluded.owner_identity_id,
             source = excluded.source,
             source_host_id = excluded.source_host_id,
             bridge_node_id = excluded.bridge_node_id,
             human_id = excluded.human_id,
             agent_id = excluded.agent_id,
             avatar_key = excluded.avatar_key,
             profile_image_url = excluded.profile_image_url,
             metadata_json = excluded.metadata_json,
             updated_at_ms = excluded.updated_at_ms",
        params![
            id,
            kind,
            display_name,
            clean_optional(request.owner_identity_id),
            source,
            clean_optional(request.source_host_id),
            clean_optional(request.bridge_node_id),
            clean_optional(request.human_id),
            clean_optional(request.agent_id),
            avatar_key,
            clean_optional(request.profile_image_url),
            metadata,
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;

    select_identity(conn, &id)?.ok_or_else(|| "Unable to save canonical identity".to_string())
}

fn select_identity(conn: &Connection, id: &str) -> Result<Option<CanonicalIdentity>, String> {
    conn.query_row(
        "SELECT id, kind, display_name, owner_identity_id, source, source_host_id, bridge_node_id,
                human_id, agent_id, avatar_key, profile_image_url, metadata_json, created_at_ms, updated_at_ms
         FROM identities WHERE id = ?1",
        params![id],
        |row| {
            Ok(CanonicalIdentity {
                id: row.get(0)?,
                kind: row.get(1)?,
                display_name: row.get(2)?,
                owner_identity_id: row.get(3)?,
                source: row.get(4)?,
                source_host_id: row.get(5)?,
                bridge_node_id: row.get(6)?,
                human_id: row.get(7)?,
                agent_id: row.get(8)?,
                avatar_key: row.get(9)?,
                profile_image_url: row.get(10)?,
                metadata: json_from_db(row.get(11)?),
                created_at_ms: row.get(12)?,
                updated_at_ms: row.get(13)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn open_or_create_session_in_db(
    conn: &Connection,
    request: OpenCanonicalSessionRequest,
) -> Result<CanonicalSession, String> {
    let kind = validate_session_kind(&request.kind)?;
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| stable_session_id(&request));
    let title = default_session_title(conn, &request)?;
    let status = validate_status(request.status, "active");
    let metadata = json_to_db(&request.metadata)?;
    let now = now_ms();

    conn.execute(
        "INSERT INTO sessions(
             id, kind, title, status, created_by_identity_id, primary_identity_id, project_id,
             project_name, relationship_identity_id, metadata_json, created_at_ms, updated_at_ms, last_message_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL)
         ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind,
             title = excluded.title,
             status = excluded.status,
             created_by_identity_id = excluded.created_by_identity_id,
             primary_identity_id = excluded.primary_identity_id,
             project_id = excluded.project_id,
             project_name = excluded.project_name,
             relationship_identity_id = excluded.relationship_identity_id,
             metadata_json = excluded.metadata_json,
             updated_at_ms = excluded.updated_at_ms",
        params![
            id,
            kind,
            title,
            status,
            request.created_by_identity_id,
            clean_optional(request.primary_identity_id),
            clean_optional(request.project_id),
            clean_optional(request.project_name),
            clean_optional(request.relationship_identity_id),
            metadata,
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;

    upsert_participant(
        conn,
        &id,
        &request.created_by_identity_id,
        "self",
        Some(&request.created_by_identity_id),
        now,
    )?;
    for participant in request.participant_identity_ids {
        let participant = participant.trim();
        if participant.is_empty() || participant == request.created_by_identity_id {
            continue;
        }
        upsert_participant(
            conn,
            &id,
            participant,
            "delegate",
            Some(&request.created_by_identity_id),
            now,
        )?;
    }

    select_session(conn, &id)?.ok_or_else(|| "Unable to save canonical session".to_string())
}

fn upsert_participant(
    conn: &Connection,
    session_id: &str,
    identity_id: &str,
    role: &str,
    added_by: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO session_participants(session_id, identity_id, role, state, added_by_identity_id, added_at_ms, metadata_json)
         VALUES(?1, ?2, ?3, 'active', ?4, ?5, NULL)
         ON CONFLICT(session_id, identity_id) DO UPDATE SET
             role = CASE WHEN session_participants.role = 'self' THEN session_participants.role ELSE excluded.role END,
             state = 'active'",
        params![session_id, identity_id, role, added_by, now],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

fn select_session(conn: &Connection, id: &str) -> Result<Option<CanonicalSession>, String> {
    conn.query_row(
        "SELECT id, kind, title, status, created_by_identity_id, primary_identity_id, project_id,
                project_name, relationship_identity_id, metadata_json, created_at_ms, updated_at_ms, last_message_at_ms
         FROM sessions WHERE id = ?1",
        params![id],
        |row| {
            Ok(CanonicalSession {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                status: row.get(3)?,
                created_by_identity_id: row.get(4)?,
                primary_identity_id: row.get(5)?,
                project_id: row.get(6)?,
                project_name: row.get(7)?,
                relationship_identity_id: row.get(8)?,
                metadata: json_from_db(row.get(9)?),
                created_at_ms: row.get(10)?,
                updated_at_ms: row.get(11)?,
                last_message_at_ms: row.get(12)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn append_message_in_db(
    conn: &Connection,
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionMessage, String> {
    if let (Some(source_transport), Some(source_event_id)) =
        (&request.source_transport, &request.source_event_id)
    {
        if let Some(existing) = select_message_by_source(conn, source_transport, source_event_id)? {
            return Ok(existing);
        }
    }

    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("msg:{}", Uuid::new_v4().simple()));
    let now = now_ms();
    let sequence_num: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(sequence_num), 0) + 1 FROM session_messages WHERE session_id = ?1",
            params![request.session_id],
            |row| row.get(0),
        )
        .map_err(|err| err.to_string())?;
    let content = json_to_db(&request.content)?;
    let content_hash = hash_hex(
        &format!(
            "{}|{}",
            request.content_text,
            content.clone().unwrap_or_default()
        ),
        16,
    );
    let status = validate_status(request.status, "sent");

    conn.execute(
        "INSERT INTO session_messages(
             id, session_id, sender_identity_id, sender_role, message_kind, content_text, content_json,
             parent_message_id, delegated_exchange_id, status, sequence_num, created_at_ms, updated_at_ms,
             content_hash, source_transport, source_event_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            id,
            request.session_id,
            request.sender_identity_id,
            request.sender_role,
            request.message_kind,
            request.content_text,
            content,
            clean_optional(request.parent_message_id),
            clean_optional(request.delegated_exchange_id),
            status,
            sequence_num,
            now,
            now,
            content_hash,
            clean_optional(request.source_transport),
            clean_optional(request.source_event_id),
        ],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "UPDATE sessions SET updated_at_ms = ?1, last_message_at_ms = ?1 WHERE id = ?2",
        params![now, request.session_id],
    )
    .map_err(|err| err.to_string())?;

    select_message(conn, &id)?.ok_or_else(|| "Unable to save canonical message".to_string())
}

fn select_message_by_source(
    conn: &Connection,
    source_transport: &str,
    source_event_id: &str,
) -> Result<Option<CanonicalSessionMessage>, String> {
    conn.query_row(
        "SELECT id FROM session_messages WHERE source_transport = ?1 AND source_event_id = ?2",
        params![source_transport, source_event_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(|err| err.to_string())?
    .map(|id| select_message(conn, &id))
    .transpose()
    .map(|value| value.flatten())
}

fn select_message(conn: &Connection, id: &str) -> Result<Option<CanonicalSessionMessage>, String> {
    conn.query_row(
        "SELECT id, session_id, sender_identity_id, sender_role, message_kind, content_text, content_json,
                parent_message_id, delegated_exchange_id, status, sequence_num, created_at_ms, updated_at_ms,
                content_hash, source_transport, source_event_id
         FROM session_messages WHERE id = ?1",
        params![id],
        |row| {
            Ok(CanonicalSessionMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                sender_identity_id: row.get(2)?,
                sender_role: row.get(3)?,
                message_kind: row.get(4)?,
                content_text: row.get(5)?,
                content: json_from_db(row.get(6)?),
                parent_message_id: row.get(7)?,
                delegated_exchange_id: row.get(8)?,
                status: row.get(9)?,
                sequence_num: row.get(10)?,
                created_at_ms: row.get(11)?,
                updated_at_ms: row.get(12)?,
                content_hash: row.get(13)?,
                source_transport: row.get(14)?,
                source_event_id: row.get(15)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn create_delegated_exchange_in_db(
    conn: &Connection,
    request: CreateCanonicalDelegatedExchangeRequest,
) -> Result<CanonicalDelegatedExchange, String> {
    let id = request
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("delegation:{}", Uuid::new_v4().simple()));
    let now = now_ms();
    conn.execute(
        "INSERT INTO delegated_exchanges(
             id, session_id, initiator_identity_id, target_identity_id, trigger_message_id, request_message_id,
             response_message_id, transport, bridge_host_id, bridge_conversation_id, bridge_request_id,
             context_policy, status, error, created_at_ms, updated_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             response_message_id = excluded.response_message_id,
             error = excluded.error,
             updated_at_ms = excluded.updated_at_ms",
        params![
            id,
            request.session_id,
            request.initiator_identity_id,
            request.target_identity_id,
            clean_optional(request.trigger_message_id),
            clean_optional(request.request_message_id),
            clean_optional(request.response_message_id),
            validate_status(request.transport, "bridge"),
            clean_optional(request.bridge_host_id),
            clean_optional(request.bridge_conversation_id),
            clean_optional(request.bridge_request_id),
            validate_status(request.context_policy, "recent-window"),
            validate_status(request.status, "pending"),
            clean_optional(request.error),
            now,
            now,
        ],
    )
    .map_err(|err| err.to_string())?;

    select_delegated_exchange(conn, &id)?
        .ok_or_else(|| "Unable to save delegated exchange".to_string())
}

fn select_delegated_exchange(
    conn: &Connection,
    id: &str,
) -> Result<Option<CanonicalDelegatedExchange>, String> {
    conn.query_row(
        "SELECT id, session_id, initiator_identity_id, target_identity_id, trigger_message_id,
                request_message_id, response_message_id, transport, bridge_host_id,
                bridge_conversation_id, bridge_request_id, context_policy, status, error,
                created_at_ms, updated_at_ms
         FROM delegated_exchanges WHERE id = ?1",
        params![id],
        |row| {
            Ok(CanonicalDelegatedExchange {
                id: row.get(0)?,
                session_id: row.get(1)?,
                initiator_identity_id: row.get(2)?,
                target_identity_id: row.get(3)?,
                trigger_message_id: row.get(4)?,
                request_message_id: row.get(5)?,
                response_message_id: row.get(6)?,
                transport: row.get(7)?,
                bridge_host_id: row.get(8)?,
                bridge_conversation_id: row.get(9)?,
                bridge_request_id: row.get(10)?,
                context_policy: row.get(11)?,
                status: row.get(12)?,
                error: row.get(13)?,
                created_at_ms: row.get(14)?,
                updated_at_ms: row.get(15)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn runtime_is_agent_like(runtime: &str) -> bool {
    let normalized = runtime.trim().to_lowercase();
    ["agent", "claude", "codex", "openclaw", "pi", "bot", "kordi"]
        .iter()
        .any(|token| normalized.contains(token))
}

fn update_local_profile_identities(
    conn: &Connection,
    human_identity_id: Option<&str>,
    active_agent_identity_id: Option<&str>,
) -> Result<(), String> {
    let profile = ensure_local_profile(conn)?;
    conn.execute(
        "UPDATE local_profile
         SET human_identity_id = COALESCE(?1, human_identity_id),
             active_agent_identity_id = COALESCE(?2, active_agent_identity_id),
             updated_at_ms = ?3
         WHERE id = ?4",
        params![
            human_identity_id,
            active_agent_identity_id,
            now_ms(),
            profile.id
        ],
    )
    .map_err(|err| err.to_string())?;
    Ok(())
}

pub(crate) fn sync_bridge_state_identities(
    state: &crate::bridge::DesktopBridgeState,
) -> Result<(), String> {
    let conn = open_db()?;

    for host in &state.hosts {
        let host_human = upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: None,
                kind: "human".to_string(),
                display_name: host.owner_name.clone(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some(host.id.clone()),
                bridge_node_id: host.node_id.clone(),
                human_id: Some(host.human_id.clone()),
                agent_id: None,
                avatar_key: Some(host.human_id.clone()),
                profile_image_url: None,
                metadata: None,
            },
        )?;

        let mut active_agent_identity_id = None;
        for agent in &host.agents {
            let agent_identity = upsert_identity_in_db(
                &conn,
                UpsertCanonicalIdentityRequest {
                    id: None,
                    kind: "agent".to_string(),
                    display_name: agent.label.clone(),
                    owner_identity_id: Some(host_human.id.clone()),
                    source: Some("bridge".to_string()),
                    source_host_id: Some(host.id.clone()),
                    bridge_node_id: agent.node_id.clone(),
                    human_id: Some(host.human_id.clone()),
                    agent_id: Some(agent.id.clone()),
                    avatar_key: Some(agent.id.clone()),
                    profile_image_url: None,
                    metadata: Some(serde_json::json!({
                        "runtime": agent.runtime,
                        "isDefault": agent.is_default,
                        "isActive": agent.is_active,
                        "registered": agent.registered,
                    })),
                },
            )?;
            if agent.is_active || host.active_agent_id.as_deref() == Some(agent.id.as_str()) {
                active_agent_identity_id = Some(agent_identity.id.clone());
            }
        }

        if state.active_host_id.as_deref() == Some(host.id.as_str()) {
            update_local_profile_identities(
                &conn,
                Some(host_human.id.as_str()),
                active_agent_identity_id.as_deref(),
            )?;
        }

        for peer in &host.visible_peers {
            let peer_human_identity_id =
                match (peer.human_id.as_deref(), peer.owner_name.as_deref()) {
                    (Some(human_id), Some(owner_name))
                        if !human_id.trim().is_empty() && !owner_name.trim().is_empty() =>
                    {
                        Some(
                            upsert_identity_in_db(
                                &conn,
                                UpsertCanonicalIdentityRequest {
                                    id: None,
                                    kind: "human".to_string(),
                                    display_name: owner_name.to_string(),
                                    owner_identity_id: None,
                                    source: Some("bridge".to_string()),
                                    source_host_id: Some(host.id.clone()),
                                    bridge_node_id: Some(peer.node_id.clone()),
                                    human_id: Some(human_id.to_string()),
                                    agent_id: None,
                                    avatar_key: Some(human_id.to_string()),
                                    profile_image_url: None,
                                    metadata: Some(serde_json::json!({
                                        "discoveryMode": peer.discovery_mode,
                                        "sharedProjects": peer.shared_projects,
                                    })),
                                },
                            )?
                            .id,
                        )
                    }
                    _ => None,
                };

            if peer.agent_id.is_some() || runtime_is_agent_like(&peer.runtime) {
                let display_name = peer
                    .display_name
                    .clone()
                    .or_else(|| peer.owner_name.clone())
                    .unwrap_or_else(|| peer.node_id.clone());
                upsert_identity_in_db(
                    &conn,
                    UpsertCanonicalIdentityRequest {
                        id: None,
                        kind: "agent".to_string(),
                        display_name,
                        owner_identity_id: peer_human_identity_id,
                        source: Some("bridge".to_string()),
                        source_host_id: Some(host.id.clone()),
                        bridge_node_id: Some(peer.node_id.clone()),
                        human_id: peer.human_id.clone(),
                        agent_id: peer.agent_id.clone(),
                        avatar_key: peer.agent_id.clone().or_else(|| Some(peer.node_id.clone())),
                        profile_image_url: None,
                        metadata: Some(serde_json::json!({
                            "runtime": peer.runtime,
                            "isDefaultAgent": peer.is_default_agent,
                            "discoveryMode": peer.discovery_mode,
                            "sharedProjects": peer.shared_projects,
                        })),
                    },
                )?;
            }
        }
    }

    Ok(())
}

fn update_presence_in_db(
    conn: &Connection,
    request: UpdateCanonicalPresenceRequest,
) -> Result<CanonicalPresence, String> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO presence(identity_id, status, session_id, detail, updated_at_ms, expires_at_ms)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(identity_id) DO UPDATE SET
             status = excluded.status,
             session_id = excluded.session_id,
             detail = excluded.detail,
             updated_at_ms = excluded.updated_at_ms,
             expires_at_ms = excluded.expires_at_ms",
        params![
            request.identity_id,
            validate_status(Some(request.status), "offline"),
            clean_optional(request.session_id),
            clean_optional(request.detail),
            now,
            request.expires_at_ms,
        ],
    )
    .map_err(|err| err.to_string())?;
    select_presence(conn, &request.identity_id)?
        .ok_or_else(|| "Unable to save presence".to_string())
}

fn select_presence(
    conn: &Connection,
    identity_id: &str,
) -> Result<Option<CanonicalPresence>, String> {
    conn.query_row(
        "SELECT identity_id, status, session_id, detail, updated_at_ms, expires_at_ms FROM presence WHERE identity_id = ?1",
        params![identity_id],
        |row| {
            Ok(CanonicalPresence {
                identity_id: row.get(0)?,
                status: row.get(1)?,
                session_id: row.get(2)?,
                detail: row.get(3)?,
                updated_at_ms: row.get(4)?,
                expires_at_ms: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|err| err.to_string())
}

fn query_all<T>(
    conn: &Connection,
    sql: &str,
    map: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    let mut stmt = conn.prepare(sql).map_err(|err| err.to_string())?;
    let rows = stmt.query_map([], map).map_err(|err| err.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn load_state_from_db(conn: &Connection) -> Result<CanonicalSessionState, String> {
    let path = canonical_sessions_db_path();
    let profile_id = stable_profile_id(&canonical_storage_root());
    let profile = select_local_profile(conn, &profile_id)?
        .ok_or_else(|| "Local profile missing".to_string())?;
    let identities = query_all(
        conn,
        "SELECT id FROM identities ORDER BY kind ASC, display_name ASC",
        |row| row.get::<_, String>(0),
    )?
    .into_iter()
    .filter_map(|id| select_identity(conn, &id).ok().flatten())
    .collect();
    let sessions = query_all(
        conn,
        "SELECT id FROM sessions ORDER BY updated_at_ms DESC, id ASC",
        |row| row.get::<_, String>(0),
    )?
    .into_iter()
    .filter_map(|id| select_session(conn, &id).ok().flatten())
    .collect();
    let participants = query_all(
        conn,
        "SELECT session_id, identity_id, role, state, added_by_identity_id, added_at_ms, last_seen_at_ms, last_read_message_id, metadata_json
         FROM session_participants ORDER BY session_id ASC, added_at_ms ASC, identity_id ASC",
        |row| {
            Ok(CanonicalSessionParticipant {
                session_id: row.get(0)?,
                identity_id: row.get(1)?,
                role: row.get(2)?,
                state: row.get(3)?,
                added_by_identity_id: row.get(4)?,
                added_at_ms: row.get(5)?,
                last_seen_at_ms: row.get(6)?,
                last_read_message_id: row.get(7)?,
                metadata: json_from_db(row.get(8)?),
            })
        },
    )?;
    let messages = query_all(
        conn,
        "SELECT id FROM session_messages ORDER BY session_id ASC, sequence_num ASC",
        |row| row.get::<_, String>(0),
    )?
    .into_iter()
    .filter_map(|id| select_message(conn, &id).ok().flatten())
    .collect();
    let delegated_exchanges = query_all(
        conn,
        "SELECT id FROM delegated_exchanges ORDER BY updated_at_ms DESC, id ASC",
        |row| row.get::<_, String>(0),
    )?
    .into_iter()
    .filter_map(|id| select_delegated_exchange(conn, &id).ok().flatten())
    .collect();
    let presence = query_all(
        conn,
        "SELECT identity_id, status, session_id, detail, updated_at_ms, expires_at_ms FROM presence ORDER BY updated_at_ms DESC",
        |row| {
            Ok(CanonicalPresence {
                identity_id: row.get(0)?,
                status: row.get(1)?,
                session_id: row.get(2)?,
                detail: row.get(3)?,
                updated_at_ms: row.get(4)?,
                expires_at_ms: row.get(5)?,
            })
        },
    )?;

    Ok(CanonicalSessionState {
        storage_path: path.display().to_string(),
        profile,
        identities,
        sessions,
        participants,
        messages,
        delegated_exchanges,
        presence,
    })
}

#[tauri::command]
pub fn desktop_canonical_session_state() -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    load_state_from_db(&conn)
}

#[tauri::command]
pub fn desktop_canonical_upsert_identity(
    request: UpsertCanonicalIdentityRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    upsert_identity_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

#[tauri::command]
pub fn desktop_canonical_open_or_create_session(
    request: OpenCanonicalSessionRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    open_or_create_session_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

#[tauri::command]
pub fn desktop_canonical_append_message(
    request: AppendCanonicalMessageRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    append_message_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

#[tauri::command]
pub fn desktop_canonical_create_delegated_exchange(
    request: CreateCanonicalDelegatedExchangeRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    create_delegated_exchange_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

#[tauri::command]
pub fn desktop_canonical_update_presence(
    request: UpdateCanonicalPresenceRequest,
) -> Result<CanonicalSessionState, String> {
    let conn = open_db()?;
    update_presence_in_db(&conn, request)?;
    load_state_from_db(&conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory db");
        initialize_schema(&conn).expect("initialize schema");
        conn
    }

    #[test]
    fn identity_uses_canonical_human_id_and_avatar_key() {
        let conn = test_conn();
        let identity = upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: None,
                kind: "human".to_string(),
                display_name: "Alice".to_string(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: Some("host-1".to_string()),
                bridge_node_id: Some("kd_alice".to_string()),
                human_id: Some("kh_alice".to_string()),
                agent_id: None,
                avatar_key: None,
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert identity");

        assert_eq!(identity.id, "human:kh_alice");
        assert_eq!(identity.avatar_key, "kh_alice");
    }

    #[test]
    fn open_session_is_deterministic_and_adds_participants() {
        let conn = test_conn();
        let request = OpenCanonicalSessionRequest {
            id: None,
            kind: "relationship".to_string(),
            title: Some("Alice".to_string()),
            status: None,
            created_by_identity_id: "human:local".to_string(),
            primary_identity_id: Some("human:kh_alice".to_string()),
            project_id: None,
            project_name: None,
            relationship_identity_id: Some("human:kh_alice".to_string()),
            participant_identity_ids: vec![
                "human:kh_alice".to_string(),
                "agent:ka_alice".to_string(),
            ],
            metadata: None,
        };
        let first = open_or_create_session_in_db(&conn, request.clone()).expect("open first");
        let second = open_or_create_session_in_db(&conn, request).expect("open second");
        assert_eq!(first.id, second.id);

        let state = load_state_from_db(&conn).expect("load state");
        assert_eq!(state.sessions.len(), 1);
        assert_eq!(state.participants.len(), 3);
    }

    #[test]
    fn default_session_title_uses_first_receiver_display_name() {
        let conn = test_conn();
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some("human:bob".to_string()),
                kind: "human".to_string(),
                display_name: "Bob".to_string(),
                owner_identity_id: None,
                source: Some("bridge".to_string()),
                source_host_id: None,
                bridge_node_id: None,
                human_id: None,
                agent_id: None,
                avatar_key: None,
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert Bob");
        upsert_identity_in_db(
            &conn,
            UpsertCanonicalIdentityRequest {
                id: Some("agent:bob-kordi".to_string()),
                kind: "agent".to_string(),
                display_name: "Bob's Kordi".to_string(),
                owner_identity_id: Some("human:bob".to_string()),
                source: Some("bridge".to_string()),
                source_host_id: None,
                bridge_node_id: None,
                human_id: None,
                agent_id: None,
                avatar_key: None,
                profile_image_url: None,
                metadata: None,
            },
        )
        .expect("upsert Bob's Kordi");

        let session = open_or_create_session_in_db(
            &conn,
            OpenCanonicalSessionRequest {
                id: None,
                kind: "relationship".to_string(),
                title: None,
                status: None,
                created_by_identity_id: "human:local".to_string(),
                primary_identity_id: Some("human:bob".to_string()),
                project_id: None,
                project_name: None,
                relationship_identity_id: Some("human:bob".to_string()),
                participant_identity_ids: vec![
                    "human:bob".to_string(),
                    "agent:bob-kordi".to_string(),
                ],
                metadata: None,
            },
        )
        .expect("open session");

        assert_eq!(session.title, "Bob");
        assert!(session.id.starts_with("session:"));
    }

    #[test]
    fn source_event_dedupes_messages() {
        let conn = test_conn();
        let session = open_or_create_session_in_db(
            &conn,
            OpenCanonicalSessionRequest {
                id: Some("session:test".to_string()),
                kind: "self-agent".to_string(),
                title: Some("Test".to_string()),
                status: None,
                created_by_identity_id: "human:local".to_string(),
                primary_identity_id: Some("agent:local".to_string()),
                project_id: None,
                project_name: None,
                relationship_identity_id: None,
                participant_identity_ids: vec!["agent:local".to_string()],
                metadata: None,
            },
        )
        .expect("open session");
        let request = AppendCanonicalMessageRequest {
            id: None,
            session_id: session.id,
            sender_identity_id: "human:local".to_string(),
            sender_role: "user".to_string(),
            message_kind: "text".to_string(),
            content_text: "hello".to_string(),
            content: None,
            parent_message_id: None,
            delegated_exchange_id: None,
            status: None,
            source_transport: Some("bridge".to_string()),
            source_event_id: Some("event-1".to_string()),
        };
        let first = append_message_in_db(&conn, request.clone()).expect("append first");
        let second = append_message_in_db(&conn, request).expect("append second");
        assert_eq!(first.id, second.id);

        let state = load_state_from_db(&conn).expect("load state");
        assert_eq!(state.messages.len(), 1);
    }
}
