//! Meeting activities saved for each card. The active Nearby row remains the
//! projection used by search, alerts, and older clients.

use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::Postgres;

pub(super) async fn load(
    tx: &mut Transaction<'_, Postgres>,
    profile_id: &str,
) -> sqlx_core::Result<Vec<String>> {
    let row: Option<(Value,)> = query_as(
        "SELECT open_to_json FROM cloud_common_ground_nearby_profile_preferences WHERE profile_id = $1",
    )
    .bind(profile_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row
        .and_then(|(value,)| serde_json::from_value(value).ok())
        .unwrap_or_default())
}

pub(super) async fn save(
    tx: &mut Transaction<'_, Postgres>,
    profile_id: &str,
    activities: &[String],
) -> sqlx_core::Result<()> {
    query(
        "INSERT INTO cloud_common_ground_nearby_profile_preferences (profile_id, open_to_json)
         VALUES ($1, $2) ON CONFLICT (profile_id) DO UPDATE
         SET open_to_json = EXCLUDED.open_to_json, updated_at = now()",
    )
    .bind(profile_id)
    .bind(json!(activities))
    .execute(&mut **tx)
    .await?;
    Ok(())
}
