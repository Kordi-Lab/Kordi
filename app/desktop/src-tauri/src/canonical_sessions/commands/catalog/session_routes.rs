//! The latest runtime route each session's own desktop requests recorded.
//!
//! The transcript only holds the pages the frontend has loaded, so after a
//! restart a session's route would otherwise depend on which messages happen
//! to be in memory. This reads it straight from the local mirror instead.

use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;

use super::super::super::open_db;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSessionRequestRoute {
    pub session_id: String,
    pub route: Value,
    pub sequence_num: i64,
    pub updated_at_ms: i64,
}

pub(in crate::canonical_sessions) fn latest_session_request_routes_from_db(
    conn: &Connection,
) -> Result<Vec<CanonicalSessionRequestRoute>, String> {
    // `json_extract` fails on malformed JSON, so only valid rows are decoded.
    let mut statement = conn
        .prepare(
            "SELECT session_id, route, sequence_num, updated_at_ms
             FROM (
                 SELECT session_id, route, sequence_num, updated_at_ms,
                        ROW_NUMBER() OVER (
                            PARTITION BY session_id
                            ORDER BY sequence_num DESC, updated_at_ms DESC, id DESC
                        ) AS position
                 FROM (
                     SELECT id, session_id, sequence_num, updated_at_ms,
                            CASE WHEN json_valid(content_json)
                                 THEN json_extract(content_json, '$.agentRuntimeRoute')
                            END AS route
                     FROM session_messages
                     WHERE sender_role = 'user'
                       AND source_transport = 'desktop-chat-ui'
                       AND content_json IS NOT NULL
                 )
                 WHERE json_valid(route)
                   AND json_type(route) = 'object'
                   AND json_type(route, '$.model') = 'text'
                   AND TRIM(json_extract(route, '$.model')) <> ''
             )
             WHERE position = 1
             ORDER BY session_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut routes = Vec::new();
    for row in rows {
        let (session_id, route, sequence_num, updated_at_ms) =
            row.map_err(|error| error.to_string())?;
        let route = serde_json::from_str(&route).map_err(|error| error.to_string())?;
        routes.push(CanonicalSessionRequestRoute {
            session_id,
            route,
            sequence_num,
            updated_at_ms,
        });
    }
    Ok(routes)
}

pub(in crate::canonical_sessions) fn desktop_canonical_session_request_routes(
) -> Result<Vec<CanonicalSessionRequestRoute>, String> {
    let conn = open_db()?;
    latest_session_request_routes_from_db(&conn)
}
