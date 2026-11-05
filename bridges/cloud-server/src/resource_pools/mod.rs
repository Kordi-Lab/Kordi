//! Resource pools: which model provider and which limits serve an
//! organization's server-paid work.
//!
//! A pool names the OpenAI-compatible providers that the System agent and
//! Grounding runs use, the daily limits that bound them, and the
//! organizations it serves. One pool is the default for every organization
//! that is not bound explicitly. Pools are read from the file named by
//! `KORDI_RESOURCE_POOLS_FILE` at startup and again whenever it changes (see
//! [`registry`]); without that file the server builds a single unlimited
//! default pool from the System agent's own provider settings, so existing
//! deployments keep working unchanged.
//!
//! A pool runs its work in one of two places, its executor: the control
//! plane (the server's own runners call the pool's provider with a key the
//! server holds), or the pool's own worker, which holds its own credential
//! and claims only the runs tagged with its pool id. See
//! `docs/development/resource-pools.md`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;

use crate::system_agent::SystemAgentProviderAuth;

mod config;
pub mod coverage;
mod organizations;
pub mod registry;
mod sightings;
pub mod usage;
mod worker;

pub use config::{ResourcePoolConfigError, RESOURCE_POOLS_FILE_ENV};
pub use organizations::{ConfiguredBindings, ORGANIZATIONS_FILE_ENV};
pub use registry::{warn_unknown_organizations, ResourcePoolRegistry};
pub use worker::WorkerIdentity;

/// The pool id of the pool built from environment settings alone.
pub const ENV_DEFAULT_POOL_ID: &str = "default";

/// The run route field that records which pool a queued run belongs to.
pub const ROUTE_POOL_FIELD: &str = "resourcePool";
/// The run route field that marks a run queued for its pool's own worker.
pub const ROUTE_EXECUTOR_FIELD: &str = "poolExecutor";

/// Where a pool's runs execute.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Executor {
    /// The control plane's runners call the pool's provider with a key the
    /// server holds.
    ControlPlane,
    /// The pool's own worker claims the pool's runs and calls its own
    /// provider; the server holds no credential for the pool.
    PoolWorker,
}

impl Executor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ControlPlane => "control_plane",
            Self::PoolWorker => "pool_worker",
        }
    }
}

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
enum Execution {
    ControlPlane {
        system_agent: PoolProvider,
        grounding: Option<PoolProvider>,
    },
    PoolWorker {
        /// The workload identity a worker must present. `None` accepts no
        /// worker, which is how an operator revokes a worker quickly.
        identity: Option<WorkerIdentity>,
        estimated_cost_micros: u64,
    },
}

#[derive(Debug, Clone)]
pub struct ResourcePool {
    id: String,
    execution: Execution,
    limits: PoolLimits,
    stopped: bool,
}

impl ResourcePool {
    /// A pool whose runs execute in the control plane with `system_agent`'s
    /// provider.
    pub fn new(id: impl Into<String>, system_agent: PoolProvider) -> Self {
        Self {
            id: id.into(),
            execution: Execution::ControlPlane {
                system_agent,
                grounding: None,
            },
            limits: PoolLimits::default(),
            stopped: false,
        }
    }

    /// A pool whose runs execute on its own worker. The server holds no
    /// provider for it; `estimated_cost_micros` prices one run of either
    /// feature for a spend ceiling.
    pub fn pool_worker(
        id: impl Into<String>,
        identity: Option<WorkerIdentity>,
        estimated_cost_micros: u64,
    ) -> Self {
        Self {
            id: id.into(),
            execution: Execution::PoolWorker {
                identity,
                estimated_cost_micros,
            },
            limits: PoolLimits::default(),
            stopped: false,
        }
    }

    /// Sets the Grounding provider of a control plane pool. Ignored for a
    /// pool worker pool.
    pub fn with_grounding(mut self, provider: PoolProvider) -> Self {
        if let Execution::ControlPlane { grounding, .. } = &mut self.execution {
            *grounding = Some(provider);
        }
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
            "{}{}{} [system agent {}/conversation/day, grounding {}/person/day, pool {} runs/day, {} spend/day]",
            self.id,
            match self.executor() {
                Executor::ControlPlane => "",
                Executor::PoolWorker => " (pool worker)",
            },
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

    pub fn executor(&self) -> Executor {
        match self.execution {
            Execution::ControlPlane { .. } => Executor::ControlPlane,
            Execution::PoolWorker { .. } => Executor::PoolWorker,
        }
    }

    /// The identity a pool worker must present, if this is a pool worker
    /// pool that accepts one.
    pub fn worker_identity(&self) -> Option<&WorkerIdentity> {
        match &self.execution {
            Execution::PoolWorker { identity, .. } => identity.as_ref(),
            Execution::ControlPlane { .. } => None,
        }
    }

    /// The provider that serves `feature` in the control plane. Grounding
    /// uses the System agent's provider unless the pool names its own. A pool
    /// worker pool has none: the server never holds its credential.
    pub fn provider(&self, feature: Feature) -> Option<&PoolProvider> {
        match &self.execution {
            Execution::ControlPlane {
                system_agent,
                grounding,
            } => Some(match feature {
                Feature::SystemAgent => system_agent,
                Feature::Grounding => grounding.as_ref().unwrap_or(system_agent),
            }),
            Execution::PoolWorker { .. } => None,
        }
    }

    /// The estimated cost of one run of `feature`, for a spend ceiling.
    pub fn estimated_cost_micros(&self, feature: Feature) -> u64 {
        match &self.execution {
            Execution::ControlPlane { .. } => self
                .provider(feature)
                .map_or(0, PoolProvider::estimated_cost_micros),
            Execution::PoolWorker {
                estimated_cost_micros,
                ..
            } => *estimated_cost_micros,
        }
    }

    /// The runtime route stored on a queued run. A control plane run names
    /// this pool's service credential and model, so the runner selects them;
    /// a pool worker run names only the pool, whose worker picks its own.
    pub fn routing(&self, feature: Feature) -> serde_json::Value {
        match self.provider(feature) {
            Some(provider) => {
                let auth = provider.auth();
                serde_json::json!({
                    "defaultModel": auth.model(),
                    "defaultAuthProvider": auth.provider(),
                    "defaultAuthChoice": auth.auth_choice(),
                    ROUTE_POOL_FIELD: self.id,
                })
            }
            None => serde_json::json!({
                ROUTE_POOL_FIELD: self.id,
                ROUTE_EXECUTOR_FIELD: Executor::PoolWorker.as_str(),
            }),
        }
    }
}

/// Every pool of this server and the organizations bound to them.
#[derive(Debug, Clone)]
pub struct ResourcePools {
    pools: Vec<ResourcePool>,
    default_index: usize,
    bindings: HashMap<String, usize>,
    /// Organizations whose configuration disables them: no pool admits
    /// their work.
    blocked: HashSet<String>,
    /// Organizations whose pool also covers members' personal work.
    covering: HashSet<String>,
}

impl ResourcePools {
    /// One unlimited pool that serves every organization, as the server ran
    /// before pools existed.
    pub fn single(pool: ResourcePool) -> Self {
        Self {
            pools: vec![pool],
            default_index: 0,
            bindings: HashMap::new(),
            blocked: HashSet::new(),
            covering: HashSet::new(),
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
            blocked: HashSet::new(),
            covering: HashSet::new(),
        })
    }

    /// Adds organization bindings from another source, such as the
    /// organizations file. Fails when one names an unknown pool or contradicts
    /// a binding already made.
    pub fn with_bindings(
        mut self,
        bindings: impl IntoIterator<Item = (String, String)>,
    ) -> Result<Self, ResourcePoolConfigError> {
        for (organization_id, pool_id) in bindings {
            let Some(position) = self.pools.iter().position(|pool| pool.id == pool_id) else {
                return Err(ResourcePoolConfigError::new(format!(
                    "organization binding names unknown pool \"{pool_id}\""
                )));
            };
            if let Some(previous) = self.bindings.insert(organization_id.clone(), position) {
                if previous != position {
                    return Err(ResourcePoolConfigError::new(format!(
                        "organization \"{organization_id}\" is bound to more than one pool"
                    )));
                }
            }
        }
        Ok(self)
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

    /// Refuses all work of `organizations`, such as organizations the
    /// organizations file disables.
    pub fn with_blocked(mut self, organizations: impl IntoIterator<Item = String>) -> Self {
        self.blocked.extend(organizations);
        self
    }

    /// Whether any work of `organization_id` may be admitted.
    pub fn admits(&self, organization_id: Option<&str>) -> bool {
        organization_id.is_none_or(|id| !self.blocked.contains(id))
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

#[cfg(test)]
pub(crate) mod tests;
#[cfg(test)]
pub(crate) use tests::test_provider;
