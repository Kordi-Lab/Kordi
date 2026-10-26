//! Follow-through from a result screen into real Kordi objects: a contact
//! request (Add), the direct chat (Chat), a plan card in that chat (Meet),
//! a group started from a room (Start group) and joining one (Join).

mod groups;
mod join;
mod people;
mod relationship;
mod room_view;

pub(super) use groups::start_group;
pub(super) use join::join;
pub(super) use people::{add_contact, chat, meet};
pub(super) use relationship::{attach, relationship, relationships};
pub(super) use room_view::room_extras;

use std::collections::HashMap;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::{db_error, people as cg_people};

/// The response to send instead when `viewer` may not act on `other`: they
/// share a room or a pairing, or else see each other through nearby right
/// now.
async fn require_visible(pool: &PgPool, viewer: &str, other: &str) -> Option<Response> {
    if viewer == other {
        return Some(cg_people::not_found());
    }
    let visible = match cg_people::can_see(pool, viewer, other).await {
        Ok(true) => Ok(true),
        Ok(false) => super::nearby::visible(pool, viewer, other).await,
        Err(error) => Err(error),
    };
    match visible {
        Ok(true) => None,
        Ok(false) => Some(cg_people::not_found()),
        Err(error) => Some(db_error(error)),
    }
}

/// 409 with the current relationship, for Chat and Meet before Add.
async fn not_contacts(pool: &PgPool, viewer: &str, other: &str) -> Response {
    match relationship(pool, viewer, other).await {
        Ok(relationship) => (
            StatusCode::CONFLICT,
            Json(json!({
                "errorCode": "common_ground_not_contacts",
                "message": "Add them as a contact first.",
                "relationship": relationship,
            })),
        )
            .into_response(),
        Err(error) => db_error(error),
    }
}

async fn is_contact(pool: &PgPool, viewer: &str, other: &str) -> sqlx_core::Result<bool> {
    let (contact,): (bool,) = query_as(
        "SELECT EXISTS(SELECT 1 FROM cloud_contacts WHERE account_id = $1 AND peer_account_id = $2)",
    )
    .bind(viewer)
    .bind(other)
    .fetch_one(pool)
    .await?;
    Ok(contact)
}

/// Person objects for these accounts, keyed by account id.
async fn people_by_id(pool: &PgPool, ids: &[String]) -> sqlx_core::Result<HashMap<String, Value>> {
    type PersonRow = (String, Option<String>, Option<String>, Option<String>);
    let rows: Vec<PersonRow> = query_as(
        "SELECT account_id, display_name, COALESCE(public_handle, public_account_number::TEXT), avatar_url
         FROM cloud_accounts WHERE account_id = ANY($1)",
    )
    .bind(ids)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, handle, avatar)| {
            let person =
                cg_people::person(&id, name.as_deref(), handle.as_deref(), avatar.as_deref());
            (id, person)
        })
        .collect())
}
