//! Requests ("needs"): who the person wants to meet nearby, with no end or a
//! time window that ends within 7 days. The routes are in `need_routes`.

use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::Postgres;

use super::distance::valid_range;
use super::settings::{present, MAX_AHEAD_DAYS};

pub(super) const MAX_NEEDS: i64 = 10;
const MAX_TEXT_CHARS: usize = 200;

/// The SQL condition, over `need`, for a request that is active now.
pub(super) const ACTIVE_SQL: &str = "NOT need.paused
    AND (need.ends_at IS NULL OR need.ends_at > now())
    AND (need.starts_at IS NULL OR need.starts_at <= now())";

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Need {
    pub need_id: String,
    pub account_id: String,
    pub text: String,
    pub range_m: i32,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub paused: bool,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

pub(super) type NeedRow = (
    String,
    String,
    String,
    i32,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    bool,
    i64,
    DateTime<Utc>,
    DateTime<Utc>,
);

pub(super) const COLUMNS: &str =
    "need.need_id, need.account_id, need.text, need.range_m, need.starts_at,
    need.ends_at, need.paused, need.revision, need.created_at, need.updated_at";

pub(super) fn from_row(row: NeedRow) -> Need {
    Need {
        need_id: row.0,
        account_id: row.1,
        text: row.2,
        range_m: row.3,
        starts_at: row.4,
        ends_at: row.5,
        paused: row.6,
        revision: row.7,
        created_at: row.8,
        updated_at: row.9,
    }
}

/// `paused` when paused, else `ended` once the end has passed, else
/// `scheduled` before the start, else `active`.
pub(super) fn status(
    paused: bool,
    starts_at: Option<DateTime<Utc>>,
    ends_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> &'static str {
    if paused {
        "paused"
    } else if ends_at.is_some_and(|end| end <= now) {
        "ended"
    } else if starts_at.is_some_and(|start| now < start) {
        "scheduled"
    } else {
        "active"
    }
}

impl Need {
    pub fn status(&self, now: DateTime<Utc>) -> &'static str {
        status(self.paused, self.starts_at, self.ends_at, now)
    }

    pub fn view(&self, now: DateTime<Utc>) -> Value {
        json!({
            "needId": self.need_id,
            "text": self.text,
            "range": self.range_m,
            "startsAt": self.starts_at,
            "endsAt": self.ends_at,
            "paused": self.paused,
            "status": self.status(now),
            "revision": self.revision,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
        })
    }
}

/// The account's active requests, oldest first.
pub(super) async fn active<'e, E>(executor: E, account: &str) -> sqlx_core::Result<Vec<Need>>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let sql = format!(
        "SELECT {COLUMNS} FROM cloud_common_ground_nearby_needs need
         WHERE need.account_id = $1 AND {ACTIVE_SQL} ORDER BY need.created_at, need.need_id"
    );
    let rows: Vec<NeedRow> = query_as(&sql).bind(account).fetch_all(executor).await?;
    Ok(rows.into_iter().map(from_row).collect())
}

/// One request, whatever its status.
pub(super) async fn load<'e, E>(executor: E, need_id: &str) -> sqlx_core::Result<Option<Need>>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let sql = format!(
        "SELECT {COLUMNS} FROM cloud_common_ground_nearby_needs need WHERE need.need_id = $1"
    );
    let row: Option<NeedRow> = query_as(&sql)
        .bind(need_id)
        .fetch_optional(executor)
        .await?;
    Ok(row.map(from_row))
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct NeedBody {
    text: Option<String>,
    range: Option<i64>,
    #[serde(deserialize_with = "present")]
    starts_at: Option<Option<DateTime<Utc>>>,
    #[serde(deserialize_with = "present")]
    ends_at: Option<Option<DateTime<Utc>>>,
    paused: Option<bool>,
}

/// The fields a request will have.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Draft {
    pub text: String,
    pub range_m: i32,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub paused: bool,
}

/// Applies the body to `current` and checks the result. A new end must be
/// after now and within 7 days; a start must be before the end.
pub(super) fn merge(
    current: &Draft,
    body: &NeedBody,
    now: DateTime<Utc>,
) -> Result<Draft, &'static str> {
    let mut next = current.clone();
    if let Some(text) = &body.text {
        next.text = text.trim().to_string();
    }
    let length = next.text.chars().count();
    if length == 0 || length > MAX_TEXT_CHARS {
        return Err("Describe who you want to meet in up to 200 characters.");
    }
    if let Some(range) = body.range {
        if !valid_range(range) {
            return Err("Pick one of the distances.");
        }
        next.range_m = range as i32;
    }
    if let Some(ends_at) = body.ends_at {
        let latest = now + Duration::days(MAX_AHEAD_DAYS);
        if ends_at.is_some_and(|end| end <= now || end > latest) {
            return Err("End the request within the next 7 days.");
        }
        next.ends_at = ends_at;
    }
    if let Some(starts_at) = body.starts_at {
        next.starts_at = starts_at;
    }
    if body.starts_at.is_some() || body.ends_at.is_some() {
        if let (Some(start), Some(end)) = (next.starts_at, next.ends_at) {
            if start >= end {
                return Err("Start the request before it ends.");
            }
        }
    }
    if let Some(paused) = body.paused {
        next.paused = paused;
    }
    Ok(next)
}

#[cfg(test)]
#[path = "needs_tests.rs"]
mod tests;
