//! What the account page shows for one configured organization. Pure, so
//! every state is unit tested; `account.rs` loads the facts.

use chrono::{DateTime, Duration, Months, Utc};
use serde::Serialize;

use super::config::{ConfiguredOrganization, SignInMethod};

/// Members are asked to verify again this long before their membership
/// would lapse.
pub const REVERIFY_NOTICE_DAYS: i64 = 30;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdmissionState {
    /// The organization is disabled: show `entryPage.notOpenText`.
    NotOpen,
    /// The caller can join by email code or a join request.
    Join,
    /// The caller's join request awaits an admin.
    Pending,
    /// An admin rejected the caller's request; another is possible once the
    /// request is purged after the retention period.
    Rejected,
    Member,
    /// A member whose verification is due soon.
    Reverify,
    /// The caller's membership ended; joining again is possible.
    Lapsed,
    /// Open, but no path is available to the caller (for example, join
    /// requests are off and email codes are not accepted).
    Unavailable,
}

/// The caller's rows for one organization.
#[derive(Clone, Debug, Default)]
pub struct CallerFacts {
    pub is_member: bool,
    /// `domain_claim` or `join_request`.
    pub source: Option<String>,
    pub verified_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub lapsed_at: Option<DateTime<Utc>>,
    pub lapse_reason: Option<String>,
    /// Status of the caller's open join request (`pending` or `rejected`).
    pub request_status: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinOptions {
    pub email_code: bool,
    pub join_request: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CallerState {
    pub state: AdmissionState,
    pub options: JoinOptions,
    /// When a domain-claim membership lapses without another verification.
    pub reverify_by: Option<DateTime<Utc>>,
}

/// The join paths that would succeed for the caller: a removed member
/// rejoins only by request, and a rejected request blocks another.
pub fn join_options(org: &ConfiguredOrganization, facts: &CallerFacts) -> JoinOptions {
    let open = org.state.admits();
    let removed = facts.lapse_reason.as_deref() == Some("removed");
    JoinOptions {
        email_code: open
            && !removed
            && org.auto_joins(SignInMethod::EmailCode)
            && !org.claim.domains.is_empty(),
        join_request: open && org.join_requests.is_some() && facts.request_status.is_none(),
    }
}

/// Whether the caller's membership is past its verification or approval
/// and must be expired before it is shown.
pub fn is_due(org: &ConfiguredOrganization, facts: &CallerFacts, now: DateTime<Utc>) -> bool {
    facts.is_member
        && facts.lapsed_at.is_none()
        && (facts.expires_at.is_some_and(|at| at <= now)
            || reverify_by(org, facts).is_some_and(|at| at <= now))
}

pub fn reverify_by(org: &ConfiguredOrganization, facts: &CallerFacts) -> Option<DateTime<Utc>> {
    if facts.source.as_deref() != Some("domain_claim") {
        return None;
    }
    let months = org.reverify_interval_months?;
    facts.verified_at?.checked_add_months(Months::new(months))
}

pub fn caller_state(
    org: &ConfiguredOrganization,
    facts: &CallerFacts,
    now: DateTime<Utc>,
) -> CallerState {
    let options = join_options(org, facts);
    let reverify_by = reverify_by(org, facts).filter(|_| facts.lapsed_at.is_none());
    let state = if facts.is_member {
        match reverify_by {
            Some(due) if due - Duration::days(REVERIFY_NOTICE_DAYS) <= now => {
                AdmissionState::Reverify
            }
            _ => AdmissionState::Member,
        }
    } else if !org.state.admits() {
        AdmissionState::NotOpen
    } else if facts.request_status.as_deref() == Some("pending") {
        AdmissionState::Pending
    } else if facts.request_status.as_deref() == Some("rejected") {
        AdmissionState::Rejected
    } else if facts.lapsed_at.is_some() {
        AdmissionState::Lapsed
    } else if options.email_code || options.join_request {
        AdmissionState::Join
    } else {
        AdmissionState::Unavailable
    };
    CallerState {
        state,
        options,
        reverify_by,
    }
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;
