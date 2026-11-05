//! Members' personal work served by an organization's pool.
//!
//! An organization of the organizations file may set
//! `coversMembersPersonalWork`. Its pool then also serves work charged to a
//! member's personal organization: System agent passes in conversations of
//! that personal organization, and the member's own Grounding runs. Coverage
//! follows the personal organization's owner, and only while that person is
//! a current member (`expires_at IS NULL OR expires_at > now()`, the rule of
//! `cloud_is_organization_member`). When the owner belongs to several
//! covering organizations, the one they joined first serves (ties by
//! organization id).
//!
//! A covering pool that cannot serve right now (stopped, or a `pool_worker`
//! pool whose worker has not asked any replica for a run within
//! [`WORKER_SEEN_WINDOW`]; see [`super::sightings`])
//! is skipped for the next covering organization, then the default pool, so
//! members are never left without replies. Work of the covering
//! organization's own conversations is routed as before, without that
//! fallback. A covering pool's daily limits count covered runs like any
//! other; a used-up limit is not a reason to fall back.

use std::time::Duration;

use sqlx_core::query_scalar::query_scalar;
use sqlx_postgres::PgConnection;

pub use super::sightings::WorkerSightings;
use super::{Executor, ResourcePool, ResourcePools};

/// A pool worker that asked for a run this recently counts as running.
pub const WORKER_SEEN_WINDOW: Duration = Duration::from_secs(120);

impl ResourcePools {
    /// Marks `organizations` as covering their members' personal work. Only
    /// those bound to a pool and not disabled take effect.
    pub fn with_covering(mut self, organizations: impl IntoIterator<Item = String>) -> Self {
        self.covering.extend(organizations);
        self
    }

    /// Covering organizations that may serve work now: bound and admitted.
    pub(crate) fn covering_organizations(&self) -> Vec<String> {
        self.covering
            .iter()
            .filter(|id| self.bindings.contains_key(*id) && self.admits(Some(id)))
            .cloned()
            .collect()
    }
}

/// Whether `pool` can take a run now: not stopped, and for a pool worker
/// pool, its worker was seen recently.
pub async fn available(
    conn: &mut PgConnection,
    pool: &ResourcePool,
    sightings: &WorkerSightings,
) -> sqlx_core::Result<bool> {
    if pool.is_stopped() {
        return Ok(false);
    }
    if pool.executor() == Executor::ControlPlane {
        return Ok(true);
    }
    sightings
        .seen_within(conn, pool.id(), WORKER_SEEN_WINDOW)
        .await
}

/// The pools of the covering organizations that the owner of the personal
/// organization `organization_id` currently belongs to, first joined first.
/// Empty for a team organization, an organization with its own binding, a
/// disabled one, or when no organization covers personal work.
pub async fn covering_pools<'a>(
    conn: &mut PgConnection,
    pools: &'a ResourcePools,
    organization_id: Option<&str>,
) -> sqlx_core::Result<Vec<&'a ResourcePool>> {
    let Some(organization_id) = organization_id else {
        return Ok(Vec::new());
    };
    if pools.bindings.contains_key(organization_id) || !pools.admits(Some(organization_id)) {
        return Ok(Vec::new());
    }
    let covering = pools.covering_organizations();
    if covering.is_empty() {
        return Ok(Vec::new());
    }
    let memberships: Vec<String> = query_scalar(
        "SELECT member.organization_id
         FROM cloud_organizations personal
         JOIN cloud_organization_members member
           ON member.account_id = personal.personal_account_id
         WHERE personal.organization_id = $1 AND personal.kind = 'personal'
           AND member.organization_id = ANY($2)
           AND (member.expires_at IS NULL OR member.expires_at > now())
         ORDER BY member.joined_at, member.organization_id",
    )
    .bind(organization_id)
    .bind(&covering)
    .fetch_all(conn)
    .await?;
    Ok(memberships
        .iter()
        .filter_map(|id| pools.bindings.get(id).map(|&index| &pools.pools[index]))
        .collect())
}

/// The pool that serves work charged to `organization_id`: the first
/// available covering pool of a personal organization's owner, else the
/// organization's own pool (its binding or the default pool).
pub async fn route(
    conn: &mut PgConnection,
    pools: &ResourcePools,
    sightings: &WorkerSightings,
    organization_id: Option<&str>,
) -> sqlx_core::Result<ResourcePool> {
    for pool in covering_pools(&mut *conn, pools, organization_id).await? {
        if available(&mut *conn, pool, sightings).await? {
            return Ok(pool.clone());
        }
    }
    Ok(pools.resolve(organization_id).clone())
}

/// Whether `pool_id` may still serve a run charged to `organization_id`:
/// it is the organization's own pool, or a pool that still covers the
/// personal organization's owner. Availability is not checked: the caller
/// is the pool's worker.
pub async fn serves(
    conn: &mut PgConnection,
    pools: &ResourcePools,
    organization_id: Option<&str>,
    pool_id: &str,
) -> sqlx_core::Result<bool> {
    if pools.resolve(organization_id).id() == pool_id {
        return Ok(true);
    }
    let covering = covering_pools(conn, pools, organization_id).await?;
    Ok(covering.iter().any(|pool| pool.id() == pool_id))
}

#[cfg(test)]
#[path = "coverage_tests.rs"]
pub(crate) mod tests;
