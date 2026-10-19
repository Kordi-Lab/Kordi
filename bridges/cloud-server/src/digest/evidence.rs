//! Which of a digest's saved sources are still current for the viewer.
//!
//! A digest is not rerun for an edit or deletion of a message it already
//! read, so a saved digest can outlive one of its sources. Items supported by
//! a source that changed or became inaccessible are hidden until the next
//! run reconciles them, instead of hiding the whole digest.

use super::models::{Input, Output, Source};
use super::source_reader::{authorized, sources};
use serde_json::Value;
use sqlx_postgres::PgPool;
use std::collections::{HashMap, HashSet};

type Result<T> = std::result::Result<T, sqlx_core::Error>;

/// The input's sources the viewer can still read at the version the digest
/// saw, with current names and avatars. `None` when a calendar event in the
/// input is no longer authorized.
pub async fn current_input_sources(
    pool: &PgPool,
    account: &str,
    input: &Input,
) -> Result<Option<Vec<Source>>> {
    for event in &input.calendar_events {
        if !authorized(pool, account, &event.source_ids).await? {
            return Ok(None);
        }
    }
    let ids: Vec<_> = input.sources.iter().map(|s| s.id.clone()).collect();
    let current: HashMap<_, _> = sources(pool, account, Some(&ids))
        .await?
        .into_iter()
        .map(|source| (source.id.clone(), source))
        .collect();
    let mut refs = Vec::new();
    for source in &input.sources {
        let Some(latest) = current
            .get(&source.id)
            .filter(|s| s.version == source.version)
        else {
            continue;
        };
        let mut source = source.clone();
        source.sender_name = latest.sender_name.clone();
        source.sender_avatar_url = latest.sender_avatar_url.clone();
        source.session_title = latest.session_title.clone();
        source.is_agent = latest.is_agent;
        source.agent_id = latest.agent_id.clone();
        source.agent_owner_name = latest.agent_owner_name.clone();
        source.agent_avatar_url = latest.agent_avatar_url.clone();
        source.reply_to_source_id = latest
            .reply_to_source_id
            .clone()
            .filter(|id| ids.contains(id));
        refs.push(source);
    }
    Ok(Some(refs))
}

/// Every source of the input, refreshed, or `None` when any changed.
pub async fn authorized_input_sources(
    pool: &PgPool,
    account: &str,
    input: &Input,
) -> Result<Option<Vec<Source>>> {
    Ok(current_input_sources(pool, account, input)
        .await?
        .filter(|refs| refs.len() == input.sources.len()))
}

pub async fn input_is_currently_authorized(
    pool: &PgPool,
    account: &str,
    input: &Input,
) -> Result<bool> {
    Ok(authorized_input_sources(pool, account, input)
        .await?
        .is_some())
}

/// Drops output items supported by a source outside `current`.
pub fn retain_supported(output: &mut Output, current: &[Source]) {
    let ids: HashSet<_> = current.iter().map(|source| source.id.as_str()).collect();
    for items in [
        &mut output.claims,
        &mut output.commitments,
        &mut output.suggestions,
        &mut output.calendar_candidates,
    ] {
        items.retain(|item| item.source_ids.iter().all(|id| ids.contains(id.as_str())));
    }
}

/// The same as [`retain_supported`] for a saved snapshot as stored.
pub fn retain_supported_json(snapshot: &mut Value, current: &[Source]) {
    let ids: HashSet<_> = current.iter().map(|source| source.id.as_str()).collect();
    for key in ["claims", "commitments", "suggestions", "calendarCandidates"] {
        if let Some(items) = snapshot.get_mut(key).and_then(Value::as_array_mut) {
            items.retain(|item| {
                item.get("sourceIds")
                    .and_then(Value::as_array)
                    .is_some_and(|sources| {
                        sources
                            .iter()
                            .all(|id| id.as_str().is_some_and(|id| ids.contains(id)))
                    })
            });
        }
    }
}
