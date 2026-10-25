//! Memories a card build relates to its card (#2069). The build offers the
//! run the owner's other memories, and the run names the ones that belong
//! to this card under `relatedMemoryIds`. When the card is stored, those
//! that were offered are added to it. Relating never fails a build.

use serde_json::{json, Value};
use sqlx_core::acquire::Acquire;
use sqlx_core::transaction::Transaction;
use sqlx_postgres::{PgPool, Postgres};

use crate::common_ground::redact::{redact, squeeze};
use crate::memory_store::{CandidateMemory, ProfileTarget};

/// The most memories one build offers.
const MAX_CANDIDATES: i64 = 40;
/// Characters of a candidate's text the run reads.
const MAX_CANDIDATE_CHARS: usize = 200;
/// The most memories one build adds to its card.
const MAX_RELATED: usize = 15;

/// What the instructions say when the build offers memories.
pub(super) const SYSTEM_BLOCK: &str = "You also get the person's other saved memories under \"Other memories\", each with an id. They are not evidence: never cite them. List under \"relatedMemoryIds\" the ids of those that belong to this profile's topic as described above and are worth showing with this card. Leave the list empty when none fit. Never invent ids. Put \"relatedMemoryIds\" in the same JSON object as the topics.";

/// A memory offered to the run, redacted.
#[derive(Debug, Clone, PartialEq)]
pub(in crate::common_ground) struct Candidate {
    pub id: String,
    pub text: String,
    pub category: String,
}

/// The memories the build of `target` offers. Only builds that read
/// memories offer any.
pub(super) async fn candidates(
    pool: &PgPool,
    account: &str,
    target: ProfileTarget<'_>,
    memory_on: bool,
) -> sqlx_core::Result<Vec<Candidate>> {
    if !memory_on {
        return Ok(Vec::new());
    }
    let enabled = crate::memory_store::settings(pool, account)
        .await
        .map_err(|_| sqlx_core::Error::Protocol("Could not read memories.".into()))?
        .memory_enabled;
    if !enabled {
        return Ok(Vec::new());
    }
    let rows = crate::memory_store::card_candidates(pool, account, target, MAX_CANDIDATES).await?;
    Ok(rows
        .into_iter()
        .map(
            |CandidateMemory {
                 memory_id,
                 text,
                 category,
             }| Candidate {
                id: memory_id,
                text: squeeze(&redact(&text), MAX_CANDIDATE_CHARS),
                category,
            },
        )
        .filter(|candidate| !candidate.text.is_empty())
        .collect())
}

/// The block of the user prompt that lists the offered memories.
pub(in crate::common_ground) fn user_block(candidates: &[Candidate]) -> String {
    let mut out = String::from("\nOther memories:\n");
    for candidate in candidates {
        out.push_str(&format!(
            "[{}] {} · {}\n",
            candidate.id, candidate.category, candidate.text
        ));
    }
    out
}

/// The offered ids, as stored with the build.
pub(super) fn stored_ids(candidates: &[Candidate]) -> Value {
    json!(candidates.iter().map(|c| c.id.as_str()).collect::<Vec<_>>())
}

/// The ids the reply names under `relatedMemoryIds` that the build offered,
/// in reply order, without repeats, at most [`MAX_RELATED`]. A reply
/// without the list relates nothing.
pub(in crate::common_ground) fn related_ids(text: &str, offered: &Value) -> Vec<String> {
    let offered: Vec<&str> = offered
        .as_array()
        .map(|ids| ids.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let reply: Option<Value> = text
        .find('{')
        .zip(text.rfind('}'))
        .and_then(|(start, end)| text.get(start..=end))
        .and_then(|json| serde_json::from_str(json).ok());
    let mut out: Vec<String> = Vec::new();
    let named = reply
        .as_ref()
        .and_then(|reply| reply.get("relatedMemoryIds"))
        .and_then(Value::as_array);
    for id in named.into_iter().flatten().filter_map(Value::as_str) {
        let id = id.trim();
        if out.len() == MAX_RELATED {
            break;
        }
        if offered.contains(&id) && !out.iter().any(|seen| seen == id) {
            out.push(id.to_owned());
        }
    }
    out
}

/// Adds the related memories to the card inside the transaction that
/// stores it, so their `updated_at` equals the card's `built_at` and they
/// do not count as changed since the build. A failure rolls back only this
/// step. Returns how many were added.
pub(super) async fn relate(
    tx: &mut Transaction<'_, Postgres>,
    account: &str,
    profile_id: &str,
    ids: &[String],
) -> usize {
    if ids.is_empty() {
        return 0;
    }
    let result = async {
        let mut savepoint = tx.begin().await.map_err(|e| e.to_string())?;
        let added = crate::memory_store::relate_to_card(&mut savepoint, account, profile_id, ids)
            .await
            .map_err(|e| e.message)?;
        savepoint.commit().await.map_err(|e| e.to_string())?;
        Ok::<_, String>(added)
    }
    .await;
    result.unwrap_or_else(|error| {
        eprintln!("[common-ground] Could not relate memories to card {profile_id}: {error}");
        0
    })
}

/// Records how many memories a build related, without their texts.
pub(super) async fn audit(pool: &PgPool, account: &str, profile_id: &str, count: usize) {
    if count == 0 {
        return;
    }
    crate::memory_store::write_memory_audit(
        pool,
        account,
        None,
        "card_memories_related",
        json!({ "profileId": profile_id, "count": count }),
    )
    .await;
}
