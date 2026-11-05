//! Validation of the admission file's organizations: bounds, formats, and
//! admins read by reference. Errors name the field, never a secret.

use serde_json::Value;

use super::*;

pub(super) fn organization(
    org: OrganizationFile,
    at: &str,
    env: &impl Fn(&str) -> Option<String>,
) -> Result<ConfiguredOrganization, String> {
    if !valid_id(&org.id) {
        return Err(format!(
            "{at}.id must be 1-63 lowercase letters, digits or hyphens"
        ));
    }
    let display_name = text(&org.display_name, 120, &format!("{at}.displayName"))?;
    let pool = optional_id(org.pool, &format!("{at}.pool"))?;
    let target_pool = optional_id(org.target_pool, &format!("{at}.targetPool"))?;
    let admission = org.admission;
    if admission.claimed_domains.len() > MAX_DOMAINS {
        return Err(format!(
            "{at}.admission.claimedDomains: at most {MAX_DOMAINS}"
        ));
    }
    for domain in &admission.claimed_domains {
        if !valid_domain(domain) {
            return Err(format!(
                "{at}.admission.claimedDomains: `{domain}` is not a lowercase domain name"
            ));
        }
    }
    let mut methods = admission.auto_join_methods.clone();
    methods.sort_by_key(|m| m.as_str());
    methods.dedup();
    if methods.len() != admission.auto_join_methods.len() {
        return Err(format!("{at}.admission.autoJoinMethods: repeated method"));
    }
    if matches!(admission.reverify_interval_months, Some(m) if !(1..=120).contains(&m)) {
        return Err(format!(
            "{at}.admission.reverifyIntervalMonths must be 1-120 or null"
        ));
    }
    let (join_requests, request_retention_days) = join_requests(
        admission.join_requests,
        &format!("{at}.admission.joinRequests"),
    )?;
    let admins = match org.admins_env {
        Some(name) => admins(&name, env, &format!("{at}.adminsEnv"), org.state)?,
        None => ConfiguredAdmins::default(),
    };
    let entry = org.entry_page;
    let entry_page = EntryPage {
        title: text(&entry.title, 120, &format!("{at}.entryPage.title"))?,
        summary: text(&entry.summary, 600, &format!("{at}.entryPage.summary"))?,
        join_label: text(&entry.join_label, 80, &format!("{at}.entryPage.joinLabel"))?,
        not_open_text: text(
            &entry.not_open_text,
            240,
            &format!("{at}.entryPage.notOpenText"),
        )?,
    };
    Ok(ConfiguredOrganization {
        id: org.id,
        organization_id: String::new(),
        display_name,
        state: org.state,
        pool,
        target_pool,
        claim: DomainClaim {
            domains: admission.claimed_domains,
            domain_match: admission.domain_match,
            require_google_hosted_domain: admission.require_google_hosted_domain,
        },
        auto_join_methods: admission.auto_join_methods,
        reverify_interval_months: admission.reverify_interval_months,
        google_sign_in_reverifies: admission.google_sign_in_reverifies,
        strip_subaddress: admission.strip_subaddress.unwrap_or(true),
        join_requests,
        request_retention_days,
        membership: org.membership,
        admins,
        entry_page,
    })
}

fn join_requests(
    file: JoinRequestsFile,
    at: &str,
) -> Result<(Option<JoinRequestPolicy>, u32), String> {
    let Approval::OrganizationAdmins = file.approval;
    let approved_membership_expiry = match &file.approved_membership_expiry {
        Value::Null => ApprovedMembershipExpiry::SetByApprover,
        Value::String(s) if s == "set_by_approver" => ApprovedMembershipExpiry::SetByApprover,
        Value::Number(n) => match n.as_u64() {
            Some(days @ 1..=3650) => ApprovedMembershipExpiry::Days(days as u32),
            _ => return Err(format!("{at}.approvedMembershipExpiry days must be 1-3650")),
        },
        _ => {
            return Err(format!(
            "{at}.approvedMembershipExpiry must be null, \"set_by_approver\" or a number of days"
        ))
        }
    };
    if file.fields.len() > MAX_FIELDS {
        return Err(format!("{at}.fields: at most {MAX_FIELDS}"));
    }
    let mut fields: Vec<JoinRequestField> = Vec::with_capacity(file.fields.len());
    for (index, field) in file.fields.into_iter().enumerate() {
        let field_at = format!("{at}.fields[{index}]");
        if !valid_field_key(&field.key) {
            return Err(format!(
                "{field_at}.key must start with a lowercase letter and use letters, digits or underscores (at most 40)"
            ));
        }
        if fields.iter().any(|f| f.key == field.key) {
            return Err(format!("{field_at}.key `{}` is used twice", field.key));
        }
        let max_length = field.max_length.unwrap_or(DEFAULT_FIELD_MAX_LENGTH);
        if !(1..=MAX_FIELD_LENGTH).contains(&max_length) {
            return Err(format!(
                "{field_at}.maxLength must be 1-{MAX_FIELD_LENGTH} or null"
            ));
        }
        fields.push(JoinRequestField {
            label: text(&field.label, 80, &format!("{field_at}.label"))?,
            key: field.key,
            required: field.required.unwrap_or(false),
            max_length,
        });
    }
    let retention_days = match (file.retention_days, file.enabled) {
        (Some(days @ 1..=365), _) => days,
        (None, false) => DEFAULT_RETENTION_DAYS,
        _ => {
            return Err(format!(
                "{at}.retentionDays must be 1-365 (null only while join requests are disabled)"
            ))
        }
    };
    let policy = file.enabled.then_some(JoinRequestPolicy {
        fields,
        approved_membership_expiry,
    });
    Ok((policy, retention_days))
}

fn admins(
    name: &str,
    env: &impl Fn(&str) -> Option<String>,
    at: &str,
    state: OrganizationState,
) -> Result<ConfiguredAdmins, String> {
    if !valid_env_name(name) {
        return Err(format!(
            "{at} must be an uppercase environment variable name"
        ));
    }
    let Some(raw) = env(name).filter(|v| !v.trim().is_empty()) else {
        // A disabled organization may name admins it does not provision yet.
        return if state.admits() {
            Err(format!("{at}: environment variable {name} is not set"))
        } else {
            Ok(ConfiguredAdmins::default())
        };
    };
    // The value is never echoed: it lists people.
    let invalid = || format!("{at}: {name} must be a JSON array of account ids or emails");
    let entries: Vec<String> = serde_json::from_str(&raw).map_err(|_| invalid())?;
    if entries.len() > MAX_ADMINS {
        return Err(format!("{at}: {name} lists more than {MAX_ADMINS} admins"));
    }
    let mut admins = ConfiguredAdmins::default();
    for entry in entries {
        let entry = entry.trim();
        if entry.starts_with("acct_")
            && !entry.contains('@')
            && entry.len() <= 128
            && !entry.contains(char::is_whitespace)
        {
            admins.account_ids.push(entry.to_string());
        } else {
            let email = crate::auth::password::validate_email(entry).map_err(|_| invalid())?;
            admins.emails.push(email);
        }
    }
    Ok(admins)
}

pub(super) fn optional_id(value: Option<String>, at: &str) -> Result<Option<String>, String> {
    match value {
        Some(id) if !valid_id(&id) => Err(format!(
            "{at} must be 1-63 lowercase letters, digits or hyphens, or null"
        )),
        other => Ok(other),
    }
}

fn text(value: &str, max_chars: usize, at: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed.chars().count() > max_chars
        || trimmed.chars().any(char::is_control)
    {
        return Err(format!(
            "{at} must be 1-{max_chars} characters without control characters"
        ));
    }
    Ok(trimmed.to_string())
}

fn valid_id(value: &str) -> bool {
    (1..=63).contains(&value.len())
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn valid_field_key(value: &str) -> bool {
    (1..=40).contains(&value.len())
        && value.as_bytes()[0].is_ascii_lowercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn valid_env_name(value: &str) -> bool {
    (3..=80).contains(&value.len())
        && value.as_bytes()[0].is_ascii_uppercase()
        && value
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

fn valid_domain(value: &str) -> bool {
    value.len() <= 253
        && value.contains('.')
        && value.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

/// Second-level labels that registries commonly sell under, so a two-label
/// domain starting with one (such as `ac.` or `co.` followed by a country
/// code) is likely a public suffix.
const REGISTRY_LABELS: [&str; 10] = [
    "ac", "co", "com", "edu", "gov", "net", "org", "sch", "ltd", "mil",
];

/// Warnings for valid but risky values: a `subdomains` claim on what looks
/// like a public suffix would admit every institution under it.
pub(super) fn warnings(org: &ConfiguredOrganization) -> Vec<String> {
    if org.claim.domain_match != DomainMatch::Subdomains {
        return Vec::new();
    }
    org.claim
        .domains
        .iter()
        .filter(|domain| {
            let labels: Vec<&str> = domain.split('.').collect();
            labels.len() == 2 && REGISTRY_LABELS.contains(&labels[0])
        })
        .map(|domain| {
            format!(
                "{FILE_ENV}: organization `{}` claims `{domain}` with subdomains; it looks like a public suffix",
                org.id
            )
        })
        .collect()
}
