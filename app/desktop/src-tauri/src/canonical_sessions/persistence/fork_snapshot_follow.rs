//! A fork copies its source's history when it is made. A reply that was still
//! running then follows its source row until it finishes, so the fork does
//! not show it working forever. Finished copies stay as they were copied.

use rusqlite::{params, Connection};

pub(crate) const RUNNING_STATUSES: [&str; 6] = [
    "sending",
    "pending",
    "queued",
    "processing",
    "streaming",
    "running",
];

/// Copies the current state of `message_id` onto its fork snapshots that are
/// still running, then onto copies of those copies (forks of forks). Returns
/// how many copies changed.
pub(crate) fn follow_running_fork_copies(
    conn: &Connection,
    session_id: &str,
    message_id: &str,
) -> Result<usize, String> {
    // Only this session's forks can hold a copy, and their snapshot rows are
    // keyed `fork-snapshot:<fork>:<session>:<message>` in the unique source index.
    let mut statement = conn
        .prepare_cached(
            "UPDATE session_messages AS copy
             SET content_text = source.content_text,
                 content_json = source.content_json,
                 status = source.status,
                 content_hash = source.content_hash,
                 updated_at_ms = source.updated_at_ms
             FROM session_messages AS source
             WHERE source.id = ?1
               AND source.session_id = ?2
               AND copy.source_transport = 'canonical-fork-snapshot'
               AND copy.source_event_id IN (
                   SELECT 'fork-snapshot:' || fork.id || ':' || ?2 || ':' || ?1
                   FROM sessions AS fork
                   WHERE json_extract(fork.metadata_json, '$.fork.forkedFromSessionId') = ?2
               )
               AND copy.status IN ('sending', 'pending', 'queued', 'processing', 'streaming', 'running')
             RETURNING session_id, id",
        )
        .map_err(|err| err.to_string())?;
    let mut pending = vec![(session_id.to_string(), message_id.to_string())];
    let mut changed = 0;
    // A fork chain is short; the bound only guards against a malformed cycle.
    while let Some((session, message)) = pending.pop().filter(|_| changed < 256) {
        let copies = statement
            .query_map(params![message, session], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(|err| err.to_string())?
            .collect::<Result<Vec<(String, String)>, _>>()
            .map_err(|err| err.to_string())?;
        changed += copies.len();
        pending.extend(copies);
    }
    Ok(changed)
}
