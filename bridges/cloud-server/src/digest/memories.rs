//! Memories a digest run saves from recent conversations (#2053).
//!
//! The model lists at most three durable facts in its reply. After the
//! digest itself is stored, each one is checked against the run's frozen
//! sources and saved through [`crate::memory_store::save`] as the owner, as
//! an agent-inferred memory with the source `digest`. A memory that fails a
//! check is skipped and audited; it never fails the digest.

use super::models::Source;
use crate::memory_store::{self, SaveMemoryRequest, SaveOutcome, GLOBAL_SCOPE_ID};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;
use std::collections::HashSet;

/// The most memories one digest run may save.
pub const MAX_MEMORIES: usize = 3;
const MAX_TEXT_CHARS: usize = 500;
const MAX_SOURCE_IDS: usize = 20;
/// How many existing memories the input lists, and how much of each.
const MAX_EXISTING: usize = 40;
const EXISTING_TEXT_CHARS: usize = 200;
const SOURCE: &str = "digest";
/// The keys a memory in a model reply may carry.
const FIELDS: &[&str] = &[
    "text",
    "category",
    "confidence",
    "scope",
    "sessionId",
    "sourceMessageIds",
];

/// One memory the model proposes.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestMemory {
    pub text: String,
    pub category: String,
    pub confidence: String,
    /// `conversation`, `group` or `global`.
    pub scope: String,
    /// The source messages' session; omitted for global memories.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub source_message_ids: Vec<String>,
}

/// One of the owner's saved memories, as the digest input lists it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingMemory {
    pub text: String,
    pub scope: String,
    pub scope_id: String,
    pub category: String,
}

/// Reads `memories` leniently: a malformed entry is dropped instead of
/// failing the whole digest reply.
pub(super) fn lenient<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<DigestMemory>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| serde_json::from_value(entry.clone()).ok())
        .collect())
}

/// Reduces a reply's `memories` value to the schema: an array of objects
/// with only the known keys.
pub(super) fn reduce(memories: &mut Value) {
    if !memories.is_array() {
        *memories = json!([]);
    }
    if let Some(entries) = memories.as_array_mut() {
        entries.retain(Value::is_object);
        for entry in entries {
            if let Some(fields) = entry.as_object_mut() {
                fields.retain(|key, _| FIELDS.contains(&key.as_str()));
            }
        }
    }
}

/// The owner's current memories for the digest input, newest first. Empty
/// when memory is off; a failed read is logged and leaves the list empty.
pub(super) async fn existing(pool: &PgPool, account: &str) -> Vec<ExistingMemory> {
    let list = match memory_store::list(pool, account).await {
        Ok(list) => list,
        Err(error) => {
            eprintln!("[digest] Could not list memories: {}", error.code);
            return Vec::new();
        }
    };
    if !list.settings.memory_enabled {
        return Vec::new();
    }
    list.memories
        .into_iter()
        .take(MAX_EXISTING)
        .map(|memory| ExistingMemory {
            text: memory.text.chars().take(EXISTING_TEXT_CHARS).collect(),
            scope: memory.scope,
            scope_id: memory.scope_id,
            category: memory.category,
        })
        .collect()
}

/// Where a checked memory is saved.
#[derive(Debug, PartialEq)]
struct Target {
    scope: &'static str,
    scope_id: String,
    scope_label: Option<String>,
}

/// The checks that need no database: fields, sources and scope.
fn target(
    memory: &DigestMemory,
    account: &str,
    sources: &[Source],
) -> Result<Target, &'static str> {
    let text = memory.text.trim();
    if text.is_empty() || text.chars().count() > MAX_TEXT_CHARS {
        return Err("invalid_text");
    }
    let category = memory_store::check_category(Some(&memory.category), false)
        .map_err(|_| "invalid_category")?;
    if category == "health_context" {
        return Err("category_not_allowed");
    }
    if !memory_store::MEMORY_CONFIDENCES.contains(&memory.confidence.trim()) {
        return Err("invalid_confidence");
    }
    let scope = match memory.scope.trim() {
        "conversation" => "conversation",
        "group" => "group",
        "global" => "global",
        _ => return Err("invalid_scope"),
    };
    let session = memory
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if scope != "global" && session.is_none() {
        return Err("missing_session");
    }
    if memory.source_message_ids.is_empty() || memory.source_message_ids.len() > MAX_SOURCE_IDS {
        return Err("invalid_sources");
    }
    let mut cited = Vec::new();
    for id in &memory.source_message_ids {
        let Some(source) = sources.iter().find(|source| source.id == *id) else {
            return Err("unknown_source");
        };
        if session.is_some_and(|session| source.session_id != session) {
            return Err("source_outside_session");
        }
        cited.push(source);
    }
    // What the owner says about themselves or wants everywhere must come
    // from the owner's own messages, never another person's or an agent's.
    if scope != "group"
        && cited
            .iter()
            .any(|source| source.is_agent || source.sender_account_id != account)
    {
        return Err("not_owner_message");
    }
    let label = cited.first().map(|source| source.session_title.clone());
    match scope {
        "global" => Ok(Target {
            scope,
            scope_id: GLOBAL_SCOPE_ID.to_owned(),
            scope_label: None,
        }),
        "conversation" => Ok(Target {
            scope,
            scope_id: session.unwrap_or_default().to_owned(),
            scope_label: label,
        }),
        _ => {
            // A group memory's scope id is the group conversation id. The
            // session id is `session:group:<id>` for most groups but the bare
            // conversation id for others, so the sources' conversation decides;
            // `save_all` then checks it is a group the owner is active in.
            let conversation = &cited[0].conversation_id;
            if cited
                .iter()
                .any(|source| source.conversation_id != *conversation)
            {
                return Err("source_outside_session");
            }
            let group = uuid::Uuid::parse_str(conversation).map_err(|_| "not_a_group_session")?;
            if !memory_store::category_allowed_in_group(category) {
                return Err("category_not_shared");
            }
            Ok(Target {
                scope,
                scope_id: group.to_string(),
                scope_label: label,
            })
        }
    }
}

/// Whether the scope already holds the text, compared trimmed and without
/// case. A group's memories match whichever member saved them.
async fn duplicate(
    pool: &PgPool,
    account: &str,
    target: &Target,
    text: &str,
) -> Result<bool, sqlx_core::Error> {
    let (found,): (bool,) = query_as(
        "SELECT EXISTS (SELECT 1 FROM cloud_account_memories \
         WHERE archived_at IS NULL AND scope = $2 AND scope_id = $3 \
           AND (owner_account_id = $1 OR scope = 'group') \
           AND lower(btrim(text)) = lower(btrim($4)))",
    )
    .bind(account)
    .bind(target.scope)
    .bind(&target.scope_id)
    .bind(text)
    .fetch_one(pool)
    .await?;
    Ok(found)
}

async fn skipped(pool: &PgPool, account: &str, run: &str, memory: &DigestMemory, reason: &str) {
    memory_store::write_memory_audit(
        pool,
        account,
        None,
        "digest_memory_skipped",
        json!({
            "runId": run,
            "reason": reason,
            "scope": memory.scope,
            "category": memory.category,
        }),
    )
    .await;
}

/// Checks and saves the run's memories as the owner. Returns how many were
/// saved; every skipped memory is audited with its reason, never its text.
pub(super) async fn save_all(
    pool: &PgPool,
    run: &str,
    account: &str,
    sources: &[Source],
    memories: Vec<DigestMemory>,
) -> usize {
    let mut saved = 0;
    let mut seen = HashSet::new();
    for (index, memory) in memories.iter().enumerate() {
        if index >= MAX_MEMORIES || saved >= MAX_MEMORIES {
            skipped(pool, account, run, memory, "too_many").await;
            continue;
        }
        let target = match target(memory, account, sources) {
            Ok(target) => target,
            Err(reason) => {
                skipped(pool, account, run, memory, reason).await;
                continue;
            }
        };
        let text = memory.text.trim();
        let key = (target.scope, target.scope_id.clone(), text.to_lowercase());
        if !seen.insert(key) {
            skipped(pool, account, run, memory, "duplicate").await;
            continue;
        }
        if target.scope == "group" {
            match memory_store::is_active_group_member(pool, account, &target.scope_id).await {
                Ok(true) => {}
                Ok(false) => {
                    skipped(pool, account, run, memory, "not_an_active_group").await;
                    continue;
                }
                Err(error) => {
                    skipped(pool, account, run, memory, error.code).await;
                    continue;
                }
            }
        }
        match duplicate(pool, account, &target, text).await {
            Ok(false) => {}
            Ok(true) => {
                skipped(pool, account, run, memory, "duplicate").await;
                continue;
            }
            Err(error) => {
                eprintln!("[digest] Could not check a memory for duplicates: {error}");
                skipped(pool, account, run, memory, "server_error").await;
                continue;
            }
        }
        let request = SaveMemoryRequest {
            scope: target.scope.to_owned(),
            scope_id: target.scope_id,
            scope_label: target.scope_label,
            source: SOURCE.to_owned(),
            text: text.to_owned(),
            client_memory_id: None,
            category: Some(memory.category.trim().to_owned()),
            confidence: Some(memory.confidence.trim().to_owned()),
            declared_by: Some("agent".to_owned()),
        };
        // The memory switch, the sensitive guard and the category rules are
        // the ones every save runs.
        match memory_store::save(pool, account, &request).await {
            Ok(SaveOutcome::Created(created)) => {
                saved += 1;
                memory_store::write_memory_audit(
                    pool,
                    account,
                    None,
                    "memory_saved",
                    json!({
                        "memoryId": created.memory_id,
                        "scope": created.scope,
                        "source": created.source,
                        "category": created.category,
                        "declarationType": created.declaration_type,
                        "runId": run,
                        "via": "digest",
                    }),
                )
                .await;
            }
            Ok(SaveOutcome::Existing(_)) => {
                skipped(pool, account, run, memory, "duplicate").await;
            }
            Err(error) => skipped(pool, account, run, memory, error.code).await,
        }
    }
    saved
}

#[cfg(test)]
#[path = "memories_tests.rs"]
mod tests;
