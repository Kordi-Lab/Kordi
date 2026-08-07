//! Canonical read-cursor filtering for non-conversational message rows.

use rusqlite::{params, Connection, OptionalExtension};

pub(crate) fn latest_readable_session_message_id(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT id
         FROM session_messages
         WHERE session_id = ?1
           AND COALESCE(source_transport, '') NOT IN ('canonical-fork-snapshot', 'cloud-group-fork-snapshot')
           AND LOWER(TRIM(status)) NOT IN ('sending', 'processing')
           AND NOT CASE
               WHEN LOWER(TRIM(COALESCE(message_kind, ''))) = 'status'
                    AND json_valid(content_json)
               THEN (
                   LOWER(TRIM(COALESCE(json_extract(content_json, '$.kind'), ''))) = 'session-title-update'
                   AND LOWER(TRIM(COALESCE(json_extract(content_json, '$.scope'), ''))) = 'session'
                   AND LOWER(TRIM(
                       CASE
                           WHEN SUBSTR(TRIM(COALESCE(json_extract(content_json, '$.title'), '')), 1, 1) = '#'
                               THEN SUBSTR(TRIM(COALESCE(json_extract(content_json, '$.title'), '')), 2)
                           ELSE COALESCE(json_extract(content_json, '$.title'), '')
                       END
                   )) IN ('new session', 'new chat', 'new fork', 'untitled session', 'session')
               ) OR (
                   LOWER(TRIM(COALESCE(source_transport, ''))) = 'cloud-group-title-update'
                   AND LOWER(TRIM(COALESCE(json_extract(content_json, '$.kind'), ''))) = 'group-title-update'
                   AND LOWER(TRIM(COALESCE(json_extract(content_json, '$.scope'), ''))) = 'group'
                   AND COALESCE(json_extract(content_json, '$.synchronizationOnly'), 0) = 1
                   AND LOWER(TRIM(COALESCE(json_extract(content_json, '$.sourceControlKind'), '')))
                       IN ('group-invite', 'group-update')
               )
               ELSE 0
           END
         ORDER BY sequence_num DESC, created_at_ms DESC
         LIMIT 1",
        params![session_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(|err| err.to_string())
}
