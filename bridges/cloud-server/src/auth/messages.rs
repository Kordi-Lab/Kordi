use serde::Serialize;
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedMessageAttachment {
    pub attachment_id: String,
    pub name: String,
    pub kind: String,
    pub mime_type: Option<String>,
    pub size_bytes: Option<i64>,
    pub download_url: Option<String>,
    pub preview_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PersistedCloudMessage {
    pub message_id: String,
    pub from_account_id: String,
    pub to_account_id: String,
    pub body: String,
    pub session_id: Option<String>,
    pub created_at: String,
    pub delivered_at: Option<String>,
    pub read_at: Option<String>,
    pub attachments: Vec<PersistedMessageAttachment>,
}

pub struct PersistCloudMessageInput<'a> {
    pub message_id: &'a str,
    pub from_account_id: &'a str,
    pub to_account_id: &'a str,
    pub client_message_id: Option<&'a str>,
    pub body: &'a str,
    pub session_id: Option<&'a str>,
    pub created_at: &'a str,
    pub delivered_at: &'a str,
    pub read_at: Option<&'a str>,
    pub attachments: &'a [PersistedMessageAttachment],
}

pub struct PersistCloudMessageOutcome {
    pub message: PersistedCloudMessage,
    pub inserted: bool,
}

type PersistedAttachmentRow = (
    String,
    String,
    String,
    Option<String>,
    Option<i64>,
    Option<String>,
);
type PersistedMessageRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
    Option<String>,
);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncMessage<'a> {
    message_id: &'a str,
    from_account_id: &'a str,
    to_account_id: &'a str,
    body: &'a str,
    session_id: Option<&'a str>,
    created_at: &'a str,
    delivered_at: Option<&'a str>,
    read_at: Option<&'a str>,
    direction: &'a str,
    attachments: &'a [PersistedMessageAttachment],
}

fn sync_payload(message: &PersistedCloudMessage, direction: &str) -> serde_json::Value {
    serde_json::json!({
        "message": SyncMessage {
            message_id: &message.message_id,
            from_account_id: &message.from_account_id,
            to_account_id: &message.to_account_id,
            body: &message.body,
            session_id: message.session_id.as_deref(),
            created_at: &message.created_at,
            delivered_at: message.delivered_at.as_deref(),
            read_at: message.read_at.as_deref(),
            direction,
            attachments: &message.attachments,
        }
    })
}

async fn load_attachments(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    message_id: &str,
) -> Result<Vec<PersistedMessageAttachment>, sqlx_core::Error> {
    let rows: Vec<PersistedAttachmentRow> = query_as(
        "SELECT attachment_id, name, kind, mime_type, size_bytes, preview_url \
         FROM cloud_message_attachments WHERE message_id = $1 ORDER BY position ASC",
    )
    .bind(message_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(attachment_id, name, kind, mime_type, size_bytes, preview_url)| {
                PersistedMessageAttachment {
                    attachment_id,
                    name,
                    kind,
                    mime_type,
                    size_bytes,
                    download_url: None,
                    preview_url,
                }
            },
        )
        .collect())
}

async fn insert_sync_event(
    tx: &mut sqlx_core::transaction::Transaction<'_, sqlx_postgres::Postgres>,
    account_id: &str,
    peer_account_id: &str,
    message: &PersistedCloudMessage,
    direction: &str,
) -> Result<(), sqlx_core::Error> {
    query(
        "INSERT INTO cloud_sync_events \
         (account_id, event_type, peer_account_id, message_id, payload_json, occurred_at) \
         VALUES ($1, 'message.upsert', $2, $3, $4, $5)",
    )
    .bind(account_id)
    .bind(peer_account_id)
    .bind(&message.message_id)
    .bind(sync_payload(message, direction))
    .bind(
        message
            .delivered_at
            .as_deref()
            .unwrap_or(&message.created_at),
    )
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub async fn persist_cloud_message(
    pool: &PgPool,
    input: PersistCloudMessageInput<'_>,
) -> Result<PersistCloudMessageOutcome, sqlx_core::Error> {
    let mut tx = pool.begin().await?;
    let inserted_id: Option<(String,)> = query_as(
        "INSERT INTO cloud_messages \
         (message_id, from_account_id, to_account_id, body, created_at, delivered_at, read_at, session_id, client_message_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (from_account_id, to_account_id, client_message_id) \
           WHERE client_message_id IS NOT NULL DO NOTHING \
         RETURNING message_id",
    )
    .bind(input.message_id)
    .bind(input.from_account_id)
    .bind(input.to_account_id)
    .bind(input.body)
    .bind(input.created_at)
    .bind(input.delivered_at)
    .bind(input.read_at)
    .bind(input.session_id)
    .bind(input.client_message_id)
    .fetch_optional(&mut *tx)
    .await?;

    let inserted = inserted_id.is_some();
    let message = if inserted {
        for (position, attachment) in input.attachments.iter().enumerate() {
            query(
                "INSERT INTO cloud_message_attachments \
                 (message_id, attachment_id, name, kind, mime_type, size_bytes, position, preview_url) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
                 ON CONFLICT (message_id, attachment_id) DO NOTHING",
            )
            .bind(input.message_id)
            .bind(&attachment.attachment_id)
            .bind(&attachment.name)
            .bind(&attachment.kind)
            .bind(attachment.mime_type.as_deref())
            .bind(attachment.size_bytes)
            .bind(position as i32)
            .bind(attachment.preview_url.as_deref())
            .execute(&mut *tx)
            .await?;
        }

        let message = PersistedCloudMessage {
            message_id: input.message_id.to_string(),
            from_account_id: input.from_account_id.to_string(),
            to_account_id: input.to_account_id.to_string(),
            body: input.body.to_string(),
            session_id: input.session_id.map(ToString::to_string),
            created_at: input.created_at.to_string(),
            delivered_at: Some(input.delivered_at.to_string()),
            read_at: input.read_at.map(ToString::to_string),
            attachments: input.attachments.to_vec(),
        };

        if let Some(session_id) = input
            .session_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            query(
                "DELETE FROM cloud_account_session_visibility \
                 WHERE account_id = $1 AND session_id = $2",
            )
            .bind(input.from_account_id)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
            if input.to_account_id != input.from_account_id {
                query(
                    "DELETE FROM cloud_account_session_visibility \
                     WHERE account_id = $1 AND session_id = $2",
                )
                .bind(input.to_account_id)
                .bind(session_id)
                .execute(&mut *tx)
                .await?;
            }
        }

        insert_sync_event(
            &mut tx,
            input.from_account_id,
            input.to_account_id,
            &message,
            "outgoing",
        )
        .await?;
        if input.to_account_id != input.from_account_id {
            insert_sync_event(
                &mut tx,
                input.to_account_id,
                input.from_account_id,
                &message,
                "incoming",
            )
            .await?;
        }
        message
    } else {
        let client_message_id = input.client_message_id.unwrap_or_default();
        let row: PersistedMessageRow = query_as(
            "SELECT message_id, from_account_id, to_account_id, body, session_id, created_at, delivered_at, read_at \
             FROM cloud_messages \
             WHERE from_account_id = $1 AND to_account_id = $2 AND client_message_id = $3",
        )
        .bind(input.from_account_id)
        .bind(input.to_account_id)
        .bind(client_message_id)
        .fetch_one(&mut *tx)
        .await?;
        let attachments = load_attachments(&mut tx, &row.0).await?;
        PersistedCloudMessage {
            message_id: row.0,
            from_account_id: row.1,
            to_account_id: row.2,
            body: row.3,
            session_id: row.4,
            created_at: row.5,
            delivered_at: row.6,
            read_at: row.7,
            attachments,
        }
    };

    tx.commit().await?;
    Ok(PersistCloudMessageOutcome { message, inserted })
}
