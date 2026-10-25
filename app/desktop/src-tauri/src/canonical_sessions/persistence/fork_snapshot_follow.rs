//! A fork copies its source's history when it is made. A reply that was still
//! running then follows its source row until it finishes, so the fork does
//! not show it working forever. Finished copies stay as they were copied.

use rusqlite::{params, Connection};

/// Copies the current state of `message_id` onto its fork snapshots that are
/// still running. Returns how many copies changed.
pub(crate) fn follow_running_fork_copies(
    conn: &Connection,
    session_id: &str,
    message_id: &str,
) -> Result<usize, String> {
    // Snapshot rows record their source as `fork-snapshot:<fork>:<session>:<message>`.
    let source_suffix = format!(":{session_id}:{message_id}");
    conn.execute(
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
           AND copy.source_event_id LIKE 'fork-snapshot:%'
           AND substr(copy.source_event_id, -length(?3)) = ?3
           AND copy.status IN ('sending', 'pending', 'queued', 'processing', 'streaming', 'running')",
        params![message_id, session_id, source_suffix],
    )
    .map_err(|err| err.to_string())
}
