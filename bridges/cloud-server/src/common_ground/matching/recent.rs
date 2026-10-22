//! Recent: people whose match you opened, once per profile they shared.

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;

use super::MatchResult;
use crate::common_ground::actions::{attach, relationships};
use crate::common_ground::{db_error, people, profiles};
use crate::{auth::routes::CloudSession, server::ServerState};

type RecentRow = (
    String,
    Option<String>,
    Option<String>,
    Value,
    DateTime<Utc>,
    bool,
    String,
    String,
    String,
    String,
    Option<String>,
    Option<String>,
);

/// `GET /v1/cloud/common-ground/recent`: people whose match you opened,
/// newest first, one entry per (person, profile they shared). The score and
/// headline are shown only while the match is still current: both cards are
/// at the revisions it was computed from, the other person still shares,
/// and the two profiles still see each other. Otherwise the person stays in
/// your history without them.
pub(in crate::common_ground) async fn recent(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let sql = format!(
        "SELECT * FROM (
             SELECT DISTINCT ON (m.other_profile_id)
                    account.account_id, account.display_name, account.avatar_url, m.result_json,
                    m.opened_at,
                    COALESCE(viewer_card.built_at IS NOT NULL
                        AND viewer_card.revision = m.viewer_revision
                        AND other_card.built_at IS NOT NULL
                        AND other_card.sharing_enabled
                        AND other_card.revision = m.other_revision
                        AND {}, false) AS current,
                    m.viewer_profile_id, theirs.profile_id, theirs.kind, theirs.name, theirs.design,
                    theirs.icon
             FROM cloud_common_ground_matches m
             JOIN cloud_accounts account ON account.account_id = m.other_account_id
             JOIN cloud_common_ground_profiles theirs ON theirs.profile_id = m.other_profile_id
             LEFT JOIN cloud_common_ground_cards viewer_card
               ON viewer_card.profile_id = m.viewer_profile_id
             LEFT JOIN cloud_common_ground_cards other_card
               ON other_card.profile_id = m.other_profile_id
             WHERE m.viewer_account_id = $1 AND m.opened_at IS NOT NULL
             ORDER BY m.other_profile_id, m.opened_at DESC
         ) latest
         ORDER BY opened_at DESC LIMIT 50",
        people::profile_visible_sql("m.viewer_profile_id", "m.other_profile_id"),
    );
    let pool = state.db_pool();
    let rows: Result<Vec<RecentRow>, _> = query_as(&sql)
        .bind(&session.account_id)
        .fetch_all(pool)
        .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => return db_error(error),
    };
    let ids: Vec<String> = rows.iter().map(|row| row.0.clone()).collect();
    let relationships = match relationships(pool, &session.account_id, &ids).await {
        Ok(relationships) => relationships,
        Err(error) => return db_error(error),
    };
    let people: Vec<Value> = rows
        .into_iter()
        .map(
            |(
                id,
                name,
                avatar_url,
                value,
                opened_at,
                current,
                mine,
                theirs,
                kind,
                label,
                design,
                icon,
            )| {
                let result = current
                    .then(|| serde_json::from_value::<MatchResult>(value).ok())
                    .flatten();
                let mut person = people::person(&id, name.as_deref(), avatar_url.as_deref());
                person["profile"] =
                    profiles::tag(&theirs, &kind, &label, design.as_deref(), icon.as_deref());
                let mut entry = json!({
                    "person": person,
                    "profileId": mine,
                    "score": result.as_ref().map(|r| r.score),
                    "headline": result.as_ref().map(|r| &r.headline),
                    "openedAt": opened_at,
                });
                attach(&mut entry, &id, &relationships);
                entry
            },
        )
        .collect();
    (StatusCode::OK, Json(json!({ "people": people }))).into_response()
}
