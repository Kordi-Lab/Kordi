//! Per-route budgets, modelled on Telegram's flood limits: every method has
//! its own budget, authenticated calls count per account, and a refusal names
//! the exact wait (see [`super::response`]). Cheap reads get generous budgets
//! or none; sensitive writes and the sign-in surface get tight ones.
//!
//! * Authenticated routes count per account, so people who share an address
//!   (an office, a household, or a proxy the server does not trust) never
//!   spend each other's budget.
//! * Unauthenticated routes count per client address *and*, where the request
//!   names one, per target identifier such as an email. Address budgets are
//!   multiplied for [`TrustedNetworks`].
//!
//! Operators can replace any named budget with [`BUDGETS_ENV`]:
//! `KORDI_RATE_LIMIT_BUDGETS="login-address=60/1m,profile-lookup=off"`.
//! A value is `<count>/<window>` (window in seconds, or with an `s`, `m`, `h`
//! or `d` suffix), or `off` to stop counting that budget.

use std::collections::HashMap;

use super::buckets::Namespace;
use super::*;

pub const BUDGETS_ENV: &str = "KORDI_RATE_LIMIT_BUDGETS";

const fn budget(action: &'static str, limit: u32, window_secs: u64) -> AccountActionLimit {
    AccountActionLimit {
        action,
        limit,
        window: Duration::from_secs(window_secs),
    }
}

const MINUTE: u64 = 60;
const HOUR: u64 = 60 * MINUTE;

// ---- Unauthenticated routes, per client address ----

/// Password sign-in (`/auth/login`, `/auth/web/login`). Guessing is bounded
/// per email by [`LOGIN_EMAIL_LIMIT`] and the failure lockout.
pub const LOGIN_ADDRESS_LIMIT: AccountActionLimit = budget("login-address", 30, MINUTE);
/// Account creation (`/auth/signup`, `/auth/web/signup`).
pub const SIGNUP_ADDRESS_LIMIT: AccountActionLimit = budget("signup-address", 20, 10 * MINUTE);
/// Sign-up email codes. The code store also limits sends per email.
pub const SIGNUP_CODE_ADDRESS_LIMIT: AccountActionLimit =
    budget("signup-code-address", 20, 10 * MINUTE);
/// Browser sign-in code exchanges and malformed token requests. Refreshes use
/// their own per-app budget.
pub const APP_TOKEN_ADDRESS_LIMIT: AccountActionLimit = budget("app-token-address", 60, MINUTE);
/// Browser sign-in approvals, checked before the web session is read.
pub const APP_AUTHORIZE_ADDRESS_LIMIT: AccountActionLimit =
    budget("app-authorize-address", 60, MINUTE);
/// Public invitation previews and landing pages (`/i/:token`, `/g/:token`,
/// and the resolve endpoints). Tokens are unguessable; this bounds scraping.
pub const INVITATION_VIEW_ADDRESS_LIMIT: AccountActionLimit =
    budget("invitation-view-address", 120, MINUTE);
/// Group invitation claims from the landing page form.
pub const INVITATION_PAGE_CLAIM_ADDRESS_LIMIT: AccountActionLimit =
    budget("invitation-page-claim-address", 30, MINUTE);
/// Avatar renders that miss the render cache. Cached renders are never
/// counted.
pub const AVATAR_RENDER_ADDRESS_LIMIT: AccountActionLimit =
    budget("avatar-render-address", 240, MINUTE);

// ---- Unauthenticated routes, per target identifier ----

/// Sign-in attempts naming one email, from every address together. Failed
/// attempts also feed the email lockout.
pub const LOGIN_EMAIL_LIMIT: AccountActionLimit = budget("login-email", 30, 15 * MINUTE);
/// Sign-up attempts naming one email.
pub const SIGNUP_EMAIL_LIMIT: AccountActionLimit = budget("signup-email", 10, 10 * MINUTE);
/// Sign-up code requests naming one email.
pub const SIGNUP_CODE_EMAIL_LIMIT: AccountActionLimit = budget("signup-code-email", 10, HOUR);

// ---- Authenticated routes, per account ----

/// Profile lookups by Kordi ID: a read, so the budget is generous.
pub const PROFILE_LOOKUP_LIMIT: AccountActionLimit = budget("profile-lookup", 600, MINUTE);
/// Group invitation links: creating or reusing one, and reading the active
/// links for a group. Reusing a live link is cheap, so this allows ordinary
/// sharing with room to spare.
pub const GROUP_INVITATION_CREATE_LIMIT: AccountActionLimit =
    budget("group-invitation-link", 60, MINUTE);
/// Resetting a group's invitation link (`reset: true`), which revokes the
/// old link. Charged in addition to [`GROUP_INVITATION_CREATE_LIMIT`].
pub const GROUP_INVITATION_RESET_LIMIT: AccountActionLimit =
    budget("group-invitation-reset", 10, HOUR);
/// New app invitation links.
pub const APP_INVITATION_CREATE_LIMIT: AccountActionLimit =
    budget("app-invitation-create", 30, HOUR);
/// Group invitation acceptances and claims, including pending ones.
pub const INVITATION_ACCEPT_LIMIT: AccountActionLimit = budget("invitation-accept", 60, HOUR);
/// Memory import extractions: each sends one chosen file to the hosted model.
pub const MEMORY_IMPORT_EXTRACT_LIMIT: AccountActionLimit =
    budget("memory-import-extract", 60, HOUR);
/// Leaving a group. Each leave posts a line in the group, so this bounds
/// leave-and-rejoin churn while leaving ample room for ordinary use.
pub const GROUP_LEAVE_LIMIT: AccountActionLimit = budget("group-leave", 30, HOUR);

/// The budgets unauthenticated routes count per address or per identifier.
pub const UNAUTHENTICATED_BUDGETS: &[AccountActionLimit] = &[
    LOGIN_ADDRESS_LIMIT,
    SIGNUP_ADDRESS_LIMIT,
    SIGNUP_CODE_ADDRESS_LIMIT,
    APP_TOKEN_ADDRESS_LIMIT,
    APP_AUTHORIZE_ADDRESS_LIMIT,
    INVITATION_VIEW_ADDRESS_LIMIT,
    INVITATION_PAGE_CLAIM_ADDRESS_LIMIT,
    AVATAR_RENDER_ADDRESS_LIMIT,
    LOGIN_EMAIL_LIMIT,
    SIGNUP_EMAIL_LIMIT,
    SIGNUP_CODE_EMAIL_LIMIT,
];

/// Every budget defined in this module and in [`super::account_actions`].
/// Overrides naming anything else are reported at startup.
pub const NAMED_BUDGETS: &[AccountActionLimit] = &[
    LOGIN_ADDRESS_LIMIT,
    SIGNUP_ADDRESS_LIMIT,
    SIGNUP_CODE_ADDRESS_LIMIT,
    APP_TOKEN_ADDRESS_LIMIT,
    APP_AUTHORIZE_ADDRESS_LIMIT,
    INVITATION_VIEW_ADDRESS_LIMIT,
    INVITATION_PAGE_CLAIM_ADDRESS_LIMIT,
    AVATAR_RENDER_ADDRESS_LIMIT,
    LOGIN_EMAIL_LIMIT,
    SIGNUP_EMAIL_LIMIT,
    SIGNUP_CODE_EMAIL_LIMIT,
    PROFILE_LOOKUP_LIMIT,
    GROUP_INVITATION_CREATE_LIMIT,
    GROUP_INVITATION_RESET_LIMIT,
    APP_INVITATION_CREATE_LIMIT,
    INVITATION_ACCEPT_LIMIT,
    MEMORY_IMPORT_EXTRACT_LIMIT,
    GROUP_LEAVE_LIMIT,
    MESSAGE_SEND_LIMIT,
    DOCUMENT_PUBLIC_READ_LIMIT,
    DOCUMENT_PUBLIC_WRITE_LIMIT,
    DOCUMENT_COLLAB_TICKET_LIMIT,
    CONTACT_ADD_LIMIT,
    REPORT_SUBMIT_LIMIT,
    BLOCK_CHANGE_LIMIT,
    EMAIL_VERIFICATION_LIMIT,
    ACCOUNT_SECURITY_CHANGE_LIMIT,
    ACCOUNT_SECURITY_PROOF_LIMIT,
    AGENT_RUN_CLAIM_LIMIT,
];

/// Operator replacements for named budgets. `None` switches a budget off.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BudgetOverrides {
    entries: HashMap<String, Option<(u32, Duration)>>,
}

impl BudgetOverrides {
    /// Parses `name=<count>/<window>` or `name=off` entries separated by
    /// commas. Fails on the first malformed entry so a typo stops startup
    /// instead of silently keeping the default.
    pub fn parse(value: &str) -> Result<Self, String> {
        let mut entries = HashMap::new();
        for entry in value.split(',').map(str::trim).filter(|e| !e.is_empty()) {
            let invalid = || {
                format!(
                    "{BUDGETS_ENV}: invalid entry `{entry}`; use name=<count>/<window> or name=off"
                )
            };
            let (name, spec) = entry.split_once('=').ok_or_else(invalid)?;
            let (name, spec) = (name.trim(), spec.trim());
            if name.is_empty() {
                return Err(invalid());
            }
            let parsed = if spec.eq_ignore_ascii_case("off") {
                None
            } else {
                let (count, window) = spec.split_once('/').ok_or_else(invalid)?;
                let count = count.trim().parse::<u32>().ok().filter(|c| *c > 0);
                let window = parse_window(window.trim());
                Some((count.ok_or_else(invalid)?, window.ok_or_else(invalid)?))
            };
            entries.insert(name.to_string(), parsed);
        }
        Ok(Self { entries })
    }

    /// Sets every [`UNAUTHENTICATED_BUDGETS`] entry to `limit` per `window`,
    /// for test harnesses that send many requests from one address.
    pub fn unauthenticated(limit: u32, window: Duration) -> Self {
        Self {
            entries: UNAUTHENTICATED_BUDGETS
                .iter()
                .map(|budget| (budget.action.to_string(), Some((limit, window))))
                .collect(),
        }
    }

    /// Reads [`BUDGETS_ENV`]; unset means no overrides.
    pub fn from_env() -> Result<Self, String> {
        let overrides = match std::env::var(BUDGETS_ENV) {
            Ok(value) => Self::parse(&value)?,
            Err(_) => Self::default(),
        };
        for name in overrides.entries.keys() {
            if !NAMED_BUDGETS.iter().any(|budget| budget.action == name) {
                eprintln!(
                    "[rate_limit] {BUDGETS_ENV} names `{name}`, which is not a shared budget; it applies only if a route defines it"
                );
            }
        }
        Ok(overrides)
    }

    /// The budget to enforce for `limit`, or `None` when it is switched off.
    pub fn apply(&self, limit: AccountActionLimit) -> Option<AccountActionLimit> {
        match self.entries.get(limit.action) {
            None => Some(limit),
            Some(None) => None,
            Some(Some((count, window))) => Some(AccountActionLimit {
                limit: *count,
                window: *window,
                ..limit
            }),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

fn parse_window(value: &str) -> Option<Duration> {
    let (digits, unit) = match value.char_indices().find(|(_, c)| !c.is_ascii_digit()) {
        Some((index, _)) => value.split_at(index),
        None => (value, "s"),
    };
    let amount = digits.parse::<u64>().ok().filter(|a| *a > 0)?;
    let seconds = match unit {
        "s" => amount,
        "m" => amount.checked_mul(MINUTE)?,
        "h" => amount.checked_mul(HOUR)?,
        "d" => amount.checked_mul(24 * HOUR)?,
        _ => return None,
    };
    Some(Duration::from_secs(seconds))
}

impl CloudRateLimiter {
    /// Replaces named budgets, normally with [`BudgetOverrides::from_env`].
    pub fn with_budget_overrides(mut self, overrides: BudgetOverrides) -> Self {
        self.overrides = overrides;
        self
    }

    /// Records one hit against an unauthenticated route's per-address
    /// budget. Unknown clients share `0.0.0.0`, so hiding the address does not
    /// escape the limit; trusted networks get the budget multiplied.
    pub async fn observe_address_limit(
        &self,
        limit: AccountActionLimit,
        client: Option<IpAddr>,
    ) -> RateLimitDecision {
        self.observe_qualified_address_limit(limit, client, None)
            .await
    }

    /// [`Self::observe_address_limit`] with the address split further by
    /// `qualifier`, such as an app's client ID, so one app's traffic does not
    /// spend another's budget at the same address.
    pub async fn observe_qualified_address_limit(
        &self,
        limit: AccountActionLimit,
        client: Option<IpAddr>,
        qualifier: Option<&str>,
    ) -> RateLimitDecision {
        let Some(limit) = self.overrides.apply(limit) else {
            return RateLimitDecision::Allowed;
        };
        let limit = self.trusted.scale_action(limit, client);
        let address = rate_limit_client_key(client);
        let subject = match qualifier {
            Some(qualifier) => format!("{qualifier}:{address}"),
            None => address.to_string(),
        };
        self.observe_bucket_exact(Namespace::Address, limit, &subject)
            .await
    }

    /// Records one hit against a per-identifier budget, such as attempts that
    /// name one email. `identifier` should already be normalized.
    pub async fn observe_identifier_limit(
        &self,
        limit: AccountActionLimit,
        identifier: &str,
    ) -> RateLimitDecision {
        self.observe_bucket(Namespace::Identifier, limit, identifier)
            .await
    }

    /// Records one hit against the address budget, then, when that allows,
    /// the identifier budget. The first refusal wins.
    pub async fn observe_address_and_identifier(
        &self,
        address_limit: AccountActionLimit,
        client: Option<IpAddr>,
        identifier_limit: AccountActionLimit,
        identifier: &str,
    ) -> RateLimitDecision {
        match self.observe_address_limit(address_limit, client).await {
            RateLimitDecision::Allowed => {
                self.observe_identifier_limit(identifier_limit, identifier)
                    .await
            }
            limited => limited,
        }
    }
}
