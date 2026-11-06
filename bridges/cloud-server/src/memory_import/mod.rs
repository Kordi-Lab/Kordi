//! Memory import for the browser app: one chosen file's text is read into
//! memories by the server's hosted model, with the same prompt, rules, and
//! per-file cap as the Mac's import turn (`kordi_tools::memory_import_prompt`).
//!
//! The extraction saves nothing. Like the Mac import, the client reviews the
//! reply and saves each memory through `POST /v1/cloud/memory` with source
//! `import`. Each extraction is metered as a Grounding run of the person's
//! resource pool (counted per person per day), refused for an account that
//! has not allowed AI (`crate::ai_consent`), and limited per account by the
//! `memory-import-extract` rate-limit budget. The file text is never logged.

use kordi_tools::memory_guard::MEMORY_MAX_CHARS;
use kordi_tools::memory_import_prompt::{
    import_prompt, MAX_MEMORIES_PER_FILE, MEMORY_IMPORT_SYSTEM_PROMPT,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx_postgres::PgPool;
use uuid::Uuid;

use crate::memory_store::{DEFAULT_CATEGORY, MEMORY_CATEGORIES};
use crate::resource_pools::usage::{self, Admission, Settlement};
use crate::resource_pools::{Feature, PoolProvider, ResourcePools};

mod model;
#[cfg(test)]
mod tests;

/// The largest file text one extraction reads, as the Mac reads agent files.
pub const MAX_IMPORT_TEXT_BYTES: usize = 200 * 1024;
/// Existing memories a request may name; the prompt keeps the first 60.
pub const MAX_EXISTING_MEMORIES: usize = 500;
const MAX_FILE_NAME_CHARS: usize = 256;
/// The app name the prompt gives a file chosen in the browser.
const UPLOAD_SOURCE: &str = "Chosen files";
/// Run id prefix of an extraction's pool reservation.
pub(crate) const RUN_PREFIX: &str = "memimport_";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractRequest {
    pub file_name: String,
    pub text: String,
    #[serde(default)]
    pub existing_memories: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExtractedMemory {
    pub text: String,
    pub category: String,
    /// `project` or `global`, as the prompt asks the model to say.
    pub scope: String,
}

#[derive(Debug, Serialize)]
pub struct ExtractResponse {
    pub memories: Vec<ExtractedMemory>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractError {
    InvalidFileName,
    EmptyText,
    TextTooLarge,
    TooManyExistingMemories,
    /// The account has not allowed AI models.
    ConsentRequired,
    /// No hosted model serves this server or organization.
    Unavailable,
    /// The pool's daily limit is used up.
    UsageLimit,
    /// The model call failed or returned something unreadable.
    Model,
    Database,
}

impl ExtractRequest {
    /// Checks the request before anything is counted or sent.
    pub fn validate(&self) -> Result<(), ExtractError> {
        let name = self.file_name.trim();
        if name.is_empty() || name.chars().count() > MAX_FILE_NAME_CHARS {
            return Err(ExtractError::InvalidFileName);
        }
        if self.text.len() > MAX_IMPORT_TEXT_BYTES {
            return Err(ExtractError::TextTooLarge);
        }
        if self.text.trim().is_empty() {
            return Err(ExtractError::EmptyText);
        }
        if self.existing_memories.len() > MAX_EXISTING_MEMORIES {
            return Err(ExtractError::TooManyExistingMemories);
        }
        Ok(())
    }
}

/// Reads one file into memories for `account_id`, metered in the pool of
/// `organization_id` (the person's personal organization when `None`).
pub async fn extract(
    db: &PgPool,
    pools: &ResourcePools,
    account_id: &str,
    organization_id: Option<&str>,
    request: &ExtractRequest,
) -> Result<Vec<ExtractedMemory>, ExtractError> {
    request.validate()?;
    if !crate::ai_consent::is_allowed(db, account_id)
        .await
        .map_err(|_| ExtractError::Database)?
    {
        return Err(ExtractError::ConsentRequired);
    }
    if !pools.admits(organization_id) {
        return Err(ExtractError::Unavailable);
    }
    let pool = pools.resolve(organization_id);
    let provider = pool
        .provider(Feature::Grounding)
        .ok_or(ExtractError::Unavailable)?;
    let token = admit(db, pools, account_id, organization_id, provider).await?;
    let prompt = import_prompt(
        UPLOAD_SOURCE,
        request.file_name.trim(),
        UPLOAD_SOURCE,
        &request.text,
        &request.existing_memories,
    );
    let reply = model::complete(provider, &token, MEMORY_IMPORT_SYSTEM_PROMPT, &prompt)
        .await
        .map_err(|code| {
            // Only the failure kind; never the file text or the reply.
            eprintln!("[memory-import] Extraction failed: {code}");
            ExtractError::Model
        })?;
    parse_reply(&reply).ok_or(ExtractError::Model)
}

/// Counts the extraction against the person's daily Grounding limit and
/// returns the provider's bearer token. The reservation is settled as
/// consumed in the same transaction, before the model is called, so a later
/// failure still counts (the model may have been reached) and the ended-run
/// sweep never gives it back. A refused admission or credential leaves
/// nothing counted.
async fn admit(
    db: &PgPool,
    pools: &ResourcePools,
    account_id: &str,
    organization_id: Option<&str>,
    provider: &PoolProvider,
) -> Result<String, ExtractError> {
    let pool = pools.resolve(organization_id);
    let run_id = format!("{RUN_PREFIX}{}", Uuid::new_v4().simple());
    let mut tx = db.begin().await.map_err(|_| ExtractError::Database)?;
    let organization: Option<String> = match organization_id {
        Some(id) => Some(id.to_string()),
        None => sqlx_core::query_scalar::query_scalar(
            "SELECT organization_id FROM cloud_organizations WHERE personal_account_id = $1",
        )
        .bind(account_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| ExtractError::Database)?,
    };
    let admission = usage::reserve(
        &mut tx,
        &usage::Request {
            run_id: &run_id,
            pool,
            feature: Feature::Grounding,
            scope_id: account_id,
            organization_id: organization.as_deref(),
        },
    )
    .await
    .map_err(|_| ExtractError::Database)?;
    match admission {
        Admission::Admitted => {}
        Admission::Exhausted => return Err(ExtractError::UsageLimit),
        Admission::Stopped => return Err(ExtractError::Unavailable),
    }
    let token = provider
        .auth()
        .credential()
        .bearer_token()
        .await
        .map_err(|_| ExtractError::Unavailable)?;
    usage::settle(&mut tx, &run_id, Settlement::Consumed)
        .await
        .map_err(|_| ExtractError::Database)?;
    tx.commit().await.map_err(|_| ExtractError::Database)?;
    Ok(token)
}

fn json_object_of(reply: &str) -> Option<Value> {
    let start = reply.find('{')?;
    let end = reply.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&reply[start..=end]).ok()
}

/// The memories in a model reply, which may wrap the JSON in a fence or a
/// sentence. Entries without text, or longer than a memory may be, are
/// dropped; an unknown category falls back by scope; at most
/// [`MAX_MEMORIES_PER_FILE`] are kept. `None` when the reply has no list.
pub fn parse_reply(reply: &str) -> Option<Vec<ExtractedMemory>> {
    let parsed = json_object_of(reply)?;
    let entries = parsed.get("memories")?.as_array()?;
    let mut memories = Vec::new();
    for entry in entries {
        if memories.len() >= MAX_MEMORIES_PER_FILE {
            break;
        }
        let Some(text) = entry.get("text").and_then(Value::as_str) else {
            continue;
        };
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() || text.chars().count() > MEMORY_MAX_CHARS {
            continue;
        }
        let scope = if entry.get("scope").and_then(Value::as_str) == Some("global") {
            "global"
        } else {
            "project"
        };
        let category = entry
            .get("category")
            .and_then(Value::as_str)
            .map(str::trim)
            .and_then(|value| MEMORY_CATEGORIES.iter().find(|known| **known == value))
            .copied()
            .unwrap_or(if scope == "global" {
                DEFAULT_CATEGORY
            } else {
                "hcp-custom:task_lessons"
            });
        memories.push(ExtractedMemory {
            text,
            category: category.to_string(),
            scope: scope.to_string(),
        });
    }
    Some(memories)
}
