//! Profiles: a person keeps up to five cards, one per profile. Fixed kinds
//! (work, health, daily tasks) appear at most once; custom profiles carry
//! their own name ("KAUST", "MIT"). Each profile's card is built through its
//! lens, and every room membership and pairing shares exactly one profile.

mod routes;
mod sources;

pub(super) use routes::{create, delete, list, memories, update};
pub(super) use sources::{SourcePicks, MAX_DOCUMENTS};

use axum::{http::StatusCode, response::Response};
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx_core::{query::query, query_as::query_as, transaction::Transaction};
use sqlx_postgres::{PgPool, Postgres};
use uuid::Uuid;

use super::{card, db_error, err};
use crate::memory_store::ProfileTarget;

pub(super) const MAX_PROFILES: i64 = 5;
pub(super) const MAX_NAME_CHARS: usize = 40;
pub(super) const MAX_FOCUS_CHARS: usize = 200;
pub(super) const KINDS: [&str; 4] = ["work", "health", "daily", "custom"];
/// Card designs the apps draw: the kind designs, then plain colours. A
/// profile without one uses its kind's.
pub(super) const DESIGNS: [&str; 16] = [
    "work", "health", "daily", "workshop", "research", "custom", "ocean", "sky", "rose", "coral",
    "amber", "forest", "lavender", "graphite", "mint", "olive",
];
/// Icons the apps draw on a card; a profile without one shows none.
pub(super) const ICONS: [&str; 18] = [
    "briefcase",
    "leaf",
    "sun",
    "flask",
    "book",
    "microscope",
    "graduation",
    "pin",
    "star",
    "heart",
    "chat",
    "globe",
    "music",
    "camera",
    "code",
    "calendar",
    "rocket",
    "coffee",
];

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Profile {
    pub profile_id: String,
    pub account_id: String,
    pub kind: String,
    pub name: String,
    pub focus: Option<String>,
    pub position: i32,
    pub design: Option<String>,
    pub icon: Option<String>,
    /// The owner's saved source picks; `None` until first saved.
    pub sources: Option<SourcePicks>,
}

type ProfileRow = (
    String,
    String,
    String,
    String,
    Option<String>,
    i32,
    Option<String>,
    Option<String>,
    Option<Value>,
);

const COLUMNS: &str =
    "profile_id, account_id, kind, name, focus, position, design, icon, sources_json";

fn from_row(
    (profile_id, account_id, kind, name, focus, position, design, icon, sources): ProfileRow,
) -> Profile {
    Profile {
        profile_id,
        account_id,
        kind,
        name,
        focus,
        position,
        design,
        icon,
        sources: sources.and_then(|value| serde_json::from_value(value).ok()),
    }
}

impl Profile {
    /// The profile memories are routed to.
    pub fn memory_target(&self) -> ProfileTarget<'_> {
        ProfileTarget {
            profile_id: Some(&self.profile_id),
            kind: &self.kind,
        }
    }

    /// `{profileId, kind, name, focus, design, icon, sources}` for the owner
    /// only: never put it in a view others see (use [`tag`]).
    pub fn summary(&self) -> Value {
        json!({
            "profileId": self.profile_id,
            "kind": self.kind,
            "name": self.name,
            "focus": self.focus,
            "design": self.design,
            "icon": self.icon,
            "sources": self.sources,
        })
    }
}

/// `{profileId, kind, name, design, icon}`: the profile someone shared with
/// you.
pub(super) fn tag(
    profile_id: &str,
    kind: &str,
    name: &str,
    design: Option<&str>,
    icon: Option<&str>,
) -> Value {
    json!({ "profileId": profile_id, "kind": kind, "name": name, "design": design, "icon": icon })
}

/// The default name of a fixed kind.
pub(super) fn default_name(kind: &str) -> Option<&'static str> {
    match kind {
        "work" => Some("Work"),
        "health" => Some("Health"),
        "daily" => Some("Daily tasks"),
        _ => None,
    }
}

pub(super) fn valid_kind(kind: &str) -> bool {
    KINDS.contains(&kind)
}

pub(super) fn valid_design(design: &str) -> bool {
    DESIGNS.contains(&design)
}

pub(super) fn valid_icon(icon: &str) -> bool {
    ICONS.contains(&icon)
}

/// The account's profile with this id.
pub(super) async fn get<'e, E>(
    executor: E,
    account: &str,
    profile_id: &str,
) -> sqlx_core::Result<Option<Profile>>
where
    E: sqlx_core::executor::Executor<'e, Database = Postgres>,
{
    let sql = format!(
        "SELECT {COLUMNS} FROM cloud_common_ground_profiles WHERE account_id = $1 AND profile_id = $2"
    );
    let row: Option<ProfileRow> = query_as(&sql)
        .bind(account)
        .bind(profile_id)
        .fetch_optional(executor)
        .await?;
    Ok(row.map(from_row))
}

/// The work profile if there is one, else the first by position.
pub(super) async fn default_profile(
    pool: &PgPool,
    account: &str,
) -> sqlx_core::Result<Option<Profile>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM cloud_common_ground_profiles WHERE account_id = $1
         ORDER BY kind = 'work' DESC, position LIMIT 1"
    );
    let row: Option<ProfileRow> = query_as(&sql).bind(account).fetch_optional(pool).await?;
    Ok(row.map(from_row))
}

pub(super) fn not_found() -> Response {
    err(
        "common_ground_profile_not_found",
        "Profile not found.",
        StatusCode::NOT_FOUND,
    )
}

/// The profile a request names, or the account's default when it names
/// none. `Ok(None)` when the account has no profile yet.
pub(super) async fn resolve(
    pool: &PgPool,
    account: &str,
    requested: Option<&str>,
) -> Result<Option<Profile>, Box<Response>> {
    let requested = requested.map(str::trim).filter(|id| !id.is_empty());
    let found = match requested {
        Some(id) => match get(pool, account, id).await {
            Ok(Some(profile)) => Ok(Some(profile)),
            Ok(None) => return Err(Box::new(not_found())),
            Err(error) => Err(error),
        },
        None => default_profile(pool, account).await,
    };
    found.map_err(|error| Box::new(db_error(error)))
}

/// Like [`resolve`], but creates the work profile for an account that has
/// none, so clients that never send profile ids keep working.
pub(super) async fn resolve_or_create(
    pool: &PgPool,
    account: &str,
    requested: Option<&str>,
) -> Result<Profile, Box<Response>> {
    if let Some(profile) = resolve(pool, account, requested).await? {
        return Ok(profile);
    }
    let created = async {
        let mut tx = pool.begin().await?;
        let profile = insert(&mut tx, account, "work", None, None, None, None).await?;
        tx.commit().await?;
        Ok::<_, sqlx_core::Error>(profile)
    }
    .await;
    match created {
        Ok(Ok(profile)) => Ok(profile),
        // Another request created one first.
        Ok(Err(_)) => match resolve(pool, account, None).await? {
            Some(profile) => Ok(profile),
            None => Err(Box::new(not_found())),
        },
        Err(error) => Err(Box::new(db_error(error))),
    }
}

/// Why a profile could not be created.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Refused {
    TooMany,
    Exists,
}

impl Refused {
    pub fn response(self) -> Response {
        match self {
            Refused::TooMany => err(
                "common_ground_too_many_profiles",
                "You can have up to 5 profiles.",
                StatusCode::CONFLICT,
            ),
            Refused::Exists => err(
                "common_ground_profile_exists",
                "You already have this profile.",
                StatusCode::CONFLICT,
            ),
        }
    }
}

/// Creates a profile under the account's lock. `name` defaults to the
/// kind's name; the caller checks that a custom profile has one.
pub(super) async fn insert(
    tx: &mut Transaction<'_, Postgres>,
    account: &str,
    kind: &str,
    name: Option<&str>,
    focus: Option<&str>,
    design: Option<&str>,
    icon: Option<&str>,
) -> sqlx_core::Result<Result<Profile, Refused>> {
    query("SELECT pg_advisory_xact_lock(hashtext('common-ground-profiles:' || $1))")
        .bind(account)
        .execute(&mut **tx)
        .await?;
    let (count, same_kind, next): (i64, i64, i32) = query_as(
        "SELECT COUNT(*), COUNT(*) FILTER (WHERE kind = $2), COALESCE(MAX(position) + 1, 0)
         FROM cloud_common_ground_profiles WHERE account_id = $1",
    )
    .bind(account)
    .bind(kind)
    .fetch_one(&mut **tx)
    .await?;
    if count >= MAX_PROFILES {
        return Ok(Err(Refused::TooMany));
    }
    if kind != "custom" && same_kind > 0 {
        return Ok(Err(Refused::Exists));
    }
    let name = name
        .filter(|name| !name.is_empty())
        .or_else(|| default_name(kind))
        .unwrap_or("Profile")
        .to_string();
    let profile = Profile {
        profile_id: format!("cgp_{}", Uuid::new_v4().simple()),
        account_id: account.to_string(),
        kind: kind.to_string(),
        name,
        focus: focus.filter(|focus| !focus.is_empty()).map(str::to_string),
        position: next,
        design: design.map(str::to_string),
        icon: icon.map(str::to_string),
        sources: None,
    };
    query(
        "INSERT INTO cloud_common_ground_profiles
             (profile_id, account_id, kind, name, focus, position, design, icon)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(&profile.profile_id)
    .bind(account)
    .bind(&profile.kind)
    .bind(&profile.name)
    .bind(&profile.focus)
    .bind(profile.position)
    .bind(&profile.design)
    .bind(&profile.icon)
    .execute(&mut **tx)
    .await?;
    Ok(Ok(profile))
}

/// The response to send instead when `profile` has no shared card.
pub(super) async fn require_shared_card(pool: &PgPool, profile: &Profile) -> Option<Response> {
    match card::load(pool, &profile.profile_id).await {
        Ok(Some(row)) if row.has_card() && row.sharing => None,
        Ok(Some(row)) if row.has_card() => Some(super::sharing_off()),
        Ok(_) => Some(card::no_card()),
        Err(error) => Some(db_error(error)),
    }
}

/// The account's first profile of `kind` with a built card, for preselecting
/// the profile a room or pairing suggests.
pub(super) async fn built_of_kind(
    pool: &PgPool,
    account: &str,
    kind: &str,
) -> sqlx_core::Result<Option<Profile>> {
    let sql = format!(
        "SELECT {} FROM cloud_common_ground_profiles profile
         JOIN cloud_common_ground_cards card ON card.profile_id = profile.profile_id
         WHERE profile.account_id = $1 AND profile.kind = $2 AND card.built_at IS NOT NULL
         ORDER BY profile.position LIMIT 1",
        COLUMNS
            .split(", ")
            .map(|column| format!("profile.{column}"))
            .collect::<Vec<_>>()
            .join(", ")
    );
    let row: Option<ProfileRow> = query_as(&sql)
        .bind(account)
        .bind(kind)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(from_row))
}

/// Picks the profile to share where a room or pairing suggests `kind`: the
/// explicit choice, else the account's built profile of that kind, else the
/// default.
pub(super) async fn choose(
    pool: &PgPool,
    account: &str,
    requested: Option<&str>,
    suggested_kind: Option<&str>,
) -> Result<Option<Profile>, Box<Response>> {
    if requested.is_some_and(|id| !id.trim().is_empty()) {
        return resolve(pool, account, requested).await;
    }
    if let Some(kind) = suggested_kind {
        match built_of_kind(pool, account, kind).await {
            Ok(Some(profile)) => return Ok(Some(profile)),
            Ok(None) => {}
            Err(error) => return Err(Box::new(db_error(error))),
        }
    }
    resolve(pool, account, None).await
}

/// Collapses whitespace in a name or focus line.
pub(super) fn collapse(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A `?profile=` query parameter.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub(super) struct ProfileQuery {
    pub profile: Option<String>,
}

#[cfg(test)]
pub(super) fn for_tests(kind: &str, name: &str, focus: Option<&str>) -> Profile {
    Profile {
        profile_id: "cgp_test".into(),
        account_id: "acct_test".into(),
        kind: kind.into(),
        name: name.into(),
        focus: focus.map(str::to_string),
        position: 0,
        design: None,
        icon: None,
        sources: None,
    }
}
