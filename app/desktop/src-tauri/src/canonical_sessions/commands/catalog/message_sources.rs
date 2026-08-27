//! Batched source lookup used to avoid replaying durable cloud history.

use std::collections::HashSet;

use rusqlite::{params, Connection};

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
    let mut seen = HashSet::new();
    let mut normalized_sources = Vec::new();
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
        normalized_sources.push(normalized);
    }
    if normalized_sources.is_empty() {
        return Ok(Vec::new());
    }
    let encoded = serde_json::to_string(&normalized_sources).map_err(|error| error.to_string())?;
    let mut statement = conn
        .prepare(
            "SELECT json_extract(request.value, '$.sourceTransport'),
                    json_extract(request.value, '$.sourceEventId')
             FROM json_each(?1) AS request
             JOIN session_messages AS message
               ON message.source_transport = json_extract(request.value, '$.sourceTransport')
              AND message.source_event_id = json_extract(request.value, '$.sourceEventId')
             ORDER BY CAST(request.key AS INTEGER) ASC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![encoded], |row| {
            Ok(CanonicalMessageSourceRef {
                source_transport: row.get(0)?,
                source_event_id: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub(in crate::canonical_sessions) fn desktop_canonical_existing_message_sources(
    sources: Vec<CanonicalMessageSourceRef>,
) -> Result<Vec<CanonicalMessageSourceRef>, String> {
    let conn = open_db()?;
    existing_message_sources_from_db(&conn, sources)
}
