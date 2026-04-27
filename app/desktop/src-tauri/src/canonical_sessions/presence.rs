use rusqlite::{params, Connection, OptionalExtension};

use super::{
    clean_optional, now_ms, validate_status, CanonicalPresence, UpdateCanonicalPresenceRequest,
};

pub(super) fn update_presence_in_db(
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
