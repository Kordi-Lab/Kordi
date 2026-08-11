use std::collections::HashSet;
use std::sync::Arc;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{post, put};
use axum::{Extension, Json, Router};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx_core::query::query;
use sqlx_core::query_as::query_as;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

use crate::auth::routes::{cloud_session_participants, CloudSession};
use crate::server::ServerState;

const SESSION_ID_MAX_CHARS: usize = 256;
const MESSAGE_ID_MAX_CHARS: usize = 512;
const CUSTOM_EMOJI_ID_MAX_CHARS: usize = 128;
const REACTION_QUERY_MAX_MESSAGE_IDS: usize = 200;

pub fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route(
            "/v1/cloud/reactions",
            put(upsert_reaction).delete(delete_reaction),
        )
        .route("/v1/cloud/reactions/query", post(query_reactions))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReactionMutationRequest {
    session_id: String,
    message_id: String,
    kind: String,
    unicode_value: Option<String>,
    custom_emoji_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReactionQueryRequest {
    session_id: String,
    message_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudReactionSummary {
    session_id: String,
    message_id: String,
    account_id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    unicode_value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    custom_emoji_id: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReactionMutationResponse {
    reaction: CloudReactionSummary,
    changed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReactionDeleteResponse {
    removed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReactionQueryResponse {
    reactions: Vec<CloudReactionSummary>,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    #[serde(rename = "errorCode")]
    error_code: &'static str,
    message: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NormalizedReaction {
    session_id: String,
    message_id: String,
    kind: String,
    reaction_key: String,
    unicode_value: Option<String>,
    custom_emoji_id: Option<String>,
}

fn err(code: &'static str, message: impl Into<String>, status: StatusCode) -> Response {
    (
        status,
        Json(ErrorBody {
            error_code: code,
            message: message.into(),
        }),
    )
        .into_response()
}

fn clean_required_id(value: &str, max_chars: usize) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max_chars {
        return None;
    }
    Some(value.to_string())
}

fn looks_like_emoji(value: &str) -> bool {
    value.chars().any(|scalar| {
        let code = scalar as u32;
        matches!(
            code,
            0x1F000..=0x1FAFF
                | 0x2300..=0x23FF
                | 0x2600..=0x27BF
                | 0x2B00..=0x2BFF
        ) || matches!(scalar, '#' | '*' | '0'..='9') && value.contains('\u{20E3}')
    })
}

fn normalize_unicode_reaction(value: &str) -> Option<String> {
    let normalized = value.nfc().collect::<String>();
    if normalized.is_empty()
        || normalized.chars().count() > 32
        || normalized.graphemes(true).count() != 1
        || normalized.chars().any(char::is_control)
        || !looks_like_emoji(&normalized)
    {
        return None;
    }
    Some(normalized)
}

fn normalize_custom_emoji_id(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > CUSTOM_EMOJI_ID_MAX_CHARS
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return None;
    }
    Some(value.to_string())
}

fn normalize_reaction_request(
    request: &ReactionMutationRequest,
) -> Result<NormalizedReaction, Response> {
    let Some(session_id) = clean_required_id(&request.session_id, SESSION_ID_MAX_CHARS) else {
        return Err(err(
            "invalid_session",
            "sessionId is required and must be at most 256 characters.",
            StatusCode::BAD_REQUEST,
        ));
    };
    let Some(message_id) = clean_required_id(&request.message_id, MESSAGE_ID_MAX_CHARS) else {
        return Err(err(
            "invalid_message_id",
            "messageId is required and must be at most 512 characters.",
            StatusCode::BAD_REQUEST,
        ));
    };

    match request.kind.trim().to_ascii_lowercase().as_str() {
        "unicode" => {
            let Some(unicode_value) = request
                .unicode_value
                .as_deref()
                .and_then(normalize_unicode_reaction)
            else {
                return Err(err(
                    "invalid_unicode_reaction",
                    "unicodeValue must contain exactly one emoji grapheme.",
                    StatusCode::BAD_REQUEST,
                ));
            };
            if request.custom_emoji_id.is_some() {
                return Err(err(
                    "invalid_reaction",
                    "A Unicode reaction cannot include customEmojiId.",
                    StatusCode::BAD_REQUEST,
                ));
            }
            Ok(NormalizedReaction {
                session_id,
                message_id,
                kind: "unicode".to_string(),
                reaction_key: format!("unicode:{unicode_value}"),
                unicode_value: Some(unicode_value),
                custom_emoji_id: None,
            })
        }
        "custom" => {
            let Some(custom_emoji_id) = request
                .custom_emoji_id
                .as_deref()
                .and_then(normalize_custom_emoji_id)
            else {
                return Err(err(
                    "invalid_custom_emoji",
                    "customEmojiId is invalid.",
                    StatusCode::BAD_REQUEST,
                ));
            };
            if request.unicode_value.is_some() {
                return Err(err(
                    "invalid_reaction",
                    "A custom reaction cannot include unicodeValue.",
                    StatusCode::BAD_REQUEST,
                ));
            }
            Ok(NormalizedReaction {
                session_id,
                message_id,
                kind: "custom".to_string(),
                reaction_key: format!("custom:{custom_emoji_id}"),
                unicode_value: None,
                custom_emoji_id: Some(custom_emoji_id),
            })
        }
        _ => Err(err(
            "invalid_reaction_kind",
            "kind must be unicode or custom.",
            StatusCode::BAD_REQUEST,
        )),
    }
}

async fn authorized_participants(
    state: &ServerState,
    account_id: &str,
    session_id: &str,
) -> Result<Vec<String>, Response> {
    let participants = cloud_session_participants(state.db_pool(), session_id)
        .await
        .map_err(|_| {
            err(
                "server_error",
                "Database error.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        })?;
    if !participants
        .iter()
        .any(|participant| participant == account_id)
    {
        return Err(err(
            "not_a_participant",
            "You can only react to messages in sessions you participate in.",
            StatusCode::FORBIDDEN,
        ));
    }
    Ok(participants)
}

async fn ensure_message_exists(
    state: &ServerState,
    session_id: &str,
    message_id: &str,
) -> Result<(), Response> {
    let exists: Option<(bool,)> = query_as(
        "SELECT TRUE FROM cloud_messages \
         WHERE session_id = $1 AND (message_id = $2 OR client_message_id = $2 \
           OR left(client_message_id, length($2) + 1) = $2 || ':') \
         LIMIT 1",
    )
    .bind(session_id)
    .bind(message_id)
    .fetch_optional(state.db_pool())
    .await
    .map_err(|_| {
        err(
            "server_error",
            "Could not validate the message.",
            StatusCode::INTERNAL_SERVER_ERROR,
        )
    })?;
    if exists.is_none() {
        return Err(err(
            "message_not_found",
            "The message does not exist in this session.",
            StatusCode::NOT_FOUND,
        ));
    }
    Ok(())
}

fn reaction_from_row(
    session_id: &str,
    message_id: &str,
    row: (
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    ),
) -> CloudReactionSummary {
    let (account_id, kind, unicode_value, custom_emoji_id, created_at, updated_at) = row;
    CloudReactionSummary {
        session_id: session_id.to_string(),
        message_id: message_id.to_string(),
        account_id,
        kind,
        unicode_value,
        custom_emoji_id,
        created_at,
        updated_at,
    }
}

async fn upsert_reaction(
    axum::extract::State(state): axum::extract::State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<ReactionMutationRequest>,
) -> Response {
    let normalized = match normalize_reaction_request(&request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let participants =
        match authorized_participants(&state, &session.account_id, &normalized.session_id).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    if let Err(response) =
        ensure_message_exists(&state, &normalized.session_id, &normalized.message_id).await
    {
        return response;
    }
    if let Some(custom_emoji_id) = normalized.custom_emoji_id.as_deref() {
        let available: Option<(bool,)> = match query_as(
            "SELECT TRUE FROM cloud_custom_emojis \
             WHERE emoji_id = $1 AND status = 'active' AND deleted_at IS NULL \
               AND (scope_type = 'global' OR (scope_type = 'workspace' AND scope_id = $2))",
        )
        .bind(custom_emoji_id)
        .bind(&normalized.session_id)
        .fetch_optional(state.db_pool())
        .await
        {
            Ok(value) => value,
            Err(_) => {
                return err(
                    "server_error",
                    "Could not validate custom emoji.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        };
        if available.is_none() {
            return err(
                "custom_emoji_unavailable",
                "This custom emoji is not available in the session.",
                StatusCode::BAD_REQUEST,
            );
        }
    }
    let now = Utc::now().to_rfc3339();
    let pool = state.db_pool();
    let mut transaction = match pool.begin().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return err(
                "server_error",
                "Could not start reaction update.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    let inserted = match query(
        "INSERT INTO cloud_message_reactions \
         (session_id, message_id, account_id, reaction_kind, reaction_key, unicode_value, custom_emoji_id, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) \
         ON CONFLICT (session_id, message_id, account_id, reaction_key) DO NOTHING",
    )
    .bind(&normalized.session_id)
    .bind(&normalized.message_id)
    .bind(&session.account_id)
    .bind(&normalized.kind)
    .bind(&normalized.reaction_key)
    .bind(&normalized.unicode_value)
    .bind(&normalized.custom_emoji_id)
    .bind(&now)
    .execute(&mut *transaction)
    .await
    {
        Ok(result) => result.rows_affected() > 0,
        Err(_) => {
            return err(
                "server_error",
                "Could not save reaction.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };

    if inserted {
        let payload = serde_json::json!({
            "sessionId": &normalized.session_id,
            "messageId": &normalized.message_id,
            "actorAccountId": &session.account_id,
            "operation": "added",
            "reaction": {
                "kind": &normalized.kind,
                "unicodeValue": &normalized.unicode_value,
                "customEmojiId": &normalized.custom_emoji_id,
            },
            "updatedAt": &now,
        });
        for participant in &participants {
            if query(
                "INSERT INTO cloud_sync_events \
                 (account_id, event_type, peer_account_id, message_id, payload_json, occurred_at) \
                 VALUES ($1, 'reaction.updated', $2, $3, $4, $5)",
            )
            .bind(participant)
            .bind(&session.account_id)
            .bind(&normalized.message_id)
            .bind(&payload)
            .bind(&now)
            .execute(&mut *transaction)
            .await
            .is_err()
            {
                return err(
                    "server_error",
                    "Could not synchronize reaction.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        }
    }

    let row: Option<(
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = match query_as(
        "SELECT account_id, reaction_kind, unicode_value, custom_emoji_id, created_at, updated_at \
             FROM cloud_message_reactions \
             WHERE session_id = $1 AND message_id = $2 AND account_id = $3 AND reaction_key = $4",
    )
    .bind(&normalized.session_id)
    .bind(&normalized.message_id)
    .bind(&session.account_id)
    .bind(&normalized.reaction_key)
    .fetch_optional(&mut *transaction)
    .await
    {
        Ok(row) => row,
        Err(_) => {
            return err(
                "server_error",
                "Could not load reaction.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let Some(row) = row else {
        return err(
            "server_error",
            "Could not load reaction.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    };
    if transaction.commit().await.is_err() {
        return err(
            "server_error",
            "Could not save reaction.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    let response = ReactionMutationResponse {
        reaction: reaction_from_row(&normalized.session_id, &normalized.message_id, row),
        changed: inserted,
    };
    if inserted {
        (StatusCode::CREATED, Json(response)).into_response()
    } else {
        Json(response).into_response()
    }
}

async fn delete_reaction(
    axum::extract::State(state): axum::extract::State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<ReactionMutationRequest>,
) -> Response {
    let normalized = match normalize_reaction_request(&request) {
        Ok(value) => value,
        Err(response) => return response,
    };
    let participants =
        match authorized_participants(&state, &session.account_id, &normalized.session_id).await {
            Ok(value) => value,
            Err(response) => return response,
        };
    if let Err(response) =
        ensure_message_exists(&state, &normalized.session_id, &normalized.message_id).await
    {
        return response;
    }
    let now = Utc::now().to_rfc3339();
    let pool = state.db_pool();
    let mut transaction = match pool.begin().await {
        Ok(transaction) => transaction,
        Err(_) => {
            return err(
                "server_error",
                "Could not start reaction update.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    let removed = match query(
        "DELETE FROM cloud_message_reactions \
         WHERE session_id = $1 AND message_id = $2 AND account_id = $3 AND reaction_key = $4",
    )
    .bind(&normalized.session_id)
    .bind(&normalized.message_id)
    .bind(&session.account_id)
    .bind(&normalized.reaction_key)
    .execute(&mut *transaction)
    .await
    {
        Ok(result) => result.rows_affected() > 0,
        Err(_) => {
            return err(
                "server_error",
                "Could not remove reaction.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };

    if removed {
        let payload = serde_json::json!({
            "sessionId": &normalized.session_id,
            "messageId": &normalized.message_id,
            "actorAccountId": &session.account_id,
            "operation": "removed",
            "reaction": {
                "kind": &normalized.kind,
                "unicodeValue": &normalized.unicode_value,
                "customEmojiId": &normalized.custom_emoji_id,
            },
            "updatedAt": &now,
        });
        for participant in &participants {
            if query(
                "INSERT INTO cloud_sync_events \
                 (account_id, event_type, peer_account_id, message_id, payload_json, occurred_at) \
                 VALUES ($1, 'reaction.updated', $2, $3, $4, $5)",
            )
            .bind(participant)
            .bind(&session.account_id)
            .bind(&normalized.message_id)
            .bind(&payload)
            .bind(&now)
            .execute(&mut *transaction)
            .await
            .is_err()
            {
                return err(
                    "server_error",
                    "Could not synchronize reaction.",
                    StatusCode::INTERNAL_SERVER_ERROR,
                );
            }
        }
    }
    if transaction.commit().await.is_err() {
        return err(
            "server_error",
            "Could not remove reaction.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    Json(ReactionDeleteResponse { removed }).into_response()
}

async fn query_reactions(
    axum::extract::State(state): axum::extract::State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(request): Json<ReactionQueryRequest>,
) -> Response {
    let Some(session_id) = clean_required_id(&request.session_id, SESSION_ID_MAX_CHARS) else {
        return err(
            "invalid_session",
            "sessionId is required and must be at most 256 characters.",
            StatusCode::BAD_REQUEST,
        );
    };
    if request.message_ids.len() > REACTION_QUERY_MAX_MESSAGE_IDS {
        return err(
            "too_many_message_ids",
            "At most 200 message IDs can be queried at once.",
            StatusCode::BAD_REQUEST,
        );
    }
    if let Err(response) = authorized_participants(&state, &session.account_id, &session_id).await {
        return response;
    }
    let mut seen = HashSet::new();
    let mut message_ids = Vec::new();
    for raw_message_id in request.message_ids {
        let Some(message_id) = clean_required_id(&raw_message_id, MESSAGE_ID_MAX_CHARS) else {
            return err(
                "invalid_message_id",
                "Every messageId must be non-empty and at most 512 characters.",
                StatusCode::BAD_REQUEST,
            );
        };
        if seen.insert(message_id.clone()) {
            message_ids.push(message_id);
        }
    }
    if message_ids.is_empty() {
        return Json(ReactionQueryResponse { reactions: vec![] }).into_response();
    }

    let rows: Vec<(
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = match query_as(
        "SELECT message_id, account_id, reaction_kind, unicode_value, custom_emoji_id, created_at, updated_at \
         FROM cloud_message_reactions \
         WHERE session_id = $1 AND message_id = ANY($2) \
         ORDER BY created_at ASC, account_id ASC",
    )
    .bind(&session_id)
    .bind(&message_ids)
    .fetch_all(state.db_pool())
    .await
    {
        Ok(rows) => rows,
        Err(_) => {
            return err(
                "server_error",
                "Could not load reactions.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    let reactions = rows
        .into_iter()
        .map(
            |(
                message_id,
                account_id,
                kind,
                unicode_value,
                custom_emoji_id,
                created_at,
                updated_at,
            )| CloudReactionSummary {
                session_id: session_id.clone(),
                message_id,
                account_id,
                kind,
                unicode_value,
                custom_emoji_id,
                created_at,
                updated_at,
            },
        )
        .collect();
    Json(ReactionQueryResponse { reactions }).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unicode_request(value: &str) -> ReactionMutationRequest {
        ReactionMutationRequest {
            session_id: "session-1".into(),
            message_id: "message-1".into(),
            kind: "unicode".into(),
            unicode_value: Some(value.into()),
            custom_emoji_id: None,
        }
    }

    #[test]
    fn accepts_complete_emoji_graphemes() {
        for value in ["👍🏽", "👨‍👩‍👧‍👦", "🇸🇦", "#️⃣"] {
            let reaction = normalize_reaction_request(&unicode_request(value)).unwrap();
            assert_eq!(reaction.unicode_value.as_deref(), Some(value));
        }
    }

    #[test]
    fn rejects_text_and_multiple_emoji() {
        for value in ["a", "👍 ❤️", "", "hello"] {
            assert!(normalize_reaction_request(&unicode_request(value)).is_err());
        }
    }

    #[test]
    fn keeps_skin_tones_as_distinct_reaction_keys() {
        let base = normalize_reaction_request(&unicode_request("👍")).unwrap();
        let toned = normalize_reaction_request(&unicode_request("👍🏽")).unwrap();
        assert_ne!(base.reaction_key, toned.reaction_key);
    }

    #[test]
    fn validates_custom_emoji_identity() {
        let request = ReactionMutationRequest {
            session_id: "session-1".into(),
            message_id: "message-1".into(),
            kind: "custom".into(),
            unicode_value: None,
            custom_emoji_id: Some("019d1234-party_parrot".into()),
        };
        assert!(normalize_reaction_request(&request).is_ok());
    }
}
