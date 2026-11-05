//! The resource pool file: parsing and validation.
//!
//! The file is JSON (format in `docs/development/resource-pools.md`). Every
//! field is checked before the server starts or a reload is applied, and
//! errors name the pool and field but never a secret value. API keys are read
//! from a named environment variable or a file, never from the pool file
//! itself. Format 1 pools always execute in the control plane; format 2 adds
//! an `executor` per pool, and a `pool_worker` pool carries no provider at
//! all, only the identity its worker presents.

use std::collections::BTreeMap;
use std::{env, fmt, fs};

use serde::Deserialize;

use super::{Feature, PoolLimits, PoolProvider, ResourcePool, ResourcePools, WorkerIdentity};
use crate::service_model_config::validate_base_url;
use crate::system_agent::SystemAgentProviderAuth;

pub const RESOURCE_POOLS_FILE_ENV: &str = "KORDI_RESOURCE_POOLS_FILE";

/// Every organization id starts with this.
const ORGANIZATION_PREFIX: &str = "org_";
const MAX_FILE_BYTES: u64 = 256 * 1024;
const MAX_ID_CHARS: usize = 64;
const MAX_MODEL_CHARS: usize = 200;
const MAX_HEADERS: usize = 16;
const MAX_HEADER_NAME_CHARS: usize = 64;
const MAX_HEADER_VALUE_CHARS: usize = 512;

/// Headers that carry credentials, routing or framing. A pool may not set
/// them: the runner owns them.
const RESERVED_HEADERS: [&str; 13] = [
    "authorization",
    "proxy-authorization",
    "cookie",
    "host",
    "content-type",
    "content-length",
    "connection",
    "transfer-encoding",
    "te",
    "upgrade",
    "x-api-key",
    "api-key",
    "chatgpt-account-id",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourcePoolConfigError(String);

impl ResourcePoolConfigError {
    pub(super) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ResourcePoolConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for ResourcePoolConfigError {}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PoolFile {
    version: u32,
    default_pool: String,
    pools: Vec<PoolEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PoolEntry {
    id: String,
    /// Format 2 only: `control_plane` or `pool_worker`.
    #[serde(default)]
    executor: Option<String>,
    #[serde(default)]
    system_agent: Option<ProviderEntry>,
    #[serde(default)]
    grounding: Option<ProviderEntry>,
    /// Format 2 `pool_worker` pools only.
    #[serde(default)]
    worker: Option<WorkerEntry>,
    /// Format 2 `pool_worker` pools only: one run's estimated cost.
    #[serde(default)]
    estimated_cost_micros_per_run: Option<u64>,
    #[serde(default)]
    limits: LimitsEntry,
    #[serde(default)]
    stopped: bool,
    #[serde(default)]
    organizations: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ProviderEntry {
    #[serde(default)]
    provider: Option<String>,
    base_url: String,
    model: String,
    #[serde(default)]
    api_key_env: Option<String>,
    #[serde(default)]
    api_key_file: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
    #[serde(default)]
    estimated_cost_micros_per_run: u64,
}

/// How a pool worker proves who it is: an identity inline, or the name of an
/// environment variable that holds it as JSON.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct WorkerEntry {
    #[serde(default)]
    identity_env: Option<String>,
    #[serde(default)]
    identity: Option<serde_json::Value>,
}

/// Daily limits. Each is a whole number, or `"unlimited"`; `null` and an
/// absent field also mean unlimited.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct LimitsEntry {
    #[serde(default, deserialize_with = "limit")]
    system_agent_runs_per_conversation_per_day: Option<u32>,
    #[serde(default, deserialize_with = "limit")]
    grounding_runs_per_person_per_day: Option<u32>,
    #[serde(default, deserialize_with = "limit")]
    pool_runs_per_day: Option<u64>,
    #[serde(default, deserialize_with = "limit")]
    pool_spend_micros_per_day: Option<u64>,
}

const UNLIMITED: &str = "unlimited";

/// Reads a limit: a whole number, `"unlimited"` or `null`. The error never
/// repeats the value, which could be a pasted secret.
fn limit<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: TryFrom<u64>,
{
    let invalid = || serde::de::Error::custom("a limit must be a whole number or unlimited");
    match serde_json::Value::deserialize(deserializer)? {
        serde_json::Value::Null => Ok(None),
        serde_json::Value::String(word) if word.trim() == UNLIMITED => Ok(None),
        serde_json::Value::Number(number) => number
            .as_u64()
            .and_then(|value| T::try_from(value).ok())
            .map(Some)
            .ok_or_else(invalid),
        _ => Err(invalid()),
    }
}

pub(super) fn path_from_env() -> Option<String> {
    env::var(RESOURCE_POOLS_FILE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn from_file_env() -> Result<Option<ResourcePools>, ResourcePoolConfigError> {
    path_from_env()
        .map(|path| load_file(&path, |key| env::var(key).ok()))
        .transpose()
}

pub(super) fn load_file(
    path: &str,
    get: impl FnMut(&str) -> Option<String>,
) -> Result<ResourcePools, ResourcePoolConfigError> {
    let size = fs::metadata(path)
        .map_err(|_| {
            ResourcePoolConfigError::new(format!("{RESOURCE_POOLS_FILE_ENV} cannot be read"))
        })?
        .len();
    if size > MAX_FILE_BYTES {
        return Err(ResourcePoolConfigError::new(format!(
            "{RESOURCE_POOLS_FILE_ENV} is larger than {MAX_FILE_BYTES} bytes"
        )));
    }
    let text = fs::read_to_string(path).map_err(|_| {
        ResourcePoolConfigError::new(format!("{RESOURCE_POOLS_FILE_ENV} cannot be read"))
    })?;
    parse(&text, get)
}

/// Parses and validates a pool file. `get` reads environment variables.
pub(super) fn parse(
    text: &str,
    mut get: impl FnMut(&str) -> Option<String>,
) -> Result<ResourcePools, ResourcePoolConfigError> {
    let file: PoolFile = serde_json::from_str(text).map_err(|error| {
        // Type errors quote the offending value; show only its position then.
        let detail = error.to_string();
        ResourcePoolConfigError::new(if detail.contains('"') {
            format!(
                "resource pool file is invalid at line {} column {}",
                error.line(),
                error.column()
            )
        } else {
            format!("resource pool file is invalid: {detail}")
        })
    })?;
    if !(1..=2).contains(&file.version) {
        return Err(ResourcePoolConfigError::new(
            "resource pool file version must be 1 or 2; this server does not read newer formats",
        ));
    }
    if file.pools.is_empty() {
        return Err(ResourcePoolConfigError::new(
            "resource pool file must define at least one pool",
        ));
    }
    let mut pools = Vec::with_capacity(file.pools.len());
    let mut bindings = Vec::new();
    for entry in file.pools {
        validate_id("pool id", &entry.id)?;
        let at = |field: &str| format!("pool \"{}\" {field}", entry.id);
        let pool = match executor(&entry, file.version, &at)? {
            super::Executor::ControlPlane => control_plane_pool(&entry, &at, &mut get)?,
            super::Executor::PoolWorker => worker_pool(&entry, &at, &mut get)?,
        }
        .with_limits(PoolLimits {
            system_agent_runs_per_conversation: entry
                .limits
                .system_agent_runs_per_conversation_per_day,
            grounding_runs_per_person: entry.limits.grounding_runs_per_person_per_day,
            pool_runs: entry.limits.pool_runs_per_day,
            pool_spend_micros: entry.limits.pool_spend_micros_per_day,
        })
        .stopped(entry.stopped);
        // A spend ceiling counts estimated costs, so every feature of the
        // pool needs one; a zero estimate would never reach the ceiling.
        let unpriced = [Feature::SystemAgent, Feature::Grounding]
            .into_iter()
            .any(|feature| pool.estimated_cost_micros(feature) == 0);
        if pool.limits().pool_spend_micros.is_some() && unpriced {
            return Err(ResourcePoolConfigError::new(at(
                "poolSpendMicrosPerDay needs estimatedCostMicrosPerRun above 0 on every provider",
            )));
        }
        for organization_id in &entry.organizations {
            validate_id(&at("organization id"), organization_id)?;
            if !organization_id.starts_with(ORGANIZATION_PREFIX) {
                return Err(ResourcePoolConfigError::new(at(&format!(
                    "organization ids must start with {ORGANIZATION_PREFIX}"
                ))));
            }
            bindings.push((organization_id.clone(), entry.id.clone()));
        }
        pools.push(pool);
    }
    let default_pool = file.default_pool.trim();
    // The System agent's own definition takes its model from the default
    // pool, so the default pool always executes in the control plane.
    if pools
        .iter()
        .any(|pool| pool.id() == default_pool && pool.executor() != super::Executor::ControlPlane)
    {
        return Err(ResourcePoolConfigError::new(format!(
            "defaultPool \"{default_pool}\" must have executor control_plane"
        )));
    }
    ResourcePools::new(pools, default_pool, bindings)
}

fn executor(
    entry: &PoolEntry,
    version: u32,
    at: &impl Fn(&str) -> String,
) -> Result<super::Executor, ResourcePoolConfigError> {
    let fail = |detail: &str| Err(ResourcePoolConfigError::new(at(detail)));
    if version == 1 {
        if entry.executor.is_some()
            || entry.worker.is_some()
            || entry.estimated_cost_micros_per_run.is_some()
        {
            return fail(
                "uses executor, worker or estimatedCostMicrosPerRun, which need version 2",
            );
        }
        return Ok(super::Executor::ControlPlane);
    }
    match entry.executor.as_deref().map(str::trim) {
        Some("control_plane") => Ok(super::Executor::ControlPlane),
        Some("pool_worker") => Ok(super::Executor::PoolWorker),
        Some(_) => fail("executor must be control_plane or pool_worker"),
        None => fail("executor is required in version 2"),
    }
}

fn control_plane_pool(
    entry: &PoolEntry,
    at: &impl Fn(&str) -> String,
    get: &mut impl FnMut(&str) -> Option<String>,
) -> Result<ResourcePool, ResourcePoolConfigError> {
    if entry.worker.is_some() || entry.estimated_cost_micros_per_run.is_some() {
        return Err(ResourcePoolConfigError::new(at(
            "worker and estimatedCostMicrosPerRun are only used with executor pool_worker",
        )));
    }
    let Some(system_agent) = &entry.system_agent else {
        return Err(ResourcePoolConfigError::new(at("systemAgent is required")));
    };
    let mut pool = ResourcePool::new(
        entry.id.clone(),
        provider(system_agent, &at("systemAgent"), get)?,
    );
    if let Some(grounding) = &entry.grounding {
        pool = pool.with_grounding(provider(grounding, &at("grounding"), get)?);
    }
    Ok(pool)
}

/// A pool worker pool holds no provider and no key: its worker has its own.
fn worker_pool(
    entry: &PoolEntry,
    at: &impl Fn(&str) -> String,
    get: &mut impl FnMut(&str) -> Option<String>,
) -> Result<ResourcePool, ResourcePoolConfigError> {
    if entry.system_agent.is_some() || entry.grounding.is_some() {
        return Err(ResourcePoolConfigError::new(at(
            "with executor pool_worker may not name systemAgent or grounding providers: its worker holds its own",
        )));
    }
    let Some(worker) = &entry.worker else {
        return Err(ResourcePoolConfigError::new(at(
            "worker is required with executor pool_worker",
        )));
    };
    let identity = match (&worker.identity_env, &worker.identity) {
        (Some(name), None) => {
            let name = name.trim();
            if !is_variable_name(name) {
                return Err(ResourcePoolConfigError::new(at(
                    "worker.identityEnv must name an environment variable",
                )));
            }
            // An empty or unset variable accepts no worker: clearing it is
            // the quick way to revoke a worker.
            get(name)
                .filter(|value| !value.trim().is_empty())
                .map(|value| {
                    WorkerIdentity::from_text(&value, &at(&format!("worker identity {name}")))
                })
                .transpose()?
        }
        (None, Some(value)) => Some(WorkerIdentity::from_json(
            value.clone(),
            &at("worker.identity"),
        )?),
        _ => {
            return Err(ResourcePoolConfigError::new(at(
                "worker needs exactly one of identityEnv or identity",
            )))
        }
    };
    Ok(ResourcePool::pool_worker(
        entry.id.clone(),
        identity,
        entry.estimated_cost_micros_per_run.unwrap_or(0),
    ))
}

fn is_variable_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

fn validate_id(what: &str, id: &str) -> Result<(), ResourcePoolConfigError> {
    let valid = !id.is_empty()
        && id.chars().count() <= MAX_ID_CHARS
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if valid {
        Ok(())
    } else {
        Err(ResourcePoolConfigError::new(format!(
            "{what} must be 1-{MAX_ID_CHARS} letters, digits, '.', '_' or '-'"
        )))
    }
}

fn provider(
    entry: &ProviderEntry,
    at: &str,
    get: &mut impl FnMut(&str) -> Option<String>,
) -> Result<PoolProvider, ResourcePoolConfigError> {
    let invalid = |detail: &str| ResourcePoolConfigError::new(format!("{at} {detail}"));
    // OpenRouter keeps vendor-prefixed model ids such as `vendor/model`
    // intact; an `openai` gateway would have an `openai/` prefix removed.
    let provider_id = match entry.provider.as_deref().map(str::trim) {
        None | Some("openai" | "openai-compatible") => "openai",
        Some("openrouter") => "openrouter",
        Some(_) => {
            return Err(invalid(
                "provider must be openai, openai-compatible or openrouter",
            ))
        }
    };
    let base_url = validate_base_url(&entry.base_url).map_err(|_| {
        invalid("baseUrl must be an https URL without credentials, query or fragment")
    })?;
    let model = entry.model.trim();
    if model.is_empty()
        || model.chars().count() > MAX_MODEL_CHARS
        || model.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(invalid("model must be a model id without spaces"));
    }
    let api_key = match (&entry.api_key_env, &entry.api_key_file) {
        (Some(name), None) => {
            let name = name.trim();
            // A value that does not look like a variable name might be a
            // pasted key, so it is never echoed.
            if !is_variable_name(name) {
                return Err(invalid("apiKeyEnv must name an environment variable"));
            }
            get(name)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| invalid(&format!("apiKeyEnv {name} is not set")))?
        }
        (None, Some(path)) => fs::read_to_string(path.trim())
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| invalid("apiKeyFile cannot be read or is empty"))?,
        _ => return Err(invalid("needs exactly one of apiKeyEnv or apiKeyFile")),
    };
    if api_key.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(invalid("API key must be a single token"));
    }
    if entry.headers.len() > MAX_HEADERS {
        return Err(invalid(&format!("may set at most {MAX_HEADERS} headers")));
    }
    let mut headers = BTreeMap::new();
    for (name, value) in &entry.headers {
        let lower = name.trim().to_ascii_lowercase();
        let token = !lower.is_empty()
            && lower.len() <= MAX_HEADER_NAME_CHARS
            && lower
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b));
        if !token {
            return Err(invalid("header names must be HTTP tokens"));
        }
        if RESERVED_HEADERS.contains(&lower.as_str()) {
            return Err(invalid(&format!("may not set the {lower} header")));
        }
        let value = value.trim();
        if value.is_empty()
            || value.len() > MAX_HEADER_VALUE_CHARS
            || !value.bytes().all(|b| b == b' ' || b.is_ascii_graphic())
        {
            return Err(invalid(&format!(
                "header {lower} needs a printable ASCII value of at most {MAX_HEADER_VALUE_CHARS} characters"
            )));
        }
        if headers.insert(lower.clone(), value.to_string()).is_some() {
            return Err(invalid(&format!("sets header {lower} twice")));
        }
    }
    let auth = SystemAgentProviderAuth::openai_api_key(api_key, model)
        .map_err(|_| invalid("needs an API key and a model"))?
        .with_base_url(base_url)
        .with_provider_id(provider_id);
    Ok(PoolProvider::new(auth)
        .with_headers(headers)
        .with_estimated_cost_micros(entry.estimated_cost_micros_per_run))
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "config_v2_tests.rs"]
mod v2_tests;
