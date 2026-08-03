//! Batched source lookup used to avoid replaying durable cloud history.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use super::super::super::{open_db, CanonicalMessageSourceRef};

const MAX_SOURCE_LOOKUPS: usize = 50_000;

pub(in crate::canonical_sessions) fn existing_message_sources_from_db(
    conn: &Connection,
    sources: Vec<CanonicalMessageSourceRef>,
) -> Result<Vec<CanonicalMessageSourceRef>, String> {
    if sources.len() > MAX_SOURCE_LOOKUPS {
        return Err(format!(
            "Canonical message source lookup is limited to {MAX_SOURCE_LOOKUPS} entries"
        ));
    }
    let mut statement = conn
        .prepare_cached(
            "SELECT 1
             FROM session_messages
             WHERE source_transport = ?1 AND source_event_id = ?2
             LIMIT 1",
        )
        .map_err(|err| err.to_string())?;
    let mut seen = HashSet::new();
    let mut existing = Vec::new();
    for source in sources {
        let source_transport = source.source_transport.trim();
        let source_event_id = source.source_event_id.trim();
        if source_transport.is_empty() || source_event_id.is_empty() {
            continue;
        }
        let normalized = CanonicalMessageSourceRef {
            source_transport: source_transport.to_string(),
            source_event_id: source_event_id.to_string(),
        };
        if !seen.insert(normalized.clone()) {
            continue;
        }
        let found = statement
            .query_row(
                params![
                    normalized.source_transport.as_str(),
                    normalized.source_event_id.as_str()
                ],
                |_| Ok(()),
            )
            .optional()
            .map_err(|err| err.to_string())?
            .is_some();
        if found {
            existing.push(normalized);
        }
    }
    Ok(existing)
}

pub(in crate::canonical_sessions) fn desktop_canonical_existing_message_sources(
    sources: Vec<CanonicalMessageSourceRef>,
) -> Result<Vec<CanonicalMessageSourceRef>, String> {
    let conn = open_db()?;
    existing_message_sources_from_db(&conn, sources)
}
