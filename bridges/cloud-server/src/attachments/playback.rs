use std::sync::Arc;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{Extension, Json};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Duration, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sqlx_core::query_as::query_as;

use crate::attachments::access::attachment_access_row;
use crate::attachments::response::err;
use crate::auth::routes::CloudSession;
use crate::server::ServerState;

type HmacSha256 = Hmac<Sha256>;

const TOKEN_PREFIX: &str = "p1";
const TOKEN_TTL_MINUTES: i64 = 60;
const MINIMUM_SECRET_BYTES: usize = 32;

#[derive(Debug, Serialize)]
pub struct PlaybackResponse {
    #[serde(rename = "playbackPath")]
    playback_path: String,
    #[serde(rename = "expiresAt")]
    expires_at: String,
}

#[derive(Debug, Deserialize)]
pub struct PlaybackQuery {
    token: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
struct PlaybackPayload {
    version: i32,
    account_id: String,
    token_id: String,
    device_id: String,
    attachment_id: String,
    expires_at: i64,
}

#[derive(Debug, PartialEq, Eq)]
enum PlaybackTokenError {
    Unavailable,
    Malformed,
    InvalidSignature,
    WrongAttachment,
    Expired,
}

fn signing_key() -> Result<Vec<u8>, PlaybackTokenError> {
    let key = std::env::var("KORDI_CHAT_SYNC_CURSOR_SECRET")
        .ok()
        .filter(|value| value.as_bytes().len() >= MINIMUM_SECRET_BYTES)
        .ok_or(PlaybackTokenError::Unavailable)?;
    Ok(key.into_bytes())
}

fn encode_token(payload: &PlaybackPayload, key: &[u8]) -> String {
    let payload = serde_json::to_vec(payload).expect("playback payload serialization cannot fail");
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts arbitrary key lengths");
    mac.update(&payload);
    format!(
        "{TOKEN_PREFIX}.{}.{}",
        URL_SAFE_NO_PAD.encode(&payload),
        URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
    )
}

fn decode_token(
    token: &str,
    attachment_id: &str,
    key: &[u8],
    now: i64,
) -> Result<PlaybackPayload, PlaybackTokenError> {
    let mut parts = token.split('.');
    if parts.next() != Some(TOKEN_PREFIX) {
        return Err(PlaybackTokenError::Malformed);
    }
    let payload = URL_SAFE_NO_PAD
        .decode(parts.next().ok_or(PlaybackTokenError::Malformed)?)
        .map_err(|_| PlaybackTokenError::Malformed)?;
    let signature = URL_SAFE_NO_PAD
        .decode(parts.next().ok_or(PlaybackTokenError::Malformed)?)
        .map_err(|_| PlaybackTokenError::Malformed)?;
    if parts.next().is_some() {
        return Err(PlaybackTokenError::Malformed);
    }
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts arbitrary key lengths");
    mac.update(&payload);
    mac.verify_slice(&signature)
        .map_err(|_| PlaybackTokenError::InvalidSignature)?;
    let payload: PlaybackPayload =
        serde_json::from_slice(&payload).map_err(|_| PlaybackTokenError::Malformed)?;
    if payload.version != 1
        || payload.account_id.is_empty()
        || payload.token_id.is_empty()
        || payload.device_id.is_empty()
    {
        return Err(PlaybackTokenError::Malformed);
    }
    if payload.attachment_id != attachment_id {
        return Err(PlaybackTokenError::WrongAttachment);
    }
    if payload.expires_at < now {
        return Err(PlaybackTokenError::Expired);
    }
    Ok(payload)
}

pub async fn create(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(attachment_id): Path<String>,
) -> Response {
    if let Err(response) = attachment_access_row(&state, &session, &attachment_id).await {
        return *response;
    }
    let key = match signing_key() {
        Ok(value) => value,
        Err(_) => {
            return err(
                "playback_unavailable",
                "Video playback is not configured on this server.",
                StatusCode::SERVICE_UNAVAILABLE,
            )
        }
    };
    let expires_at = Utc::now() + Duration::minutes(TOKEN_TTL_MINUTES);
    let token = encode_token(
        &PlaybackPayload {
            version: 1,
            account_id: session.account_id,
            token_id: session.token_id,
            device_id: session.device_id,
            attachment_id: attachment_id.clone(),
            expires_at: expires_at.timestamp(),
        },
        &key,
    );
    Json(PlaybackResponse {
        playback_path: format!(
            "/v1/cloud/public/attachments/{attachment_id}/content?token={token}"
        ),
        expires_at: expires_at.to_rfc3339(),
    })
    .into_response()
}

pub async fn content(
    State(state): State<Arc<ServerState>>,
    Path(attachment_id): Path<String>,
    Query(query): Query<PlaybackQuery>,
    request_headers: HeaderMap,
) -> Response {
    let key = match signing_key() {
        Ok(value) => value,
        Err(_) => return err("not_found", "Video not found.", StatusCode::NOT_FOUND),
    };
    let payload = match decode_token(&query.token, &attachment_id, &key, Utc::now().timestamp()) {
        Ok(value) => value,
        Err(_) => return err("not_found", "Video not found.", StatusCode::NOT_FOUND),
    };
    let active_session: Option<(i32,)> = match query_as(
        "SELECT 1 FROM cloud_refresh_tokens token \
         JOIN cloud_devices device ON device.device_id = token.device_id \
         WHERE token.token_id = $1 AND token.account_id = $2 AND token.device_id = $3 \
           AND token.revoked_at IS NULL AND token.expires_at > $4 \
           AND device.account_id = token.account_id AND device.revoked_at IS NULL",
    )
    .bind(&payload.token_id)
    .bind(&payload.account_id)
    .bind(&payload.device_id)
    .bind(Utc::now().to_rfc3339())
    .fetch_optional(state.db_pool())
    .await
    {
        Ok(value) => value,
        Err(_) => {
            return err(
                "server_error",
                "Could not verify video playback.",
                StatusCode::INTERNAL_SERVER_ERROR,
            )
        }
    };
    if active_session.is_none() {
        return err("not_found", "Video not found.", StatusCode::NOT_FOUND);
    }
    let session = CloudSession {
        token_id: payload.token_id,
        account_id: payload.account_id,
        device_id: payload.device_id,
    };
    super::routes::stream_attachment_content(&state, &session, &attachment_id, &request_headers)
        .await
}

#[cfg(test)]
mod tests {
    use super::{decode_token, encode_token, PlaybackPayload, PlaybackTokenError};

    const KEY: &[u8] = b"test-only-playback-secret-that-is-long-enough";

    #[test]
    fn playback_tokens_bind_account_attachment_and_expiry() {
        let token = encode_token(
            &PlaybackPayload {
                version: 1,
                account_id: "acct_one".to_string(),
                token_id: "token_one".to_string(),
                device_id: "device_one".to_string(),
                attachment_id: "att_one".to_string(),
                expires_at: 200,
            },
            KEY,
        );
        let payload = decode_token(&token, "att_one", KEY, 100).unwrap();
        assert_eq!(payload.account_id, "acct_one");
        assert_eq!(
            decode_token(&token, "att_two", KEY, 100),
            Err(PlaybackTokenError::WrongAttachment)
        );
        assert_eq!(
            decode_token(&token, "att_one", KEY, 201),
            Err(PlaybackTokenError::Expired)
        );
    }
}
