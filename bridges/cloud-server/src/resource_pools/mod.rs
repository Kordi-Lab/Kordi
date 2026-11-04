//! Resource pools: which model provider and which limits serve an
//! organization's server-paid work.
//!
//! A pool names the OpenAI-compatible providers that the System agent and
//! Grounding runs use, the daily limits that bound them, and the
//! organizations it serves. One pool is the default for every organization
//! that is not bound explicitly. Pools are read once at startup from the file
//! named by `KORDI_RESOURCE_POOLS_FILE`; without that file the server builds a
//! single unlimited default pool from the System agent's own provider
//! settings, so existing deployments keep working unchanged. See
//! `docs/development/resource-pools.md`.

use std::collections::{BTreeMap, HashMap};
use std::fmt;

use crate::system_agent::SystemAgentProviderAuth;

mod config;
pub mod usage;

pub use config::{ResourcePoolConfigError, RESOURCE_POOLS_FILE_ENV};

/// The pool id of the pool built from environment settings alone.
pub const ENV_DEFAULT_POOL_ID: &str = "default";

/// The run route field that records which pool a queued run belongs to.
pub const ROUTE_POOL_FIELD: &str = "resourcePool";

/// Server-paid work that a pool meters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Feature {
    /// System agent passes, counted per conversation.
    SystemAgent,
    /// Grounding runs (card builds, matching, rooms, intros, nearby checks),
    /// counted per person.
    Grounding,
}

impl Feature {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SystemAgent => "system_agent",
            Self::Grounding => "grounding",
        }
    }
}

/// One model endpoint of a pool.
#[derive(Clone)]
pub struct PoolProvider {
    auth: SystemAgentProviderAuth,
    headers: BTreeMap<String, String>,
    estimated_cost_micros: u64,
}

impl PoolProvider {
    pub fn new(auth: SystemAgentProviderAuth) -> Self {
        Self {
            auth,
            headers: BTreeMap::new(),
            estimated_cost_micros: 0,
        }
    }

    /// Sets the extra request headers. [`ResourcePools`] loaded from a file
    /// have validated names and values; callers building pools in code must
    /// not pass credentials here.
    pub fn with_headers(mut self, headers: BTreeMap<String, String>) -> Self {
        self.headers = headers;
        self
    }

    pub fn with_estimated_cost_micros(mut self, micros: u64) -> Self {
        self.estimated_cost_micros = micros;
        self
    }

    pub fn auth(&self) -> &SystemAgentProviderAuth {
        &self.auth
    }

    /// Extra request headers sent with every model call, such as a gateway's
    /// attribution headers. Validated at startup; never credentials.
    pub fn headers(&self) -> &BTreeMap<String, String> {
        &self.headers
    }

    /// The operator's estimate of one run's cost, in millionths of the
    /// currency the pool's spend ceiling uses.
    pub fn estimated_cost_micros(&self) -> u64 {
        self.estimated_cost_micros
    }
}

impl fmt::Debug for PoolProvider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PoolProvider")
            .field("auth", &self.auth)
            .field("headers", &self.headers.keys().collect::<Vec<_>>())
            .field("estimated_cost_micros", &self.estimated_cost_micros)
            .finish()
    }
}

/// Daily limits of a pool. `None` is unlimited. Days are UTC days.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PoolLimits {
    pub system_agent_runs_per_conversation: Option<u32>,
    pub grounding_runs_per_person: Option<u32>,
    /// Every metered run of the pool together.
    pub pool_runs: Option<u64>,
    /// Estimated spend of the pool together, in millionths.
    pub pool_spend_micros: Option<u64>,
}

impl PoolLimits {
    pub fn per_scope(&self, feature: Feature) -> Option<u32> {
        match feature {
            Feature::SystemAgent => self.system_agent_runs_per_conversation,
            Feature::Grounding => self.grounding_runs_per_person,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResourcePool {
    id: String,
    system_agent: PoolProvider,
    grounding: Option<PoolProvider>,
    limits: PoolLimits,
    stopped: bool,
}

impl ResourcePool {
    pub fn new(id: impl Into<String>, system_agent: PoolProvider) -> Self {
        Self {
            id: id.into(),
            system_agent,
            grounding: None,
            limits: PoolLimits::default(),
            stopped: false,
        }
    }

    pub fn with_grounding(mut self, grounding: PoolProvider) -> Self {
        self.grounding = Some(grounding);
        self
    }

    pub fn with_limits(mut self, limits: PoolLimits) -> Self {
        self.limits = limits;
        self
    }

    pub fn stopped(mut self, stopped: bool) -> Self {
        self.stopped = stopped;
        self
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// A one-line description for startup logs, without providers or keys.
    pub fn summary(&self) -> String {
        let limit = |value: Option<u64>| value.map_or("unlimited".to_string(), |v| v.to_string());
        format!(
            "{}{} [system agent {}/conversation/day, grounding {}/person/day, pool {} runs/day, {} spend/day]",
            self.id,
            if self.stopped { " (stopped)" } else { "" },
            limit(self.limits.system_agent_runs_per_conversation.map(u64::from)),
            limit(self.limits.grounding_runs_per_person.map(u64::from)),
            limit(self.limits.pool_runs),
            limit(self.limits.pool_spend_micros),
        )
    }

    pub fn limits(&self) -> &PoolLimits {
        &self.limits
    }

    /// The emergency stop: a stopped pool queues nothing and hands no
    /// credential to a runner.
    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    /// The provider that serves `feature`. Grounding uses the System agent's
    /// provider unless the pool names its own.
    pub fn provider(&self, feature: Feature) -> &PoolProvider {
        match feature {
            Feature::SystemAgent => &self.system_agent,
            Feature::Grounding => self.grounding.as_ref().unwrap_or(&self.system_agent),
        }
    }

    /// The runtime route stored on a queued run, so the runner selects this
    /// pool's service credential and model.
    pub fn routing(&self, feature: Feature) -> serde_json::Value {
        let auth = self.provider(feature).auth();
        serde_json::json!({
            "defaultModel": auth.model(),
            "defaultAuthProvider": auth.provider(),
            "defaultAuthChoice": auth.auth_choice(),
            ROUTE_POOL_FIELD: self.id,
        })
    }
}

/// Every pool of this server and the organizations bound to them.
#[derive(Debug, Clone)]
pub struct ResourcePools {
    pools: Vec<ResourcePool>,
    default_index: usize,
    bindings: HashMap<String, usize>,
}

impl ResourcePools {
    /// One unlimited pool that serves every organization, as the server ran
    /// before pools existed.
    pub fn single(pool: ResourcePool) -> Self {
        Self {
            pools: vec![pool],
            default_index: 0,
            bindings: HashMap::new(),
        }
    }

    /// Builds a pool set. Fails when `default_pool` is unknown, ids repeat,
    /// or an organization is bound to two pools.
    pub fn new(
        pools: Vec<ResourcePool>,
        default_pool: &str,
        bindings: impl IntoIterator<Item = (String, String)>,
    ) -> Result<Self, ResourcePoolConfigError> {
        let mut index = HashMap::new();
        for (position, pool) in pools.iter().enumerate() {
            if index.insert(pool.id.clone(), position).is_some() {
                return Err(ResourcePoolConfigError::new(format!(
                    "pool id \"{}\" is used twice",
                    pool.id
                )));
            }
        }
        let Some(&default_index) = index.get(default_pool) else {
            return Err(ResourcePoolConfigError::new(format!(
                "defaultPool \"{default_pool}\" is not a configured pool"
            )));
        };
        let mut bound = HashMap::new();
        for (organization_id, pool_id) in bindings {
            let Some(&position) = index.get(&pool_id) else {
                return Err(ResourcePoolConfigError::new(format!(
                    "organization binding names unknown pool \"{pool_id}\""
                )));
            };
            if let Some(previous) = bound.insert(organization_id.clone(), position) {
                if previous != position {
                    return Err(ResourcePoolConfigError::new(format!(
                        "organization \"{organization_id}\" is bound to more than one pool"
                    )));
                }
            }
        }
        Ok(Self {
            pools,
            default_index,
            bindings: bound,
        })
    }

    /// Loads pools from the file named by `KORDI_RESOURCE_POOLS_FILE`, or
    /// `None` when that setting is empty.
    pub fn from_file_env() -> Result<Option<Self>, ResourcePoolConfigError> {
        config::from_file_env()
    }

    /// The single pool of a deployment without a pool file: the System
    /// agent's provider for both features, no limits, every organization.
    pub fn from_system_agent(auth: &SystemAgentProviderAuth) -> Self {
        Self::single(ResourcePool::new(
            ENV_DEFAULT_POOL_ID,
            PoolProvider::new(auth.clone()),
        ))
    }

    pub fn default_pool(&self) -> &ResourcePool {
        &self.pools[self.default_index]
    }

    pub fn pools(&self) -> &[ResourcePool] {
        &self.pools
    }

    pub fn by_id(&self, id: &str) -> Option<&ResourcePool> {
        self.pools.iter().find(|pool| pool.id == id)
    }

    /// The pool that serves `organization_id`: its explicit binding, else the
    /// default pool. A record without an organization uses the default pool.
    pub fn resolve(&self, organization_id: Option<&str>) -> &ResourcePool {
        organization_id
            .and_then(|id| self.bindings.get(id))
            .map_or_else(|| self.default_pool(), |&index| &self.pools[index])
    }

    /// Organization ids bound to a pool explicitly.
    pub fn bound_organizations(&self) -> impl Iterator<Item = &str> {
        self.bindings.keys().map(String::as_str)
    }

    /// Whether `pool_id` from a run route (absent on runs queued before pools
    /// existed) names `pool`.
    pub fn route_names(&self, pool: &ResourcePool, route_pool: Option<&str>) -> bool {
        match route_pool {
            Some(id) => id == pool.id,
            None => pool.id == self.default_pool().id,
        }
    }
}

/// Warns at startup about bound organization ids that do not exist, such as
/// a typo or an organization from another deployment. They are kept: the
/// organization may be created later.
pub async fn warn_unknown_organizations(
    db: &sqlx_postgres::PgPool,
    pools: &ResourcePools,
) -> Result<(), sqlx_core::Error> {
    let bound: Vec<String> = pools.bound_organizations().map(str::to_string).collect();
    if bound.is_empty() {
        return Ok(());
    }
    let unknown: Vec<String> = sqlx_core::query_scalar::query_scalar(
        "SELECT id FROM unnest($1::text[]) AS bound(id)
         WHERE NOT EXISTS (SELECT 1 FROM cloud_organizations o WHERE o.organization_id = bound.id)
         ORDER BY id",
    )
    .bind(&bound)
    .fetch_all(db)
    .await?;
    for id in unknown {
        eprintln!("[resource-pools] Bound organization {id} does not exist on this server");
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn test_provider(model: &str) -> PoolProvider {
    PoolProvider::new(
        SystemAgentProviderAuth::openai_api_key("synthetic-key", model).expect("synthetic key"),
    )
}

#[cfg(test)]
pub(crate) mod tests;
