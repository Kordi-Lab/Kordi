//! `POST|DELETE /v1/cloud/common-ground/nearby/location`, and the cleanup
//! that sign-out and device revocation run. A location is stored per device,
//! rounded to 3 decimals, and is never logged or returned to others.

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{DateTime, Duration, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};

use super::distance::round3;
use super::{config, mark_dirty, notify, off, participation, LOCATION_LIMIT};
use crate::auth::rate_limit::{CloudRateLimiter, RateLimitDecision};
use crate::common_ground::{db_error, err, limited};
use crate::{auth::routes::CloudSession, server::ServerState};

/// A location older than this when it arrives is refused.
const MAX_AGE_SECONDS: i64 = 10 * 60;
/// Clock skew allowed for a location from the future.
const MAX_AHEAD_SECONDS: i64 = 60;
/// Accuracy worse than this is refused.
const MAX_ACCURACY_M: f64 = 2_000.0;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocationBody {
    latitude: f64,
    longitude: f64,
    /// Horizontal accuracy in meters.
    accuracy: f64,
    captured_at: DateTime<Utc>,
}

fn invalid_location() -> Response {
    err(
        "common_ground_nearby_invalid_location",
        "This location can't be used.",
        StatusCode::UNPROCESSABLE_ENTITY,
    )
}

fn inaccurate() -> Response {
    err(
        "common_ground_nearby_inaccurate",
        "Your location isn't precise enough.",
        StatusCode::UNPROCESSABLE_ENTITY,
    )
}

/// Why a location is refused, before anything is stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Refusal {
    Invalid,
    Inaccurate,
}

fn check(body: &LocationBody, now: DateTime<Utc>) -> Result<(), Refusal> {
    let in_range = body.latitude.is_finite()
        && body.longitude.is_finite()
        && (-90.0..=90.0).contains(&body.latitude)
        && (-180.0..=180.0).contains(&body.longitude);
    let timely = body.captured_at >= now - Duration::seconds(MAX_AGE_SECONDS)
        && body.captured_at <= now + Duration::seconds(MAX_AHEAD_SECONDS);
    if !in_range || !timely {
        return Err(Refusal::Invalid);
    }
    if !body.accuracy.is_finite() || body.accuracy < 0.0 || body.accuracy > MAX_ACCURACY_M {
        return Err(Refusal::Inaccurate);
    }
    Ok(())
}

/// `POST /v1/cloud/common-ground/nearby/location`: the calling device's
/// location, from a participating account.
pub(super) async fn post(
    State(state): State<Arc<ServerState>>,
    Extension(rate_limiter): Extension<Arc<CloudRateLimiter>>,
    Extension(session): Extension<CloudSession>,
    Json(body): Json<Value>,
) -> Response {
    let pool = state.db_pool();
    let account = session.account_id.as_str();
    match participation::participates(pool, account).await {
        Ok(true) => {}
        Ok(false) => return off(),
        Err(error) => return db_error(error),
    }
    if let RateLimitDecision::Limited { retry_after } = rate_limiter
        .observe_account_limit(LOCATION_LIMIT, account)
        .await
    {
        return limited(retry_after);
    }
    let Ok(body) = serde_json::from_value::<LocationBody>(body) else {
        return invalid_location();
    };
    match check(&body, Utc::now()) {
        Ok(()) => {}
        Err(Refusal::Invalid) => return invalid_location(),
        Err(Refusal::Inaccurate) => return inaccurate(),
    }
    let fresh_until = body.captured_at + Duration::seconds(config().fresh_seconds);
    let stored = async {
        let mut tx = pool.begin().await?;
        // A location that arrives after a newer one from the same device
        // does not replace it.
        query(
            "INSERT INTO cloud_common_ground_nearby_locations
                 (device_id, account_id, latitude, longitude, accuracy_m, captured_at, fresh_until)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (device_id) DO UPDATE SET account_id = EXCLUDED.account_id,
                 latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
                 accuracy_m = EXCLUDED.accuracy_m, captured_at = EXCLUDED.captured_at,
                 fresh_until = EXCLUDED.fresh_until, received_at = now()
             WHERE cloud_common_ground_nearby_locations.captured_at <= EXCLUDED.captured_at",
        )
        .bind(&session.device_id)
        .bind(account)
        .bind(round3(body.latitude))
        .bind(round3(body.longitude))
        .bind(body.accuracy.round())
        .bind(body.captured_at)
        .bind(fresh_until)
        .execute(&mut *tx)
        .await?;
        let row: (DateTime<Utc>, DateTime<Utc>, bool) = query_as(
            "SELECT captured_at, fresh_until, fresh_until > now()
             FROM cloud_common_ground_nearby_locations WHERE device_id = $1",
        )
        .bind(&session.device_id)
        .fetch_one(&mut *tx)
        .await?;
        mark_dirty(&mut tx, account).await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(row)
    }
    .await;
    match stored {
        Ok((captured_at, fresh_until, fresh)) => (
            StatusCode::OK,
            Json(json!({
                "location": { "capturedAt": captured_at, "freshUntil": fresh_until, "fresh": fresh },
            })),
        )
            .into_response(),
        Err(error) => db_error(error),
    }
}

/// `DELETE /v1/cloud/common-ground/nearby/location`: forgets the calling
/// device's location.
pub(super) async fn delete(
    State(state): State<Arc<ServerState>>,
    Extension(session): Extension<CloudSession>,
) -> Response {
    let pool = state.db_pool();
    match forget(pool, &session.device_id).await {
        Ok(()) => {
            notify(pool, &session.account_id).await;
            StatusCode::NO_CONTENT.into_response()
        }
        Err(error) => db_error(error),
    }
}

async fn forget(pool: &PgPool, device_id: &str) -> sqlx_core::Result<()> {
    query("DELETE FROM cloud_common_ground_nearby_locations WHERE device_id = $1")
        .bind(device_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Sign-out: forgets the session's device location. Best effort; a location
/// that stays goes stale within the freshness window.
pub(crate) async fn forget_device(pool: &PgPool, device_id: &str) {
    if let Err(error) = forget(pool, device_id).await {
        eprintln!("[common-ground] Could not forget a nearby location at sign-out: {error}");
    }
}

/// Device revocation: forgets the revoked devices' locations in the same
/// transaction.
pub(crate) async fn forget_devices(
    tx: &mut Transaction<'_, Postgres>,
    device_ids: &[String],
) -> sqlx_core::Result<()> {
    query("DELETE FROM cloud_common_ground_nearby_locations WHERE device_id = ANY($1)")
        .bind(device_ids)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(
        latitude: f64,
        longitude: f64,
        accuracy: f64,
        captured_at: DateTime<Utc>,
    ) -> LocationBody {
        LocationBody {
            latitude,
            longitude,
            accuracy,
            captured_at,
        }
    }

    #[test]
    fn locations_are_checked_before_storing() {
        let now = Utc::now();
        assert_eq!(check(&at(31.23, 121.47, 50.0, now), now), Ok(()));
        assert_eq!(check(&at(90.0, -180.0, 2_000.0, now), now), Ok(()));
        let old = now - Duration::seconds(MAX_AGE_SECONDS + 1);
        let ahead = now + Duration::seconds(MAX_AHEAD_SECONDS + 1);
        for (body, refusal) in [
            (at(90.1, 0.0, 10.0, now), Refusal::Invalid),
            (at(0.0, 180.5, 10.0, now), Refusal::Invalid),
            (at(f64::NAN, 0.0, 10.0, now), Refusal::Invalid),
            (at(0.0, 0.0, 10.0, old), Refusal::Invalid),
            (at(0.0, 0.0, 10.0, ahead), Refusal::Invalid),
            (at(0.0, 0.0, 2_000.5, now), Refusal::Inaccurate),
            (at(0.0, 0.0, -1.0, now), Refusal::Inaccurate),
        ] {
            assert_eq!(check(&body, now), Err(refusal));
        }
        let edge = now - Duration::seconds(MAX_AGE_SECONDS);
        assert_eq!(check(&at(0.0, 0.0, 10.0, edge), now), Ok(()));
    }
}
