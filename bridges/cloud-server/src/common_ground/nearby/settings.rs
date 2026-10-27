//! `GET|PUT /v1/cloud/common-ground/nearby`: the viewer's nearby setting,
//! the profile they share, their filters and alert preferences.

use std::collections::HashSet;
use std::sync::Arc;

use axum::{extract::State, http::StatusCode, response::IntoResponse, response::Response};
use axum::{Extension, Json};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};

use super::distance::valid_range;
use super::{config, invalid_settings, invalidate_alerts, mark_dirty, participation, updated};
use crate::common_ground::{card, db_error, err, profiles, sharing_off};
use crate::{auth::routes::CloudSession, server::ServerState};

pub(super) const MIN_SCORES: [i64; 4] = [0, 50, 70, 85];
const ALERT_MIN_SCORES: [i64; 3] = [50, 70, 85];
const MAX_PER_DAY: [i64; 3] = [1, 3, 10];
const MAX_OPEN_TO: usize = 5;
const MAX_OPEN_TO_CHARS: usize = 30;
/// Pauses and request windows end at most this far ahead.
pub(super) const MAX_AHEAD_DAYS: i64 = 7;

/// An account's nearby row, or the defaults when it has none.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Settings {
    pub enabled: bool,
    pub profile_id: Option<String>,
    pub paused_until: Option<DateTime<Utc>>,
    pub consented_at: Option<DateTime<Utc>>,
    pub open_to: Vec<String>,
    pub range_m: i32,
    pub min_score: i32,
    pub alert_requests: bool,
    pub alert_matches: bool,
    pub alert_match_min_score: i32,
    pub alert_max_per_day: i32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            profile_id: None,
            paused_until: None,
            consented_at: None,
            open_to: Vec::new(),
            range_m: 2_000,
            min_score: 0,
            alert_requests: true,
            alert_matches: true,
            alert_match_min_score: 85,
            alert_max_per_day: 3,
        }
    }
}

type SettingsRow = (
    bool,
    Option<String>,
    Option<DateTime<Utc>>,
    Option<DateTime<Utc>>,
    Value,
    i32,
    i32,
    bool,
    bool,
    i32,
    i32,
);

/// The account's settings. `FOR UPDATE` when `lock` is set.
pub(super) async fn load<'e, E>(
    executor: E,
    account: &str,
    lock: bool,
) -> sqlx_core::Result<Settings>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let sql = format!(
        "SELECT enabled, profile_id, paused_until, consented_at, open_to_json, range_m, min_score,
                alert_requests, alert_matches, alert_match_min_score, alert_max_per_day
         FROM cloud_common_ground_nearby WHERE account_id = $1 {}",
        if lock { "FOR UPDATE" } else { "" }
    );
    let row: Option<SettingsRow> = query_as(&sql)
        .bind(account)
        .fetch_optional(executor)
        .await?;
    Ok(row.map_or_else(Settings::default, |row| Settings {
        enabled: row.0,
        profile_id: row.1,
        paused_until: row.2,
        consented_at: row.3,
        open_to: serde_json::from_value(row.4).unwrap_or_default(),
        range_m: row.5,
        min_score: row.6,
        alert_requests: row.7,
        alert_matches: row.8,
        alert_match_min_score: row.9,
        alert_max_per_day: row.10,
    }))
}

impl Settings {
    fn paused(&self, now: DateTime<Utc>) -> bool {
        self.paused_until.is_some_and(|until| until > now)
    }
}

/// The settings and status as `GET` returns them.
async fn view(pool: &PgPool, account: &str) -> sqlx_core::Result<Value> {
    let settings = load(pool, account, false).await?;
    let profile_id = match settings.profile_id.clone() {
        Some(id) => Some(id),
        None => profiles::default_profile(pool, account)
            .await?
            .map(|profile| profile.profile_id),
    };
    let participating = participation::participates(pool, account).await?;
    let location: Option<(DateTime<Utc>, DateTime<Utc>, bool)> = query_as(
        "SELECT loc.captured_at, loc.fresh_until, loc.fresh_until > now()
         FROM cloud_common_ground_nearby_locations loc
         JOIN cloud_devices device ON device.device_id = loc.device_id AND device.revoked_at IS NULL
         WHERE loc.account_id = $1 ORDER BY loc.captured_at DESC LIMIT 1",
    )
    .bind(account)
    .fetch_optional(pool)
    .await?;
    Ok(json!({
        "enabled": settings.enabled,
        "participating": participating,
        "pausedUntil": settings.paused_until,
        "consentedAt": settings.consented_at,
        "profileId": profile_id,
        "openTo": settings.open_to,
        "range": settings.range_m,
        "minScore": settings.min_score,
        "alerts": {
            "requests": settings.alert_requests,
            "matches": settings.alert_matches,
            "matchMinScore": settings.alert_match_min_score,
            "maxPerDay": settings.alert_max_per_day,
        },
        "location": location.map(|(captured_at, fresh_until, fresh)| json!({
            "capturedAt": captured_at, "freshUntil": fresh_until, "fresh": fresh,
        })),
        "freshSeconds": config().fresh_seconds,
    }))
}

async fn respond(pool: &PgPool, account: &str) -> Response {
    match view(pool, account).await {
        Ok(view) => (StatusCode::OK, Json(view)).into_response(),
        Err(error) => db_error(error),
    }
}

/// `GET /v1/cloud/common-ground/nearby`.
pub(super) async fn read(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    respond(state.db_pool(), &session.account_id).await
}

/// A field that is present in the body, even as `null`.
pub(super) fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    value: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(value).map(Some)
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AlertsBody {
    requests: Option<bool>,
    matches: Option<bool>,
    match_min_score: Option<i64>,
    max_per_day: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct UpdateBody {
    enabled: Option<bool>,
    consent: Option<bool>,
    profile_id: Option<String>,
    #[serde(deserialize_with = "present")]
    paused_until: Option<Option<DateTime<Utc>>>,
    open_to: Option<Vec<String>>,
    /// Reject an activity edit from a card that is no longer active.
    open_to_profile_id: Option<String>,
    range: Option<i64>,
    min_score: Option<i64>,
    alerts: Option<AlertsBody>,
}

/// Trimmed, whitespace collapsed, deduplicated ignoring case.
fn clean_open_to(items: &[String]) -> Result<Vec<String>, &'static str> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let text = item.split_whitespace().collect::<Vec<_>>().join(" ");
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > MAX_OPEN_TO_CHARS {
            return Err("Use up to 30 characters for each entry.");
        }
        if seen.insert(text.to_lowercase()) {
            out.push(text);
        }
    }
    if out.len() > MAX_OPEN_TO {
        return Err("Pick up to 5 entries.");
    }
    Ok(out)
}

fn pick(value: Option<i64>, allowed: &[i64], current: i32) -> Result<i32, ()> {
    match value {
        None => Ok(current),
        Some(value) if allowed.contains(&value) => Ok(value as i32),
        Some(_) => Err(()),
    }
}

/// Applies the body's fields to `current`, checking each value. The profile
/// and consent rules are checked by the caller.
fn apply(
    current: &Settings,
    body: &UpdateBody,
    now: DateTime<Utc>,
) -> Result<Settings, &'static str> {
    let mut next = current.clone();
    if let Some(enabled) = body.enabled {
        next.enabled = enabled;
    }
    if let Some(paused_until) = body.paused_until {
        if paused_until.is_some_and(|until| until > now + Duration::days(MAX_AHEAD_DAYS)) {
            return Err("Pause for up to 7 days.");
        }
        next.paused_until = paused_until;
    }
    if let Some(open_to) = &body.open_to {
        next.open_to = clean_open_to(open_to)?;
    }
    if let Some(range) = body.range {
        if !valid_range(range) {
            return Err("Pick one of the distances.");
        }
        next.range_m = range as i32;
    }
    next.min_score = pick(body.min_score, &MIN_SCORES, next.min_score)
        .map_err(|_| "Pick one of the match scores.")?;
    if let Some(alerts) = &body.alerts {
        next.alert_requests = alerts.requests.unwrap_or(next.alert_requests);
        next.alert_matches = alerts.matches.unwrap_or(next.alert_matches);
        next.alert_match_min_score = pick(
            alerts.match_min_score,
            &ALERT_MIN_SCORES,
            next.alert_match_min_score,
        )
        .map_err(|_| "Pick one of the match scores.")?;
        next.alert_max_per_day = pick(alerts.max_per_day, &MAX_PER_DAY, next.alert_max_per_day)
            .map_err(|_| "Pick how many alerts a day.")?;
    }
    Ok(next)
}

fn consent_required() -> Response {
    err(
        "common_ground_nearby_consent_required",
        "Agree to be seen by people nearby to turn this on.",
        StatusCode::CONFLICT,
    )
}

/// `PUT /v1/cloud/common-ground/nearby`: writes only the fields in the body.
pub(super) async fn update(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
    Json(body): Json<Value>,
) -> Response {
    let Ok(body) = serde_json::from_value::<UpdateBody>(body) else {
        return invalid_settings("Check the Nearby settings.");
    };
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    let result = async {
        let mut tx = pool.begin().await?;
        let outcome = write(&mut tx, account, &body).await?;
        if outcome.is_none() {
            tx.commit().await?;
        }
        Ok::<_, sqlx_core::Error>(outcome)
    }
    .await;
    match result {
        Ok(None) => respond(pool, account).await,
        Ok(Some(response)) => response,
        Err(error) => db_error(error),
    }
}

/// Writes the update; `Some` is the response to send instead, with nothing
/// written.
async fn write(
    tx: &mut Transaction<'_, Postgres>,
    account: &str,
    body: &UpdateBody,
) -> sqlx_core::Result<Option<Response>> {
    query("INSERT INTO cloud_common_ground_nearby (account_id) VALUES ($1) ON CONFLICT DO NOTHING")
        .bind(account)
        .execute(&mut **tx)
        .await?;
    let current = load(&mut **tx, account, true).await?;
    let now = Utc::now();
    let mut next = match apply(&current, body, now) {
        Ok(next) => next,
        Err(message) => return Ok(Some(invalid_settings(message))),
    };
    if let Some(id) = body.profile_id.as_deref().map(str::trim) {
        if profiles::get(&mut **tx, account, id).await?.is_none() {
            return Ok(Some(profiles::not_found()));
        }
        next.profile_id = Some(id.to_string());
    }
    let enabling = next.enabled && !current.enabled;
    if enabling && body.consent != Some(true) {
        return Ok(Some(consent_required()));
    }
    if next.enabled && (enabling || next.profile_id != current.profile_id) {
        if next.profile_id.is_none() {
            next.profile_id = profiles::default_profile(&mut **tx, account)
                .await?
                .map(|profile| profile.profile_id);
        }
        let Some(profile_id) = next.profile_id.as_deref() else {
            return Ok(Some(card::no_card()));
        };
        match card::load(&mut **tx, profile_id).await? {
            Some(row) if row.has_card() && row.sharing => {}
            Some(row) if row.has_card() => return Ok(Some(sharing_off())),
            _ => return Ok(Some(card::no_card())),
        }
    }
    if body.open_to.is_some()
        && body
            .open_to_profile_id
            .as_deref()
            .is_some_and(|id| Some(id) != next.profile_id.as_deref())
    {
        return Ok(Some(err(
            "common_ground_nearby_card_changed",
            "The Nearby card changed. Refresh before editing its activities.",
            StatusCode::CONFLICT,
        )));
    }
    if let Some(profile_id) = next.profile_id.as_deref() {
        if next.profile_id != current.profile_id && body.open_to.is_none() {
            next.open_to = super::profile_preferences::load(tx, profile_id).await?;
        }
        super::profile_preferences::save(tx, profile_id, &next.open_to).await?;
    }
    if enabling {
        next.consented_at = Some(now);
    }
    query(
        "UPDATE cloud_common_ground_nearby SET enabled = $2, profile_id = $3, paused_until = $4,
             consented_at = $5, open_to_json = $6, range_m = $7, min_score = $8,
             alert_requests = $9, alert_matches = $10, alert_match_min_score = $11,
             alert_max_per_day = $12, updated_at = now()
         WHERE account_id = $1",
    )
    .bind(account)
    .bind(next.enabled)
    .bind(&next.profile_id)
    .bind(next.paused_until)
    .bind(next.consented_at)
    .bind(json!(next.open_to))
    .bind(next.range_m)
    .bind(next.min_score)
    .bind(next.alert_requests)
    .bind(next.alert_matches)
    .bind(next.alert_match_min_score)
    .bind(next.alert_max_per_day)
    .execute(&mut **tx)
    .await?;
    if !next.enabled || next.paused(now) {
        hide(tx, account, if next.enabled { "paused" } else { "off" }).await?;
    } else {
        mark_dirty(tx, account).await?;
    }
    updated(tx, account).await?;
    Ok(None)
}

/// Off or paused: the account's locations go, its pending alerts and those
/// about it are invalidated, and the sweep forgets it.
async fn hide(
    tx: &mut Transaction<'_, Postgres>,
    account: &str,
    reason: &str,
) -> sqlx_core::Result<()> {
    query("DELETE FROM cloud_common_ground_nearby_locations WHERE account_id = $1")
        .bind(account)
        .execute(&mut **tx)
        .await?;
    invalidate_alerts(tx, account, reason).await?;
    query("UPDATE cloud_common_ground_nearby SET dirty_at = NULL WHERE account_id = $1")
        .bind(account)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
