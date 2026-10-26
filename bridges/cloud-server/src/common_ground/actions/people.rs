//! Add, Chat and Meet on another person's card.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{is_contact, not_contacts, relationship, require_visible};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::auth::routes::{open_direct_conversation, send_request, CloudSession, ContactOutcome};
use crate::chat_sync::models::SendMessageRequest;
use crate::common_ground::{db_error, err, limited, MEET_LIMIT};
use crate::document_shares::access::clean_display_name;
use crate::plan_cards::models::{PlanCardParticipantInput, PlanCardProposeArgs, PlanCardState};
use crate::server::ServerState;

const DEFAULT_REQUEST_MESSAGE: &str = "Found you on Grounding";
const MAX_TITLE_CHARS: usize = 120;
const MAX_LOCATION_CHARS: usize = 200;

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(in crate::common_ground) struct AddRequest {
    message: Option<String>,
}

/// `POST /v1/cloud/common-ground/people/:account_id/contact`: sends a contact
/// request, or accepts theirs when they asked first.
pub(in crate::common_ground) async fn add_contact(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Path(other): Path<String>,
    body: Option<Json<AddRequest>>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    if let Some(response) = require_visible(pool, viewer, &other).await {
        return response;
    }
    let message = body
        .and_then(|Json(body)| body.message)
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| DEFAULT_REQUEST_MESSAGE.to_string());
    let outcome = send_request(&state, &rate_limiter, &session, &other, Some(&message)).await;
    let (status, sent) = match outcome {
        ContactOutcome::Done(status, sent) => (status, sent),
        ContactOutcome::Failed(response) => return response,
    };
    let relationship = match relationship(pool, viewer, &other).await {
        Ok(relationship) => relationship,
        Err(error) => return db_error(error),
    };
    let mut body = json!({ "relationship": relationship });
    if let Some(hello) = sent.hello_message {
        body["helloMessage"] = json!(hello);
    }
    (status, Json(body)).into_response()
}

/// The direct conversation with a contact, found or created.
async fn direct_conversation(
    pool: &PgPool,
    viewer: &str,
    other: &str,
) -> Result<Uuid, Box<Response>> {
    let opened = async {
        let mut tx = pool.begin().await.map_err(|_| ())?;
        let conversation = open_direct_conversation(&mut tx, viewer, other)
            .await
            .map_err(|error| eprintln!("[common-ground] Could not open a chat: {error}"))?;
        tx.commit().await.map_err(|_| ())?;
        Ok::<_, ()>(conversation.id)
    }
    .await;
    opened.map_err(|_| {
        Box::new(err(
            "common_ground_failed",
            "Could not open the chat. Try again.",
            StatusCode::INTERNAL_SERVER_ERROR,
        ))
    })
}

/// Visible, a contact, then the direct conversation; or the response to send.
async fn contact_chat(pool: &PgPool, viewer: &str, other: &str) -> Result<Uuid, Box<Response>> {
    if let Some(response) = require_visible(pool, viewer, other).await {
        return Err(Box::new(response));
    }
    match is_contact(pool, viewer, other).await {
        Ok(true) => {}
        Ok(false) => return Err(Box::new(not_contacts(pool, viewer, other).await)),
        Err(error) => return Err(Box::new(db_error(error))),
    }
    direct_conversation(pool, viewer, other).await
}

/// `POST /v1/cloud/common-ground/people/:account_id/chat`: the direct chat
/// with a contact.
pub(in crate::common_ground) async fn chat(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(other): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    let conversation_id = match contact_chat(pool, viewer, &other).await {
        Ok(conversation_id) => conversation_id,
        Err(response) => return *response,
    };
    match relationship(pool, viewer, &other).await {
        Ok(relationship) => (
            StatusCode::OK,
            Json(json!({
                "conversationId": conversation_id,
                "sessionId": crate::auth::routes::direct_person_session_id(viewer, &other),
                "relationship": relationship,
            })),
        )
            .into_response(),
        Err(error) => db_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(in crate::common_ground) struct MeetRequest {
    title: Option<String>,
    start_at: Option<String>,
    end_at: Option<String>,
    location: Option<String>,
}

fn bad_request(code: &str, message: &str) -> Box<Response> {
    Box::new(err(code, message, StatusCode::BAD_REQUEST))
}

struct Meeting {
    title: Option<String>,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    location: Option<String>,
}

fn parse_meeting(body: MeetRequest) -> Result<Meeting, Box<Response>> {
    let instant = |value: &str| DateTime::parse_from_rfc3339(value.trim()).ok();
    let Some(start) = body.start_at.as_deref().and_then(instant) else {
        return Err(bad_request("invalid_start_at", "Pick a valid start time."));
    };
    let start = start.with_timezone(&Utc);
    if start < Utc::now() - Duration::minutes(10) {
        return Err(bad_request(
            "start_in_past",
            "Pick a time that hasn't passed.",
        ));
    }
    let end = match body
        .end_at
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        None => start + Duration::hours(1),
        Some(value) => match instant(value) {
            Some(end) if end.with_timezone(&Utc) > start => end.with_timezone(&Utc),
            _ => {
                return Err(bad_request(
                    "invalid_end_at",
                    "Pick an end after the start.",
                ))
            }
        },
    };
    let clean = |value: Option<String>, max: usize, code: &str| {
        let value = value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        if value.as_ref().is_some_and(|v| v.chars().count() > max) {
            return Err(bad_request(code, "This is too long."));
        }
        Ok(value)
    };
    Ok(Meeting {
        title: clean(body.title, MAX_TITLE_CHARS, "invalid_title")?,
        start,
        end,
        location: clean(body.location, MAX_LOCATION_CHARS, "invalid_location")?,
    })
}

async fn display_names(pool: &PgPool, ids: [&str; 2]) -> sqlx_core::Result<[String; 2]> {
    let mut names = [String::new(), String::new()];
    for (slot, id) in names.iter_mut().zip(ids) {
        let row: Option<(Option<String>,)> = sqlx_core::query_as::query_as(
            "SELECT display_name FROM cloud_accounts WHERE account_id = $1",
        )
        .bind(id)
        .fetch_optional(pool)
        .await?;
        *slot = clean_display_name(row.and_then(|(name,)| name).as_deref());
    }
    Ok(names)
}

/// `POST /v1/cloud/common-ground/people/:account_id/meet`: proposes a plan
/// card with a contact in your direct chat. They answer on the card; once
/// you confirm it, it goes on each attending calendar.
pub(in crate::common_ground) async fn meet(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Path(other): Path<String>,
    body: Option<Json<MeetRequest>>,
) -> Response {
    let pool = state.db_pool();
    let viewer = session.account_id.as_str();
    if let Some(response) = require_visible(pool, viewer, &other).await {
        return response;
    }
    let meeting = match parse_meeting(body.map(|Json(body)| body).unwrap_or_default()) {
        Ok(meeting) => meeting,
        Err(response) => return *response,
    };
    match is_contact(pool, viewer, &other).await {
        Ok(true) => {}
        Ok(false) => return not_contacts(pool, viewer, &other).await,
        Err(error) => return db_error(error),
    }
    if let RateLimitDecision::Limited { retry_after } =
        rate_limiter.observe_account_limit(MEET_LIMIT, viewer).await
    {
        return limited(retry_after);
    }
    let conversation_id = match direct_conversation(pool, viewer, &other).await {
        Ok(conversation_id) => conversation_id,
        Err(response) => return *response,
    };
    let [viewer_name, other_name] = match display_names(pool, [viewer, &other]).await {
        Ok(names) => names,
        Err(error) => return db_error(error),
    };
    let participant =
        |account_id: &str, display_name: String, organizer: bool| PlanCardParticipantInput {
            account_id: account_id.to_string(),
            display_name,
            organizer,
        };
    let args = PlanCardProposeArgs {
        conversation_id,
        existing_event_id: None,
        existing_revision: None,
        title: meeting
            .title
            .unwrap_or_else(|| format!("Meet {other_name}")),
        start_at: Some(meeting.start.to_rfc3339()),
        end_at: Some(meeting.end.to_rfc3339()),
        location: meeting.location,
        state: PlanCardState::AwaitingConfirmation,
        unresolved_fields: Vec::new(),
        participants: vec![
            participant(viewer, viewer_name, true),
            participant(&other, other_name, false),
        ],
        source_message_ids: Vec::new(),
        options: Vec::new(),
    };
    let row = match crate::plan_cards::store::propose(pool, viewer, args).await {
        Ok(row) => row,
        Err(error) => {
            eprintln!("[common-ground] Could not propose a plan: {error}");
            return err(
                "common_ground_failed",
                "Could not propose the plan. Try again.",
                StatusCode::INTERNAL_SERVER_ERROR,
            );
        }
    };
    // The card travels in your own message in the chat, shown as a System
    // notice; answers refresh it.
    let message = SendMessageRequest {
        client_message_id: Uuid::new_v5(&Uuid::NAMESPACE_OID, row.event_id.as_bytes()),
        kind: crate::common_ground::SYSTEM_NOTICE_KIND.to_string(),
        content: json!({
            "schema": 1,
            "blocks": [crate::system_agent::cards::card_block_from_row(&row, "event")],
            "legacy_attachments": [],
        }),
        reply_to_message_id: None,
        attachment_ids: Vec::new(),
    };
    if let Err(error) =
        crate::chat_sync::store::send_message(pool, viewer, conversation_id, message).await
    {
        eprintln!("[common-ground] Could not post the plan card: {error}");
        return err(
            "common_ground_failed",
            "Could not post the plan. Try again.",
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }
    let relationship: Value = match relationship(pool, viewer, &other).await {
        Ok(relationship) => relationship,
        Err(error) => return db_error(error),
    };
    (
        StatusCode::CREATED,
        Json(json!({
            "conversationId": conversation_id,
            "planCardId": row.event_id,
            "relationship": relationship,
        })),
    )
        .into_response()
}
