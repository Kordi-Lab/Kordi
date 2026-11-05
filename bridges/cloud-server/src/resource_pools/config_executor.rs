//! Format 2 pool entries: the executor, and pools whose work runs on their
//! own worker.

use super::*;

pub(super) fn executor(
    entry: &PoolEntry,
    version: u32,
    at: &impl Fn(&str) -> String,
) -> Result<crate::resource_pools::Executor, ResourcePoolConfigError> {
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
        return Ok(crate::resource_pools::Executor::ControlPlane);
    }
    match entry.executor.as_deref().map(str::trim) {
        Some("control_plane") => Ok(crate::resource_pools::Executor::ControlPlane),
        Some("pool_worker") => Ok(crate::resource_pools::Executor::PoolWorker),
        Some(_) => fail("executor must be control_plane or pool_worker"),
        None => fail("executor is required in version 2"),
    }
}

pub(super) fn control_plane_pool(
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
pub(super) fn worker_pool(
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
            // An empty or unset variable accepts no worker. The server reads
            // it at startup; an inline identity changes with a reload.
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

/// Two pools accepting the same worker identity would let one worker act for
/// both.
pub(super) fn reject_shared_identities(
    pools: &[ResourcePool],
) -> Result<(), ResourcePoolConfigError> {
    let identities: Vec<_> = pools
        .iter()
        .filter_map(|pool| Some((pool.id(), pool.worker_identity()?)))
        .collect();
    for (index, (id, identity)) in identities.iter().enumerate() {
        let shared = identities[..index].iter().find(|(_, other)| {
            other.issuer == identity.issuer
                && other.audience == identity.audience
                && other.subject == identity.subject
                && other.email == identity.email
        });
        if let Some((other, _)) = shared {
            return Err(ResourcePoolConfigError::new(format!(
                "pools \"{other}\" and \"{id}\" accept the same worker identity"
            )));
        }
    }
    Ok(())
}

pub(super) fn is_variable_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}
