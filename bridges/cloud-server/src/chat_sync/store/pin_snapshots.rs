use sqlx_core::{from_row::FromRow, row::Row};
use sqlx_postgres::PgRow;

use super::*;

struct SessionPinRow {
    session_id: String,
    shared_message_id: Option<String>,
    private_message_id: Option<String>,
    updated_at: Option<String>,
}

impl<'row> FromRow<'row, PgRow> for SessionPinRow {
    fn from_row(row: &'row PgRow) -> Result<Self, sqlx_core::Error> {
        Ok(Self {
            session_id: row.try_get("session_id")?,
            shared_message_id: row.try_get("shared_message_id")?,
            private_message_id: row.try_get("private_message_id")?,
            updated_at: row.try_get("updated_at")?,
        })
    }
}

pub(super) async fn bootstrap_session_pins(
    transaction: &mut Transaction<'_, Postgres>,
    session_ids: &[String],
    account_id: &str,
) -> Result<Vec<CloudSessionPinSummary>, StoreError> {
    let rows: Vec<SessionPinRow> = query_as(
        "SELECT visible_session.session_id, \
                shared_pin.message_id AS shared_message_id, \
                private_pin.message_id AS private_message_id, \
                COALESCE(private_pin.updated_at, shared_pin.updated_at) AS updated_at \
         FROM UNNEST($1::text[]) AS visible_session(session_id) \
         LEFT JOIN cloud_session_shared_pins shared_pin ON shared_pin.session_id = visible_session.session_id \
         LEFT JOIN cloud_account_session_pins private_pin \
           ON private_pin.session_id = visible_session.session_id AND private_pin.account_id = $2 \
         ORDER BY visible_session.session_id ASC",
    )
    .bind(session_ids)
    .bind(account_id)
    .fetch_all(&mut **transaction)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| CloudSessionPinSummary {
            session_id: row.session_id,
            shared_message_id: row.shared_message_id.clone(),
            private_message_id: row.private_message_id.clone(),
            effective_message_id: row.private_message_id.or(row.shared_message_id),
            updated_at: row.updated_at,
        })
        .collect())
}
