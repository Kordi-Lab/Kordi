//! `GET|POST /v1/cloud/common-ground/profiles` and
//! `PUT|DELETE /v1/cloud/common-ground/profiles/:id`.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as};
use sqlx_postgres::PgPool;
use uuid::Uuid;

use super::{collapse, default_name, get, insert, not_found, valid_design, valid_kind, Profile};
use super::{MAX_FOCUS_CHARS, MAX_NAME_CHARS};
use crate::common_ground::card::Topics;
use crate::common_ground::{db_error, err};
use crate::{auth::routes::CloudSession, server::ServerState};

type ListRow = (
    String,
    String,
    String,
    Option<String>,
    i32,
    bool,
    Option<bool>,
    Option<DateTime<Utc>>,
    Option<Value>,
    Option<String>,
);

/// Every profile of the account as the owner sees it in the list.
async fn views(pool: &PgPool, account: &str) -> sqlx_core::Result<Vec<Value>> {
    let rows: Vec<ListRow> = query_as(
        "SELECT profile.profile_id, profile.kind, profile.name, profile.focus, profile.position,
                COALESCE(card.built_at IS NOT NULL, false), card.sharing_enabled, card.built_at,
                card.topics_json, profile.design
         FROM cloud_common_ground_profiles profile
         LEFT JOIN cloud_common_ground_cards card ON card.profile_id = profile.profile_id
         WHERE profile.account_id = $1 ORDER BY profile.position",
    )
    .bind(account)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, kind, name, focus, position, has_card, sharing, built_at, topics, design)| {
                let topics: Topics = topics
                    .and_then(|value| serde_json::from_value(value).ok())
                    .unwrap_or_default();
                json!({
                    "profileId": id,
                    "kind": kind,
                    "name": name,
                    "focus": focus,
                    "position": position,
                    "design": design,
                    "hasCard": has_card,
                    "sharing": sharing.unwrap_or(true),
                    "builtAt": built_at,
                    "topicCount": if has_card { topics.current().count() } else { 0 },
                })
            },
        )
        .collect())
}

async fn one_view(pool: &PgPool, account: &str, profile_id: &str) -> Response {
    match views(pool, account).await {
        Ok(all) => match all.into_iter().find(|v| v["profileId"] == profile_id) {
            Some(view) => (StatusCode::OK, Json(view)).into_response(),
            None => not_found(),
        },
        Err(error) => db_error(error),
    }
}

/// `GET /v1/cloud/common-ground/profiles`.
pub(in crate::common_ground) async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    match views(state.db_pool(), &session.account_id).await {
        Ok(profiles) => (StatusCode::OK, Json(json!({ "profiles": profiles }))).into_response(),
        Err(error) => db_error(error),
    }
}

fn invalid(message: &str) -> Response {
    err(
        "common_ground_invalid_profile",
        message,
        StatusCode::BAD_REQUEST,
    )
}

/// A cleaned name, or why it is invalid.
fn clean_name(name: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(name) = name.map(collapse) else {
        return Ok(None);
    };
    if name.chars().count() > MAX_NAME_CHARS {
        return Err("Use a name of up to 40 characters.");
    }
    Ok(Some(name))
}

fn clean_focus(focus: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(focus) = focus.map(collapse) else {
        return Ok(None);
    };
    if focus.chars().count() > MAX_FOCUS_CHARS {
        return Err("Use a focus of up to 200 characters.");
    }
    Ok(Some(focus))
}

/// A design that is present in the body, even as `null`.
fn present<'de, D: Deserializer<'de>>(value: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(value).map(Some)
}

/// A checked design; `null` or empty means the kind's default.
fn clean_design(design: Option<&str>) -> Result<Option<String>, &'static str> {
    match design.map(str::trim).filter(|design| !design.is_empty()) {
        None => Ok(None),
        Some(design) if valid_design(design) => Ok(Some(design.to_string())),
        Some(_) => Err("Pick work, health, daily, workshop, research or custom."),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(in crate::common_ground) struct CreateRequest {
    kind: String,
    name: Option<String>,
    focus: Option<String>,
    design: Option<String>,
}

/// `POST /v1/cloud/common-ground/profiles`.
pub(in crate::common_ground) async fn create(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(body): Json<CreateRequest>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    if !valid_kind(&body.kind) {
        return invalid("Pick work, health, daily or custom.");
    }
    let (name, focus) = match (
        clean_name(body.name.as_deref()),
        clean_focus(body.focus.as_deref()),
    ) {
        (Ok(name), Ok(focus)) => (name, focus),
        (Err(message), _) | (_, Err(message)) => return invalid(message),
    };
    if body.kind == "custom" && name.as_deref().unwrap_or_default().is_empty() {
        return invalid("Name your profile.");
    }
    let design = match clean_design(body.design.as_deref()) {
        Ok(design) => design,
        Err(message) => return invalid(message),
    };
    let created = async {
        let mut tx = pool.begin().await?;
        let profile = insert(
            &mut tx,
            account,
            &body.kind,
            name.as_deref(),
            focus.as_deref(),
            design.as_deref(),
        )
        .await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(profile)
    }
    .await;
    match created {
        Ok(Ok(profile)) => {
            let response = one_view(pool, account, &profile.profile_id).await;
            if response.status() != StatusCode::OK {
                return response;
            }
            let (parts, body) = response.into_parts();
            let mut response = Response::from_parts(parts, body);
            *response.status_mut() = StatusCode::CREATED;
            response
        }
        Ok(Err(refused)) => refused.response(),
        Err(error) => db_error(error),
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(in crate::common_ground) struct UpdateRequest {
    name: Option<String>,
    /// An empty focus clears it.
    focus: Option<String>,
    /// `null` gives the profile its kind's design back.
    #[serde(deserialize_with = "present")]
    design: Option<Option<String>>,
}

/// `PUT /v1/cloud/common-ground/profiles/:id`: renames a profile or changes
/// its focus or card design. An empty name gives a fixed kind its default
/// name back.
pub(in crate::common_ground) async fn update(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(profile_id): Path<String>,
    Json(body): Json<UpdateRequest>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let profile: Profile = match get(pool, account, &profile_id).await {
        Ok(Some(profile)) => profile,
        Ok(None) => return not_found(),
        Err(error) => return db_error(error),
    };
    let (name, focus) = match (
        clean_name(body.name.as_deref()),
        clean_focus(body.focus.as_deref()),
    ) {
        (Ok(name), Ok(focus)) => (name, focus),
        (Err(message), _) | (_, Err(message)) => return invalid(message),
    };
    let design = match body.design.as_ref() {
        None => profile.design.clone(),
        Some(design) => match clean_design(design.as_deref()) {
            Ok(design) => design,
            Err(message) => return invalid(message),
        },
    };
    let name = match name {
        None => profile.name.clone(),
        Some(name) if !name.is_empty() => name,
        Some(_) => match default_name(&profile.kind) {
            Some(name) => name.to_string(),
            None => return invalid("Name your profile."),
        },
    };
    let focus = match focus {
        None => profile.focus.clone(),
        Some(focus) => (!focus.is_empty()).then_some(focus),
    };
    // The card keeps its topics until the next build reads the new lens.
    let result = query(
        "UPDATE cloud_common_ground_profiles SET name = $2, focus = $3, design = $4
         WHERE profile_id = $1",
    )
    .bind(&profile_id)
    .bind(&name)
    .bind(&focus)
    .bind(&design)
    .execute(pool)
    .await;
    match result {
        Ok(_) => one_view(pool, account, &profile_id).await,
        Err(error) => db_error(error),
    }
}

/// `DELETE /v1/cloud/common-ground/profiles/:id`: deletes the profile with
/// its card, matches and pairings, and leaves every room where it was the
/// shared profile. An account may delete its last profile.
pub(in crate::common_ground) async fn delete(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(profile_id): Path<String>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let result = async {
        let mut tx = pool.begin().await?;
        let rooms: Vec<(Uuid,)> = query_as(
            "SELECT member.room_id FROM cloud_common_ground_room_members member
             JOIN cloud_common_ground_profiles profile ON profile.profile_id = member.profile_id
             WHERE member.profile_id = $1 AND profile.account_id = $2 AND member.left_at IS NULL",
        )
        .bind(&profile_id)
        .bind(account)
        .fetch_all(&mut *tx)
        .await?;
        // Memberships, pairings, codes, matches and match runs go with it.
        let deleted = query(
            "DELETE FROM cloud_common_ground_profiles WHERE profile_id = $1 AND account_id = $2",
        )
        .bind(&profile_id)
        .bind(account)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>((deleted.rows_affected() > 0, rooms))
    }
    .await;
    match result {
        Ok((true, rooms)) => {
            for (room_id,) in rooms {
                crate::common_ground::rooms::announce(pool, room_id).await;
            }
            StatusCode::NO_CONTENT.into_response()
        }
        Ok((false, _)) => not_found(),
        Err(error) => db_error(error),
    }
}
