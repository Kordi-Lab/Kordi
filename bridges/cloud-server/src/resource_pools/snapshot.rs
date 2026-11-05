//! Usage snapshots: how much of each daily limit is used, when it resets and
//! whether it was reached, in one shape for every client.
//!
//! The math is pure so every case is unit tested; [`load`] reads the
//! counters [`super::usage`] keeps. Owners and admins of an organization see
//! counts and spend; everyone else sees only percentages and reset times
//! (see [`for_role`]).

use chrono::{DateTime, NaiveDate, Utc};
use serde::Serialize;
use sqlx_core::query_as::query_as;
use sqlx_postgres::PgPool;

use super::usage::{POOL_FEATURE, POOL_SCOPE};
use super::{Feature, ResourcePool};
use crate::organizations::OrganizationRole;

/// The only window daily limits use.
pub const WINDOW_DAY: &str = "day";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Pool,
    Conversation,
    Account,
}

/// Why a limit admits nothing more in this window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reached {
    None,
    DailyLimit,
    SpendLimit,
    Stopped,
}

impl Reached {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::DailyLimit => "daily_limit",
            Self::SpendLimit => "spend_limit",
            Self::Stopped => "stopped",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "daily_limit" => Some(Self::DailyLimit),
            "spend_limit" => Some(Self::SpendLimit),
            "stopped" => Some(Self::Stopped),
            _ => None,
        }
    }
}

/// One limit as a client shows it. `used` and `limit` are run counts, or
/// millionths of the pool's currency for the spend limit; they are left out
/// for callers who may only see percentages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub limit_id: &'static str,
    pub scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub used: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    pub used_percent: u8,
    pub window: &'static str,
    pub resets_at: String,
    pub reached: Reached,
}

/// Runs and spend counted for one scope on one day.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Counter {
    pub runs: u64,
    pub spend_micros: u64,
}

/// The limit a caller is counted under besides the pool's: a conversation's
/// System agent passes, or a person's Grounding runs.
#[derive(Debug, Clone, Copy)]
pub struct Scoped {
    pub feature: Feature,
    pub counter: Counter,
}

/// When the window that contains `now` ends: the next UTC midnight.
pub fn resets_at(now: DateTime<Utc>) -> DateTime<Utc> {
    (now.date_naive() + chrono::Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .expect("midnight exists")
        .and_utc()
}

/// The percentage of `limit` used, rounded down and capped at 100. A zero
/// limit is fully used.
pub fn used_percent(used: u64, limit: u64) -> u8 {
    if limit == 0 {
        return 100;
    }
    let percent = (u128::from(used) * 100 / u128::from(limit)).min(100);
    percent as u8
}

/// Every limited counter of `pool` that applies, as of `now`. Unlimited
/// limits have nothing to show and are left out; a stopped pool with no
/// limit still yields one pool snapshot, so clients can say why it is quiet.
pub fn build(
    pool: &ResourcePool,
    scoped: Option<Scoped>,
    pool_counter: Counter,
    now: DateTime<Utc>,
) -> Vec<UsageSnapshot> {
    let resets = resets_at(now).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let stopped = pool.is_stopped();
    let limits = pool.limits();
    let snapshot = |limit_id, scope, used: u64, limit: u64, reached: bool, why| UsageSnapshot {
        limit_id,
        scope,
        used: Some(used),
        limit: Some(limit),
        used_percent: used_percent(used, limit),
        window: WINDOW_DAY,
        resets_at: resets.clone(),
        reached: if stopped {
            Reached::Stopped
        } else if reached {
            why
        } else {
            Reached::None
        },
    };
    let mut snapshots = Vec::new();
    if let Some(Scoped { feature, counter }) = scoped {
        if let Some(limit) = limits.per_scope(feature).map(u64::from) {
            let (limit_id, scope) = match feature {
                Feature::SystemAgent => ("conversation.system_agent_runs", Scope::Conversation),
                Feature::Grounding => ("account.grounding_runs", Scope::Account),
            };
            snapshots.push(snapshot(
                limit_id,
                scope,
                counter.runs,
                limit,
                counter.runs >= limit,
                Reached::DailyLimit,
            ));
        }
    }
    if let Some(limit) = limits.pool_runs {
        snapshots.push(snapshot(
            "pool.runs",
            Scope::Pool,
            pool_counter.runs,
            limit,
            pool_counter.runs >= limit,
            Reached::DailyLimit,
        ));
    }
    if let Some(limit) = limits.pool_spend_micros {
        // Admission refuses a run whose estimated cost would pass the
        // ceiling, so the limit is reached once the next run cannot fit.
        let feature = scoped.map_or(Feature::SystemAgent, |scoped| scoped.feature);
        let cost = pool.provider(feature).estimated_cost_micros();
        let next = pool_counter.spend_micros.saturating_add(cost);
        snapshots.push(snapshot(
            "pool.spend",
            Scope::Pool,
            pool_counter.spend_micros,
            limit,
            next > limit,
            Reached::SpendLimit,
        ));
    }
    if snapshots.is_empty() && stopped {
        snapshots.push(UsageSnapshot {
            limit_id: "pool.stopped",
            scope: Scope::Pool,
            used: None,
            limit: None,
            used_percent: 100,
            window: WINDOW_DAY,
            resets_at: resets,
            reached: Reached::Stopped,
        });
    }
    snapshots
}

/// Whether `role` may see counts, spend and limits rather than percentages.
pub fn sees_amounts(role: Option<OrganizationRole>) -> bool {
    matches!(
        role,
        Some(OrganizationRole::Owner | OrganizationRole::Admin)
    )
}

/// The snapshots as `role` may see them: members, and people outside the
/// organization, get percentages, reset times and reasons only.
pub fn for_role(
    snapshots: Vec<UsageSnapshot>,
    role: Option<OrganizationRole>,
) -> Vec<UsageSnapshot> {
    if sees_amounts(role) {
        return snapshots;
    }
    snapshots
        .into_iter()
        .map(|snapshot| UsageSnapshot {
            used: None,
            limit: None,
            ..snapshot
        })
        .collect()
}

/// The first limit that admits nothing more, in the order a pass is
/// admitted: its own scope first, then the pool.
pub fn first_reached(snapshots: &[UsageSnapshot]) -> Reached {
    snapshots
        .iter()
        .map(|snapshot| snapshot.reached)
        .find(|reached| *reached != Reached::None)
        .unwrap_or(Reached::None)
}

/// The counter of one scope of a pool on `day`; zero when nothing was
/// counted. `feature` `None` reads the whole pool.
pub async fn counter(
    db: &PgPool,
    pool_id: &str,
    day: NaiveDate,
    feature: Option<Feature>,
    scope_id: &str,
) -> sqlx_core::Result<Counter> {
    let (feature, scope_id) = match feature {
        Some(feature) => (feature.as_str(), scope_id),
        None => (POOL_FEATURE, POOL_SCOPE),
    };
    let row: Option<(i64, i64)> = query_as(
        "SELECT runs, spend_micros FROM cloud_resource_pool_usage
         WHERE pool_id = $1 AND usage_day = $2 AND feature = $3 AND scope_id = $4",
    )
    .bind(pool_id)
    .bind(day)
    .bind(feature)
    .bind(scope_id)
    .fetch_optional(db)
    .await?;
    let (runs, spend) = row.unwrap_or_default();
    Ok(Counter {
        runs: u64::try_from(runs).unwrap_or(0),
        spend_micros: u64::try_from(spend).unwrap_or(0),
    })
}

/// Reads the counters for `pool` as of `now` and builds its snapshots, with
/// `scope` naming the conversation or person counted under `feature`.
pub async fn load(
    db: &PgPool,
    pool: &ResourcePool,
    scope: Option<(Feature, &str)>,
    now: DateTime<Utc>,
) -> sqlx_core::Result<Vec<UsageSnapshot>> {
    let day = now.date_naive();
    let scoped = match scope {
        Some((feature, scope_id)) => Some(Scoped {
            feature,
            counter: counter(db, pool.id(), day, Some(feature), scope_id).await?,
        }),
        None => None,
    };
    let pool_counter = counter(db, pool.id(), day, None, "").await?;
    Ok(build(pool, scoped, pool_counter, now))
}

#[cfg(test)]
#[path = "snapshot_tests.rs"]
mod tests;
