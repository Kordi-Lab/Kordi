//! `GET|POST /v1/cloud/common-ground/nearby/needs` and
//! `PUT|DELETE /v1/cloud/common-ground/nearby/needs/:id`.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::Utc;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::needs::{from_row, merge, Draft, Need, NeedBody, NeedRow, COLUMNS, MAX_NEEDS};
use super::{mark_dirty, settings, updated};
use crate::common_ground::{db_error, err};
use crate::{auth::routes::CloudSession, server::ServerState};

fn invalid(message: &str) -> Response {
    err(
        "common_ground_nearby_invalid_need",
        message,
        StatusCode::UNPROCESSABLE_ENTITY,
    )
}

fn not_found() -> Response {
    err(
        "common_ground_nearby_need_not_found",
        "This request isn't available.",
        StatusCode::NOT_FOUND,
    )
}

fn parse(body: Value) -> Option<NeedBody> {
    serde_json::from_value(body).ok()
}

/// `GET /v1/cloud/common-ground/nearby/needs`: newest first.
pub(super) async fn list(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let sql = format!(
        "SELECT {COLUMNS} FROM cloud_common_ground_nearby_needs need
         WHERE need.account_id = $1 ORDER BY need.created_at DESC, need.need_id"
    );
    let rows: Result<Vec<NeedRow>, _> = query_as(&sql)
        .bind(&session.account_id)
        .fetch_all(state.db_pool())
        .await;
    match rows {
        Ok(rows) => {
            let now = Utc::now();
            let needs: Vec<Value> = rows
                .into_iter()
                .map(|row| from_row(row).view(now))
                .collect();
            (StatusCode::OK, Json(json!({ "needs": needs }))).into_response()
        }
        Err(error) => db_error(error),
    }
}

/// Marks the account dirty, tells its clients and commits.
async fn finish(mut tx: Transaction<'_, Postgres>, account: &str) -> sqlx_core::Result<()> {
    mark_dirty(&mut tx, account).await?;
    updated(&mut tx, account).await?;
    tx.commit().await
}

/// `POST /v1/cloud/common-ground/nearby/needs`: 201 with the request.
pub(super) async fn create(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(body): Json<Value>,
) -> Response {
    let Some(body) = parse(body) else {
        return invalid("Check the request.");
    };
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let range_m = match settings::load(pool, account, false).await {
        Ok(settings) => settings.range_m,
        Err(error) => return db_error(error),
    };
    let empty = Draft {
        text: String::new(),
        range_m,
        starts_at: None,
        ends_at: None,
        paused: false,
    };
    let now = Utc::now();
    let draft = match merge(&empty, &body, now) {
        Ok(draft) => draft,
        Err(message) => return invalid(message),
    };
    match insert(pool, account, &draft).await {
        Ok(Some(need)) => (StatusCode::CREATED, Json(need.view(now))).into_response(),
        Ok(None) => err(
            "common_ground_nearby_too_many_needs",
            "You can keep up to 10 requests.",
            StatusCode::CONFLICT,
        ),
        Err(error) => db_error(error),
    }
}

async fn insert(pool: &PgPool, account: &str, draft: &Draft) -> sqlx_core::Result<Option<Need>> {
    let mut tx = pool.begin().await?;
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-nearby-needs:' || $1))")
        .bind(account)
        .execute(&mut *tx)
        .await?;
    let (count,): (i64,) =
        query_as("SELECT COUNT(*) FROM cloud_common_ground_nearby_needs WHERE account_id = $1")
            .bind(account)
            .fetch_one(&mut *tx)
            .await?;
    if count >= MAX_NEEDS {
        return Ok(None);
    }
    let sql = format!(
        "INSERT INTO cloud_common_ground_nearby_needs AS need
             (need_id, account_id, text, range_m, starts_at, ends_at, paused)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {COLUMNS}"
    );
    let row: NeedRow = query_as(&sql)
        .bind(format!("cgn_{}", Uuid::new_v4().simple()))
        .bind(account)
        .bind(&draft.text)
        .bind(draft.range_m)
        .bind(draft.starts_at)
        .bind(draft.ends_at)
        .bind(draft.paused)
        .fetch_one(&mut *tx)
        .await?;
    finish(tx, account).await?;
    Ok(Some(from_row(row)))
}

/// `PUT /v1/cloud/common-ground/nearby/needs/:id`: writes only the fields in
/// the body. A change to the text, range or window is a new revision: older
/// verdicts no longer count and pending alerts for it are invalidated, as
/// they are when the request is paused.
pub(super) async fn update(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(need_id): Path<String>,
    Json(body): Json<Value>,
) -> Response {
    let Some(body) = parse(body) else {
        return invalid("Check the request.");
    };
    match edit(state.db_pool(), &session.account_id, &need_id, &body).await {
        Ok(Ok(need)) => (StatusCode::OK, Json(need.view(Utc::now()))).into_response(),
        Ok(Err(response)) => response,
        Err(error) => db_error(error),
    }
}

async fn edit(
    pool: &PgPool,
    account: &str,
    need_id: &str,
    body: &NeedBody,
) -> sqlx_core::Result<Result<Need, Response>> {
    let mut tx = pool.begin().await?;
    let sql = format!(
        "SELECT {COLUMNS} FROM cloud_common_ground_nearby_needs need
         WHERE need.need_id = $1 AND need.account_id = $2 FOR UPDATE"
    );
    let row: Option<NeedRow> = query_as(&sql)
        .bind(need_id)
        .bind(account)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(current) = row.map(from_row) else {
        return Ok(Err(not_found()));
    };
    let before = Draft {
        text: current.text.clone(),
        range_m: current.range_m,
        starts_at: current.starts_at,
        ends_at: current.ends_at,
        paused: current.paused,
    };
    let next = match merge(&before, body, Utc::now()) {
        Ok(next) => next,
        Err(message) => return Ok(Err(invalid(message))),
    };
    let revised = (&next.text, next.range_m, next.starts_at, next.ends_at)
        != (
            &before.text,
            before.range_m,
            before.starts_at,
            before.ends_at,
        );
    let sql = format!(
        "UPDATE cloud_common_ground_nearby_needs need SET text = $2, range_m = $3, starts_at = $4,
             ends_at = $5, paused = $6, revision = revision + $7, updated_at = now()
         WHERE need.need_id = $1 RETURNING {COLUMNS}"
    );
    let row: NeedRow = query_as(&sql)
        .bind(need_id)
        .bind(&next.text)
        .bind(next.range_m)
        .bind(next.starts_at)
        .bind(next.ends_at)
        .bind(next.paused)
        .bind(i64::from(revised))
        .fetch_one(&mut *tx)
        .await?;
    if revised || next.paused {
        query(
            "UPDATE cloud_common_ground_nearby_alerts SET status = 'invalidated', reason = $2
             WHERE need_id = $1 AND status = 'pending'",
        )
        .bind(need_id)
        .bind(if revised {
            "need_changed"
        } else {
            "need_paused"
        })
        .execute(&mut *tx)
        .await?;
    }
    finish(tx, account).await?;
    Ok(Ok(from_row(row)))
}

/// `DELETE /v1/cloud/common-ground/nearby/needs/:id`: 204. Its verdicts,
/// runs and alerts go with it.
pub(super) async fn delete(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Path(need_id): Path<String>,
) -> Response {
    let account = session.account_id.as_str();
    let deleted = async {
        let mut tx = state.db_pool().begin().await?;
        let deleted = query(
            "DELETE FROM cloud_common_ground_nearby_needs WHERE need_id = $1 AND account_id = $2",
        )
        .bind(&need_id)
        .bind(account)
        .execute(&mut *tx)
        .await?;
        if deleted.rows_affected() == 0 {
            return Ok(false);
        }
        finish(tx, account).await?;
        Ok::<_, sqlx_core::Error>(true)
    }
    .await;
    match deleted {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => not_found(),
        Err(error) => db_error(error),
    }
}
