//! The organization admission file named by `KORDI_ORGANIZATIONS_FILE`.
//! Every institution-specific value lives in this deployment file, never in
//! code. Unknown fields are rejected so a typo cannot silently weaken a rule.
//! `null` means undecided: an undecided limit falls back to a bounded server
//! default, never to unlimited.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FILE_ENV: &str = "KORDI_ORGANIZATIONS_FILE";

const MAX_FILE_BYTES: usize = 256 * 1024;
const MAX_ORGANIZATIONS: usize = 50;
const MAX_DOMAINS: usize = 20;
const MAX_FIELDS: usize = 10;
const MAX_ADMINS: usize = 200;
/// Used when a join-request field leaves `maxLength` undecided.
pub const DEFAULT_FIELD_MAX_LENGTH: u32 = 1000;
/// Purges requests left from a time join requests were enabled when the file
/// no longer gives `retentionDays`.
pub const DEFAULT_RETENTION_DAYS: u32 = 30;
const MAX_FIELD_LENGTH: u32 = 4000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrganizationState {
    /// No domain claim, no auto-join, no join requests.
    Disabled,
    /// Open for admission while bound to an interim pool.
    Interim,
    Active,
}

impl OrganizationState {
    pub fn admits(self) -> bool {
        self != Self::Disabled
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DomainMatch {
    /// Only the claimed domain itself.
    Exact,
    /// The claimed domain and any of its subdomains.
    Subdomains,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignInMethod {
    Google,
    EmailCode,
    Github,
}

impl SignInMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::EmailCode => "email_code",
            Self::Github => "github",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Approval {
    OrganizationAdmins,
}

/// When a membership approved from a join request ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovedMembershipExpiry {
    /// `null`: approved memberships do not expire.
    Never,
    /// `"set_by_approver"`: the approver may give an `expiresAt`.
    SetByApprover,
    /// A whole number: this many days after approval.
    Days(u32),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileV1 {
    version: u32,
    personal_organizations: PersonalFile,
    organizations: Vec<OrganizationFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PersonalFile {
    pool: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OrganizationFile {
    id: String,
    display_name: String,
    state: OrganizationState,
    pool: Option<String>,
    target_pool: Option<String>,
    admission: AdmissionFile,
    membership: MembershipPolicy,
    admins_env: Option<String>,
    entry_page: EntryPage,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AdmissionFile {
    claimed_domains: Vec<String>,
    domain_match: DomainMatch,
    require_google_hosted_domain: bool,
    auto_join_methods: Vec<SignInMethod>,
    reverify_interval_months: Option<u32>,
    google_sign_in_reverifies: bool,
    join_requests: JoinRequestsFile,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct JoinRequestsFile {
    enabled: bool,
    approval: Approval,
    fields: Vec<FieldFile>,
    retention_days: Option<u32>,
    approved_membership_expiry: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FieldFile {
    key: String,
    label: String,
    required: Option<bool>,
    max_length: Option<u32>,
}

/// Read by the ownership and pool work; admission only carries them.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MembershipPolicy {
    pub require_member_owner: bool,
    pub outsiders_allowed: bool,
    pub work_end_bound_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntryPage {
    pub title: String,
    pub summary: String,
    pub join_label: String,
    pub not_open_text: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequestField {
    pub key: String,
    pub label: String,
    pub required: bool,
    pub max_length: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JoinRequestPolicy {
    pub fields: Vec<JoinRequestField>,
    pub approved_membership_expiry: ApprovedMembershipExpiry,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DomainClaim {
    pub domains: Vec<String>,
    pub domain_match: DomainMatch,
    pub require_google_hosted_domain: bool,
}

/// Admins by reference: account ids (`acct_…`) and verified emails read from
/// the environment variable the file names. Never logged.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfiguredAdmins {
    pub account_ids: Vec<String>,
    pub emails: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfiguredOrganization {
    /// The configuration id; stable across restarts.
    pub id: String,
    /// The database organization, filled by startup sync.
    pub organization_id: String,
    pub display_name: String,
    pub state: OrganizationState,
    pub pool: Option<String>,
    pub target_pool: Option<String>,
    pub claim: DomainClaim,
    pub auto_join_methods: Vec<SignInMethod>,
    pub reverify_interval_months: Option<u32>,
    pub google_sign_in_reverifies: bool,
    /// `None` when join requests are disabled.
    pub join_requests: Option<JoinRequestPolicy>,
    /// Join requests older than this are deleted, enabled or not.
    pub request_retention_days: u32,
    pub membership: MembershipPolicy,
    pub admins: ConfiguredAdmins,
    pub entry_page: EntryPage,
}

impl ConfiguredOrganization {
    pub fn auto_joins(&self, method: SignInMethod) -> bool {
        self.auto_join_methods.contains(&method)
    }
}

/// The parsed admission file. The default has no configured organization,
/// which keeps every account in its personal organization only.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OrganizationAdmission {
    pub personal_pool: Option<String>,
    pub organizations: Vec<ConfiguredOrganization>,
}

impl OrganizationAdmission {
    /// Reads the file named by `KORDI_ORGANIZATIONS_FILE`; absent means no
    /// configured organization.
    pub fn from_env() -> Result<Self, String> {
        let Some(path) = std::env::var(FILE_ENV)
            .ok()
            .filter(|v| !v.trim().is_empty())
        else {
            return Ok(Self::default());
        };
        let raw = std::fs::read_to_string(path.trim())
            .map_err(|error| format!("{FILE_ENV}: cannot read the file: {error}"))?;
        Self::parse(&raw, |key| std::env::var(key).ok())
    }

    pub fn parse(raw: &str, env: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        if raw.len() > MAX_FILE_BYTES {
            return Err(format!(
                "{FILE_ENV}: the file exceeds {MAX_FILE_BYTES} bytes"
            ));
        }
        let file: FileV1 =
            serde_json::from_str(raw).map_err(|error| format!("{FILE_ENV}: {error}"))?;
        if file.version != 1 {
            return Err(format!("{FILE_ENV}: version must be 1"));
        }
        if file.organizations.len() > MAX_ORGANIZATIONS {
            return Err(format!(
                "{FILE_ENV}: at most {MAX_ORGANIZATIONS} organizations"
            ));
        }
        let personal_pool = optional_id(
            file.personal_organizations.pool,
            "personalOrganizations.pool",
        )?;
        let mut organizations = Vec::with_capacity(file.organizations.len());
        for (index, org) in file.organizations.into_iter().enumerate() {
            let at = format!("organizations[{index}]");
            let org = organization(org, &at, &env).map_err(|e| format!("{FILE_ENV}: {e}"))?;
            if organizations
                .iter()
                .any(|o: &ConfiguredOrganization| o.id == org.id)
            {
                return Err(format!("{FILE_ENV}: {at}.id `{}` is used twice", org.id));
            }
            organizations.push(org);
        }
        Ok(Self {
            personal_pool,
            organizations,
        })
    }

    pub fn is_empty(&self) -> bool {
        self.organizations.is_empty()
    }

    pub fn by_config_id(&self, id: &str) -> Option<&ConfiguredOrganization> {
        self.organizations.iter().find(|o| o.id == id)
    }

    pub fn by_organization_id(&self, organization_id: &str) -> Option<&ConfiguredOrganization> {
        self.organizations
            .iter()
            .find(|o| !o.organization_id.is_empty() && o.organization_id == organization_id)
    }
}

#[path = "config_parse.rs"]
mod parse;
use parse::{optional_id, organization};

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
