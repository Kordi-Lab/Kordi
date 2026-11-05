//! Pool bindings from the organizations file.
//!
//! The organizations file (`KORDI_ORGANIZATIONS_FILE`) configures team
//! organizations by a configuration id, and names the pool each one is bound
//! to. Admission owns the rest of that file; pools read only
//! `organizations[].id`, `organizations[].pool`, `organizations[].state` and
//! `personalOrganizations.pool`, and ignore every other field, so the file can
//! grow without breaking pools. A configuration id becomes an organization id
//! once the organization exists on this server
//! (`cloud_organizations.config_id`); see [`super::registry`].

use std::{env, fs};

use serde::Deserialize;

use super::{ResourcePoolConfigError, ResourcePools};

pub const ORGANIZATIONS_FILE_ENV: &str = "KORDI_ORGANIZATIONS_FILE";

const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_CONFIG_ID_CHARS: usize = 63;

/// The pool bindings named by the organizations file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfiguredBindings {
    /// Configuration id and pool id of every bound organization.
    pub organizations: Vec<(String, String)>,
    /// The pool for personal organizations, which must be the default pool.
    pub personal_pool: Option<String>,
    /// Configuration ids of disabled organizations: their work is refused.
    pub disabled: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrganizationsFile {
    #[serde(default)]
    personal_organizations: Option<PersonalEntry>,
    #[serde(default)]
    organizations: Vec<OrganizationEntry>,
}

#[derive(Deserialize)]
struct PersonalEntry {
    #[serde(default)]
    pool: Option<String>,
}

#[derive(Deserialize)]
struct OrganizationEntry {
    id: String,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    pool: Option<String>,
}

pub(super) fn path_from_env() -> Option<String> {
    env::var(ORGANIZATIONS_FILE_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

pub(super) fn load_file(path: &str) -> Result<ConfiguredBindings, ResourcePoolConfigError> {
    let unreadable =
        || ResourcePoolConfigError::new(format!("{ORGANIZATIONS_FILE_ENV} cannot be read"));
    let size = fs::metadata(path).map_err(|_| unreadable())?.len();
    if size > MAX_FILE_BYTES {
        return Err(ResourcePoolConfigError::new(format!(
            "{ORGANIZATIONS_FILE_ENV} is larger than {MAX_FILE_BYTES} bytes"
        )));
    }
    parse(&fs::read_to_string(path).map_err(|_| unreadable())?)
}

/// Reads the pool bindings of an organizations file. An organization without
/// a pool is not bound; a disabled one is listed so its work is refused.
pub(super) fn parse(text: &str) -> Result<ConfiguredBindings, ResourcePoolConfigError> {
    let file: OrganizationsFile = serde_json::from_str(text).map_err(|error| {
        ResourcePoolConfigError::new(format!(
            "organizations file is invalid at line {} column {}",
            error.line(),
            error.column()
        ))
    })?;
    let mut bindings = ConfiguredBindings {
        personal_pool: file
            .personal_organizations
            .and_then(|personal| personal.pool)
            .map(|pool| pool.trim().to_string()),
        ..Default::default()
    };
    let mut seen = std::collections::HashSet::new();
    for entry in file.organizations {
        let id = entry.id.trim();
        let valid = !id.is_empty()
            && id.len() <= MAX_CONFIG_ID_CHARS
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if !valid {
            return Err(ResourcePoolConfigError::new(format!(
                "organizations file ids must be 1-{MAX_CONFIG_ID_CHARS} lowercase letters, digits or hyphens"
            )));
        }
        if !seen.insert(id.to_string()) {
            return Err(ResourcePoolConfigError::new(format!(
                "organizations file lists \"{id}\" twice"
            )));
        }
        let disabled = entry.state.as_deref().map(str::trim) == Some("disabled");
        if disabled {
            bindings.disabled.push(id.to_string());
        } else if let Some(pool) = entry.pool {
            bindings
                .organizations
                .push((id.to_string(), pool.trim().to_string()));
        }
    }
    Ok(bindings)
}

impl ConfiguredBindings {
    /// Checks the bindings against `pools`: every named pool exists, and
    /// personal organizations use the default pool (they are never bound one
    /// by one).
    pub fn validate(&self, pools: &ResourcePools) -> Result<(), ResourcePoolConfigError> {
        for (id, pool) in &self.organizations {
            if pools.by_id(pool).is_none() {
                return Err(ResourcePoolConfigError::new(format!(
                    "organization \"{id}\" in the organizations file names unknown pool \"{pool}\""
                )));
            }
        }
        if let Some(pool) = &self.personal_pool {
            if pool != pools.default_pool().id() {
                return Err(ResourcePoolConfigError::new(format!(
                    "personalOrganizations.pool \"{pool}\" must be the defaultPool \"{}\"",
                    pools.default_pool().id()
                )));
            }
        }
        Ok(())
    }
}
