//! Grounding nearby people (#2100, docs/development/grounding-nearby.md).
//!
//! A person who turns Nearby on, with consent, shares one profile with other
//! participants around them and sees theirs. Visibility is reciprocal: only
//! participants with a fresh location see each other, and turning Nearby
//! off or pausing it hides the person, stops their searches and stops their
//! alerts at once. Every path re-checks the live rule in
//! [`participation`]; room and pairing links never stand in for it.

mod alerts;
mod checks;
mod delivery;
pub(super) mod distance;
mod evidence;
mod location;
mod need_routes;
mod needs;
mod participation;
mod person;
mod results;
mod search;
mod settings;
mod worker;

pub(super) use checks::{complete as complete_check, fail as fail_check};
pub(crate) use location::{forget_device, forget_devices};
pub(super) use participation::visible;
pub(super) use worker::spawn;
#[cfg(test)]
pub(super) use {delivery::Outcome, worker::sweep_once};

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::{
    http::StatusCode,
    response::Response,
    routing::{get, post, put},
    Router,
};
use serde_json::json;
use sqlx_core::{query::query, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};

use super::err;
use crate::auth::rate_limit::AccountActionLimit;
use crate::server::ServerState;

/// Advertised as `commonGroundNearbyVersion` next to `commonGroundVersion`.
pub const COMMON_GROUND_NEARBY_VERSION: u32 = 1;

/// Run ids of request checks start with this.
pub(super) const NEED_PREFIX: &str = "cg_need_";

/// Location posts per account.
pub(super) const LOCATION_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "common-ground-nearby-location",
    limit: 120,
    window: Duration::from_secs(60 * 60),
};
/// Request check runs queued per account.
pub(super) const CHECK_LIMIT: AccountActionLimit = AccountActionLimit {
    action: "common-ground-nearby-check",
    limit: 30,
    window: Duration::from_secs(60 * 60),
};

/// Timing, with the documented defaults. Each can be overridden with a
/// `KORDI_COMMON_GROUND_NEARBY_*` variable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NearbyConfig {
    /// How long a location counts as current
    /// (`KORDI_COMMON_GROUND_NEARBY_FRESH_SECONDS`, 1800).
    pub fresh_seconds: i64,
    /// Seconds between alert sweeps
    /// (`KORDI_COMMON_GROUND_NEARBY_SWEEP_SECONDS`, 30).
    pub sweep_seconds: u64,
}

impl Default for NearbyConfig {
    fn default() -> Self {
        Self {
            fresh_seconds: 1_800,
            sweep_seconds: 30,
        }
    }
}

impl NearbyConfig {
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let read = |key: &str, range: std::ops::RangeInclusive<i64>, default: i64| {
            lookup(key)
                .and_then(|value| value.trim().parse::<i64>().ok())
                .filter(|value| range.contains(value))
                .unwrap_or(default)
        };
        let defaults = Self::default();
        Self {
            fresh_seconds: read(
                "KORDI_COMMON_GROUND_NEARBY_FRESH_SECONDS",
                1..=86_400,
                defaults.fresh_seconds,
            ),
            sweep_seconds: read(
                "KORDI_COMMON_GROUND_NEARBY_SWEEP_SECONDS",
                1..=3_600,
                defaults.sweep_seconds as i64,
            ) as u64,
        }
    }
}

/// The server's settings, read from the environment once.
pub(super) fn config() -> NearbyConfig {
    static CONFIG: OnceLock<NearbyConfig> = OnceLock::new();
    *CONFIG.get_or_init(|| NearbyConfig::from_lookup(|key| std::env::var(key).ok()))
}

pub(super) fn routes() -> Router<Arc<ServerState>> {
    Router::new()
        .route(
            "/v1/cloud/common-ground/nearby",
            get(settings::read).put(settings::update),
        )
        .route(
            "/v1/cloud/common-ground/nearby/location",
            post(location::post).delete(location::delete),
        )
        .route("/v1/cloud/common-ground/nearby/people", get(search::search))
        .route(
            "/v1/cloud/common-ground/nearby/people/:account_id",
            get(person::read),
        )
        .route(
            "/v1/cloud/common-ground/nearby/needs",
            get(need_routes::list).post(need_routes::create),
        )
        .route(
            "/v1/cloud/common-ground/nearby/needs/:need_id",
            put(need_routes::update).delete(need_routes::delete),
        )
}

pub(super) fn off() -> Response {
    err(
        "common_ground_nearby_off",
        "Turn on Nearby to see people around you.",
        StatusCode::CONFLICT,
    )
}

pub(super) fn no_location() -> Response {
    err(
        "common_ground_nearby_no_location",
        "Your location isn't current.",
        StatusCode::CONFLICT,
    )
}

pub(super) fn invalid_settings(message: &str) -> Response {
    err(
        "common_ground_nearby_invalid_settings",
        message,
        StatusCode::UNPROCESSABLE_ENTITY,
    )
}

/// Marks an enabled account for the next alert sweep.
pub(super) async fn mark_dirty(
    tx: &mut Transaction<'_, Postgres>,
    account: &str,
) -> sqlx_core::Result<()> {
    query(
        "UPDATE cloud_common_ground_nearby SET dirty_at = COALESCE(dirty_at, now())
         WHERE account_id = $1 AND enabled",
    )
    .bind(account)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Tells the account's clients to refetch nearby settings or results.
pub(super) async fn updated(
    tx: &mut Transaction<'_, Postgres>,
    account: &str,
) -> sqlx_core::Result<()> {
    super::hint(tx, account, "common_ground.nearby.updated", json!({})).await
}

/// A match or request check for `account` finished: when the account
/// participates, the next sweep looks again and its clients refetch.
pub(super) async fn run_finished(
    tx: &mut Transaction<'_, Postgres>,
    account: &str,
) -> sqlx_core::Result<()> {
    let sql = format!(
        "UPDATE cloud_common_ground_nearby SET dirty_at = COALESCE(dirty_at, now())
         WHERE account_id = $1 AND {}",
        participation::participates_sql("$1")
    );
    let marked = query(&sql).bind(account).execute(&mut **tx).await?;
    if marked.rows_affected() > 0 {
        updated(tx, account).await?;
    }
    Ok(())
}

/// Invalidates pending alerts to or about the account.
pub(super) async fn invalidate_alerts(
    tx: &mut Transaction<'_, Postgres>,
    account: &str,
    reason: &str,
) -> sqlx_core::Result<()> {
    query(
        "UPDATE cloud_common_ground_nearby_alerts SET status = 'invalidated', reason = $2
         WHERE status = 'pending' AND (recipient_account_id = $1 OR other_account_id = $1)",
    )
    .bind(account)
    .bind(reason)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// One hint outside a transaction of its own; best effort.
pub(super) async fn notify(pool: &PgPool, account: &str) {
    let sent = async {
        let mut tx = pool.begin().await?;
        updated(&mut tx, account).await?;
        tx.commit().await
    }
    .await;
    if let Err(error) = sent {
        eprintln!("[common-ground] Could not send a nearby update: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_read_the_environment_within_bounds() {
        let config = NearbyConfig::from_lookup(|key| match key {
            "KORDI_COMMON_GROUND_NEARBY_FRESH_SECONDS" => Some("60".into()),
            "KORDI_COMMON_GROUND_NEARBY_SWEEP_SECONDS" => Some("0".into()),
            _ => None,
        });
        assert_eq!(
            config,
            NearbyConfig {
                fresh_seconds: 60,
                sweep_seconds: 30
            }
        );
        assert_eq!(NearbyConfig::from_lookup(|_| None), NearbyConfig::default());
    }
}
