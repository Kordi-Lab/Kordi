//! What a runtime reload of the organizations file may change.
//!
//! Sign-in critical keys decide who gets in: an organization's state, claimed
//! domains and how they match, the Google hosted-domain rule, auto-join
//! methods, re-verification, subaddress handling, join requests and how long
//! their approvals last, membership rules and admins. A reload may narrow
//! them; a value that would widen keeps its current value until a restart,
//! and the kept change is reported. Adding an organization widens; removing
//! one narrows. Ordinary keys (display name, pools, entry page, join-request
//! form fields, request retention) always take the new value.

use std::collections::BTreeSet;

use super::config::{
    ApprovedMembershipExpiry, ConfiguredAdmins, ConfiguredOrganization, DomainMatch,
    MembershipPolicy, OrganizationAdmission, OrganizationState, SignInMethod,
};

/// One sign-in critical key a reload changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CriticalChange {
    /// `organizations[<id>].<key>`.
    pub key: String,
    /// Whether the change applied (narrowing) or was kept back (widening).
    pub applied: bool,
    /// A short diff without secrets (admin entries are counted, not named).
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Merged {
    pub admission: OrganizationAdmission,
    pub changes: Vec<CriticalChange>,
}

impl Merged {
    /// Changes that need a restart to apply.
    pub fn kept(&self) -> impl Iterator<Item = &CriticalChange> {
        self.changes.iter().filter(|change| !change.applied)
    }
}

/// Merges a freshly parsed file into the running configuration.
pub fn merge(current: &OrganizationAdmission, next: OrganizationAdmission) -> Merged {
    let mut changes = Vec::new();
    let mut organizations = Vec::with_capacity(current.organizations.len());
    for old in &current.organizations {
        let Some(new) = next.organizations.iter().find(|o| o.id == old.id) else {
            changes.push(CriticalChange {
                key: format!("organizations[{}]", old.id),
                applied: true,
                detail: "removed".into(),
            });
            continue;
        };
        organizations.push(merge_organization(old, new.clone(), &mut changes));
    }
    for new in &next.organizations {
        if current.by_config_id(&new.id).is_none() {
            changes.push(CriticalChange {
                key: format!("organizations[{}]", new.id),
                applied: false,
                detail: "added".into(),
            });
        }
    }
    Merged {
        admission: OrganizationAdmission {
            personal_pool: next.personal_pool,
            organizations,
            orphaned: current.orphaned.clone(),
            warnings: next.warnings,
        },
        changes,
    }
}

struct Keys<'a> {
    id: &'a str,
    changes: &'a mut Vec<CriticalChange>,
}

impl Keys<'_> {
    /// Takes `new` when it is no wider than `old`; otherwise keeps `old`.
    fn pick<T: PartialEq + Clone>(
        &mut self,
        key: &str,
        old: &T,
        new: T,
        narrower_or_equal: bool,
        describe: impl FnOnce(&T, &T) -> String,
    ) -> T {
        if *old == new {
            return new;
        }
        self.changes.push(CriticalChange {
            key: format!("organizations[{}].{key}", self.id),
            applied: narrower_or_equal,
            detail: describe(old, &new),
        });
        if narrower_or_equal {
            new
        } else {
            old.clone()
        }
    }
}

fn merge_organization(
    old: &ConfiguredOrganization,
    mut new: ConfiguredOrganization,
    changes: &mut Vec<CriticalChange>,
) -> ConfiguredOrganization {
    let mut keys = Keys {
        id: &old.id,
        changes,
    };
    new.organization_id = old.organization_id.clone();
    new.state = keys.pick(
        "state",
        &old.state,
        new.state,
        state_rank(new.state) <= state_rank(old.state),
        |a, b| format!("{a:?} -> {b:?}"),
    );
    let domains_narrower = subset(&new.claim.domains, &old.claim.domains);
    new.claim.domains = keys.pick(
        "claimedDomains",
        &old.claim.domains,
        new.claim.domains,
        domains_narrower,
        |a, b| set_diff(a, b),
    );
    new.claim.domain_match = keys.pick(
        "domainMatch",
        &old.claim.domain_match,
        new.claim.domain_match,
        new.claim.domain_match == DomainMatch::Exact
            || old.claim.domain_match == DomainMatch::Subdomains,
        |a, b| format!("{a:?} -> {b:?}"),
    );
    new.claim.require_google_hosted_domain = keys.pick(
        "requireGoogleHostedDomain",
        &old.claim.require_google_hosted_domain,
        new.claim.require_google_hosted_domain,
        new.claim.require_google_hosted_domain || !old.claim.require_google_hosted_domain,
        flag,
    );
    let new_methods = new.auto_join_methods.clone();
    new.auto_join_methods = keys.pick(
        "autoJoinMethods",
        &old.auto_join_methods,
        new_methods.clone(),
        subset(&new_methods, &old.auto_join_methods),
        |a, b| set_diff(&method_names(a), &method_names(b)),
    );
    new.reverify_interval_months = keys.pick(
        "reverifyIntervalMonths",
        &old.reverify_interval_months,
        new.reverify_interval_months,
        bound_narrower(new.reverify_interval_months, old.reverify_interval_months),
        |a, b| format!("{} -> {}", bound(a), bound(b)),
    );
    new.google_sign_in_reverifies = keys.pick(
        "googleSignInReverifies",
        &old.google_sign_in_reverifies,
        new.google_sign_in_reverifies,
        !new.google_sign_in_reverifies || old.google_sign_in_reverifies,
        flag,
    );
    new.strip_subaddress = keys.pick(
        "stripSubaddress",
        &old.strip_subaddress,
        new.strip_subaddress,
        new.strip_subaddress || !old.strip_subaddress,
        flag,
    );
    new.join_requests = match (&old.join_requests, new.join_requests) {
        (old_policy, None) => {
            let _ = keys.pick(
                "joinRequests.enabled",
                &old_policy.is_some(),
                false,
                true,
                flag,
            );
            None
        }
        (None, Some(_)) => {
            let _ = keys.pick("joinRequests.enabled", &false, true, false, flag);
            None
        }
        (Some(old_policy), Some(mut policy)) => {
            policy.approved_membership_expiry = keys.pick(
                "joinRequests.approvedMembershipExpiry",
                &old_policy.approved_membership_expiry,
                policy.approved_membership_expiry,
                expiry_narrower(
                    policy.approved_membership_expiry,
                    old_policy.approved_membership_expiry,
                ),
                |a, b| format!("{a:?} -> {b:?}"),
            );
            Some(policy)
        }
    };
    new.membership = merge_membership(&mut keys, &old.membership, new.membership);
    new.admins = merge_admins(&mut keys, &old.admins, new.admins);
    new
}

fn merge_membership(
    keys: &mut Keys<'_>,
    old: &MembershipPolicy,
    new: MembershipPolicy,
) -> MembershipPolicy {
    MembershipPolicy {
        require_member_owner: keys.pick(
            "membership.requireMemberOwner",
            &old.require_member_owner,
            new.require_member_owner,
            new.require_member_owner || !old.require_member_owner,
            flag,
        ),
        outsiders_allowed: keys.pick(
            "membership.outsidersAllowed",
            &old.outsiders_allowed,
            new.outsiders_allowed,
            !new.outsiders_allowed || old.outsiders_allowed,
            flag,
        ),
        // `null` falls back to a server default, so only a smaller number is
        // known to be narrower.
        work_end_bound_seconds: keys.pick(
            "membership.workEndBoundSeconds",
            &old.work_end_bound_seconds,
            new.work_end_bound_seconds,
            matches!(
                (new.work_end_bound_seconds, old.work_end_bound_seconds),
                (Some(a), Some(b)) if a <= b
            ),
            |a, b| format!("{} -> {}", bound(a), bound(b)),
        ),
    }
}

fn merge_admins(
    keys: &mut Keys<'_>,
    old: &ConfiguredAdmins,
    new: ConfiguredAdmins,
) -> ConfiguredAdmins {
    let count = |a: &Vec<String>, b: &Vec<String>| {
        let (old, new): (BTreeSet<_>, BTreeSet<_>) = (a.iter().collect(), b.iter().collect());
        format!(
            "{} added, {} removed",
            new.difference(&old).count(),
            old.difference(&new).count()
        )
    };
    ConfiguredAdmins {
        account_ids: keys.pick(
            "admins.accountIds",
            &old.account_ids,
            new.account_ids.clone(),
            subset(&new.account_ids, &old.account_ids),
            count,
        ),
        emails: keys.pick(
            "admins.emails",
            &old.emails,
            new.emails.clone(),
            subset(&new.emails, &old.emails),
            count,
        ),
    }
}

fn state_rank(state: OrganizationState) -> u8 {
    // Interim and active admit alike; they differ in pool binding only.
    u8::from(state.admits())
}

fn subset<T: PartialEq>(new: &[T], old: &[T]) -> bool {
    new.iter().all(|value| old.contains(value))
}

/// `None` is unbounded.
fn bound_narrower<T: PartialOrd>(new: Option<T>, old: Option<T>) -> bool {
    match (new, old) {
        (_, None) => true,
        (None, Some(_)) => false,
        (Some(a), Some(b)) => a <= b,
    }
}

fn expiry_narrower(new: ApprovedMembershipExpiry, old: ApprovedMembershipExpiry) -> bool {
    match (new, old) {
        (ApprovedMembershipExpiry::Days(a), ApprovedMembershipExpiry::Days(b)) => a <= b,
        (a, b) => a == b,
    }
}

fn flag(old: &bool, new: &bool) -> String {
    format!("{old} -> {new}")
}

fn bound<T: std::fmt::Display>(value: &Option<T>) -> String {
    value
        .as_ref()
        .map_or_else(|| "null".to_string(), ToString::to_string)
}

fn set_diff(old: &[String], new: &[String]) -> String {
    let added: Vec<&String> = new.iter().filter(|v| !old.contains(v)).collect();
    let removed: Vec<&String> = old.iter().filter(|v| !new.contains(v)).collect();
    format!("added {added:?}, removed {removed:?}")
}

fn method_names(methods: &[SignInMethod]) -> Vec<String> {
    methods.iter().map(|m| m.as_str().to_string()).collect()
}

#[cfg(test)]
#[path = "narrowing_tests.rs"]
mod tests;
