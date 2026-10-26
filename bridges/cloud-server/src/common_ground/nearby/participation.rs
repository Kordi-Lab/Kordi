//! The one participation rule, evaluated live in SQL on every nearby path:
//! search, person, the actions' fallback, the alert queue and delivery.
//! Rooms and pairings are never consulted here.
//!
//! An account participates when its nearby row is enabled with consent, not
//! paused, and its chosen profile still belongs to it with a built, shared
//! card. It is present when it also has a fresh location from a device that
//! is not revoked; its location is its most recent fresh row.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sqlx_core::query_as::query_as;
use sqlx_postgres::{PgPool, Postgres};

use super::distance::{bounding_box, haversine_m, within, MAX_RANGE_M};
use super::evidence::Material;
use crate::common_ground::card::Topics;
use crate::common_ground::matching::SharedCard;

/// The tables of the participation rule: `nb` (settings), `profile` and
/// `card`.
const PARTICIPANTS: &str = "cloud_common_ground_nearby nb
    JOIN cloud_common_ground_profiles profile
      ON profile.profile_id = nb.profile_id AND profile.account_id = nb.account_id
    JOIN cloud_common_ground_cards card ON card.profile_id = profile.profile_id";

/// The participation rule over [`PARTICIPANTS`].
const PARTICIPATES: &str = "nb.enabled AND nb.consented_at IS NOT NULL
    AND (nb.paused_until IS NULL OR nb.paused_until <= now())
    AND card.built_at IS NOT NULL AND card.sharing_enabled";

/// What presence adds: the account, and a fresh location from a device that
/// is not revoked.
const PRESENT_JOINS: &str = "JOIN cloud_accounts account ON account.account_id = nb.account_id
    JOIN cloud_common_ground_nearby_locations loc
      ON loc.account_id = nb.account_id AND loc.fresh_until > now()
    JOIN cloud_devices device
      ON device.device_id = loc.device_id AND device.account_id = nb.account_id
         AND device.revoked_at IS NULL";

/// SQL that is true when the account in `account` (an SQL expression)
/// participates.
pub(in crate::common_ground) fn participates_sql(account: &str) -> String {
    format!(
        "EXISTS (SELECT 1 FROM {PARTICIPANTS} WHERE {PARTICIPATES} AND nb.account_id = {account})"
    )
}

/// Every present account, one row each at its most recent fresh location,
/// with the material others may see.
fn present_sql() -> String {
    format!(
        "SELECT DISTINCT ON (nb.account_id)
             nb.account_id, account.display_name,
             COALESCE(account.public_handle, account.public_account_number::TEXT), account.avatar_url,
             jsonb_build_object('profileId', profile.profile_id, 'kind', profile.kind,
                 'name', profile.name, 'design', profile.design, 'icon', profile.icon,
                 'focus', profile.focus),
             card.topics_json, card.hidden_json, card.revision, nb.open_to_json,
             loc.latitude, loc.longitude, loc.captured_at, loc.fresh_until
         FROM {PARTICIPANTS} {PRESENT_JOINS}
         WHERE {PARTICIPATES}
         ORDER BY nb.account_id, loc.captured_at DESC"
    )
}

type PresentRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Value,
    Value,
    Value,
    i64,
    Value,
    f64,
    f64,
    DateTime<Utc>,
    DateTime<Utc>,
);

/// The shared profile's fields, read as one JSON object.
#[derive(Debug, Default, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ProfileFields {
    profile_id: String,
    kind: String,
    name: String,
    design: Option<String>,
    icon: Option<String>,
    focus: Option<String>,
}

/// A present participant as nearby shows them. Coordinates stay on the
/// server: they are used for distances only.
#[derive(Debug, Clone)]
pub(super) struct Present {
    pub account_id: String,
    pub name: String,
    pub handle: Option<String>,
    pub avatar_url: Option<String>,
    pub profile_id: String,
    pub kind: String,
    pub profile_name: String,
    pub design: Option<String>,
    pub icon: Option<String>,
    pub focus: Option<String>,
    pub revision: i64,
    /// The four lists without hidden topics.
    pub topics: Topics,
    pub open_to: Vec<String>,
    latitude: f64,
    longitude: f64,
    pub captured_at: DateTime<Utc>,
    pub fresh_until: DateTime<Utc>,
    /// Meters from the viewer; zero for the viewer.
    pub distance_m: f64,
}

fn from_row(row: PresentRow) -> Present {
    let profile: ProfileFields = serde_json::from_value(row.4).unwrap_or_default();
    let topics: Topics = serde_json::from_value(row.5).unwrap_or_default();
    let hidden: Vec<String> = serde_json::from_value(row.6).unwrap_or_default();
    let keep = |list: &Vec<String>| -> Vec<String> {
        list.iter()
            .filter(|t| !hidden.contains(t))
            .cloned()
            .collect()
    };
    Present {
        account_id: row.0,
        name: crate::document_shares::access::clean_display_name(row.1.as_deref()),
        handle: row.2,
        avatar_url: row.3,
        profile_id: profile.profile_id,
        kind: profile.kind,
        profile_name: profile.name,
        design: profile.design,
        icon: profile.icon,
        focus: profile.focus,
        revision: row.7,
        topics: Topics {
            working_on: keep(&topics.working_on),
            interests: keep(&topics.interests),
            can_help: keep(&topics.can_help),
            looking_for: keep(&topics.looking_for),
            ..Topics::default()
        },
        open_to: serde_json::from_value(row.8).unwrap_or_default(),
        latitude: row.9,
        longitude: row.10,
        captured_at: row.11,
        fresh_until: row.12,
        distance_m: 0.0,
    }
}

impl Present {
    /// The meters between two present people.
    pub fn distance_to(&self, other: &Present) -> f64 {
        haversine_m(
            self.latitude,
            self.longitude,
            other.latitude,
            other.longitude,
        )
    }

    /// The card as matching reads it.
    pub fn shared_card(&self) -> SharedCard {
        SharedCard {
            account_id: self.account_id.clone(),
            profile_id: self.profile_id.clone(),
            profile_kind: self.kind.clone(),
            profile_name: self.profile_name.clone(),
            profile_design: self.design.clone(),
            profile_icon: self.icon.clone(),
            name: self.name.clone(),
            handle: self.handle.clone(),
            avatar_url: self.avatar_url.clone(),
            revision: self.revision,
            topics: self.topics.clone(),
        }
    }

    /// The person object with the profile they share through nearby.
    pub fn person(&self) -> Value {
        let mut person = crate::common_ground::people::person(
            &self.account_id,
            Some(&self.name),
            self.handle.as_deref(),
            self.avatar_url.as_deref(),
        );
        person["profile"] = crate::common_ground::profiles::tag(
            &self.profile_id,
            &self.kind,
            &self.profile_name,
            self.design.as_deref(),
            self.icon.as_deref(),
        );
        person
    }

    /// What the person shares, as a request check reads it.
    pub fn material(&self) -> Material {
        Material {
            profile_name: self.profile_name.clone(),
            focus: self.focus.clone(),
            topics: self.topics.clone(),
            open_to: self.open_to.clone(),
        }
    }

    /// `{capturedAt, freshUntil, fresh}` for the account's own location.
    pub fn location_view(&self) -> Value {
        json!({ "capturedAt": self.captured_at, "freshUntil": self.fresh_until, "fresh": true })
    }
}

/// Whether the account participates.
pub(in crate::common_ground) async fn participates<'e, E>(
    executor: E,
    account: &str,
) -> sqlx_core::Result<bool>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let sql = format!("SELECT {}", participates_sql("$1"));
    let (participates,): (bool,) = query_as(&sql).bind(account).fetch_one(executor).await?;
    Ok(participates)
}

/// The account when it is present.
pub(super) async fn present(pool: &PgPool, account: &str) -> sqlx_core::Result<Option<Present>> {
    let sql = format!(
        "SELECT * FROM ({}) present WHERE present.account_id = $1",
        present_sql()
    );
    let row: Option<PresentRow> = query_as(&sql).bind(account).fetch_optional(pool).await?;
    Ok(row.map(from_row))
}

/// Present people other than `viewer` within `range_m` of them, nearest
/// first, at most `limit`.
pub(super) async fn around(
    pool: &PgPool,
    viewer: &Present,
    range_m: i32,
    limit: i64,
) -> sqlx_core::Result<Vec<Present>> {
    let range_m = range_m.min(MAX_RANGE_M);
    let (dlat, dlon) = bounding_box(viewer.latitude, range_m);
    // The box is cheap; the haversine below decides. Longitude differences
    // wrap around the antimeridian.
    let sql = format!(
        "SELECT * FROM ({}) present
         WHERE present.account_id <> $1
           AND present.latitude BETWEEN $2 - $4 AND $2 + $4
           AND ($5 >= 360 OR LEAST(abs(present.longitude - $3), 360 - abs(present.longitude - $3)) <= $5)
         ORDER BY power(present.latitude - $2, 2)
                + power(LEAST(abs(present.longitude - $3), 360 - abs(present.longitude - $3))
                        * cos(radians($2)), 2),
                  present.account_id
         LIMIT $6",
        present_sql()
    );
    let rows: Vec<PresentRow> = query_as(&sql)
        .bind(&viewer.account_id)
        .bind(viewer.latitude)
        .bind(viewer.longitude)
        .bind(dlat)
        .bind(dlon)
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(from_row)
        .filter_map(|mut person| {
            person.distance_m = viewer.distance_to(&person);
            within(person.distance_m, range_m).then_some(person)
        })
        .collect())
}

/// Both present and within the farthest range: the pair rule. Returns
/// (viewer, other) with the other's distance set.
pub(super) async fn pair(
    pool: &PgPool,
    viewer: &str,
    other: &str,
) -> sqlx_core::Result<Option<(Present, Present)>> {
    if viewer == other {
        return Ok(None);
    }
    let (Some(mine), Some(mut theirs)) =
        (present(pool, viewer).await?, present(pool, other).await?)
    else {
        return Ok(None);
    };
    theirs.distance_m = mine.distance_to(&theirs);
    Ok(within(theirs.distance_m, MAX_RANGE_M).then_some((mine, theirs)))
}

/// Whether `viewer` sees `other` through nearby right now.
pub(in crate::common_ground) async fn visible(
    pool: &PgPool,
    viewer: &str,
    other: &str,
) -> sqlx_core::Result<bool> {
    Ok(pair(pool, viewer, other).await?.is_some())
}
